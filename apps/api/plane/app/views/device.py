# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import secrets

# Django imports
from django.db import IntegrityError, transaction
from django.utils import timezone

# Third party imports
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle, UserRateThrottle
from rest_framework.views import APIView

# Module imports
from plane.authentication.utils.host import base_host
from plane.db.models import APIToken, DeviceAuthorization, Workspace
from plane.db.models.device_authorization import (
    POLL_INTERVAL_SECONDS,
    generate_user_code,
    hash_device_code,
    normalize_user_code,
)
from .base import BaseAPIView


class DeviceCodeThrottle(SimpleRateThrottle):
    scope = "device_code"
    rate = "10/minute"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class DeviceTokenThrottle(SimpleRateThrottle):
    scope = "device_token"
    # The CLI polls every 5s (12/min); allow some slack for retries
    rate = "30/minute"

    def get_cache_key(self, request, view):
        device_code = request.data.get("device_code")
        if not isinstance(device_code, str) or not device_code:
            return None
        return self.cache_format % {"scope": self.scope, "ident": hash_device_code(device_code)}


class DeviceVerifyThrottle(UserRateThrottle):
    """Caps user_code guessing per signed-in user."""

    scope = "device_verify"
    rate = "20/minute"


class DeviceCodeEndpoint(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [DeviceCodeThrottle]

    def post(self, request):
        client_name = str(request.data.get("client_name") or "unknown").strip()[:200] or "unknown"
        device_code = secrets.token_urlsafe(32)  # 32 random bytes
        for _ in range(5):
            try:
                with transaction.atomic():
                    auth = DeviceAuthorization.objects.create(
                        device_code_hash=hash_device_code(device_code),
                        user_code=generate_user_code(),
                        client_name=client_name,
                    )
                break
            except IntegrityError:  # user_code collision
                continue
        else:
            return Response({"error": "server_error"}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        verification_uri = base_host(request, is_app=True).rstrip("/") + "/device"
        return Response(
            {
                "device_code": device_code,
                "user_code": auth.display_user_code,
                "verification_uri": verification_uri,
                "verification_uri_complete": f"{verification_uri}?user_code={auth.display_user_code}",
                "expires_in": int((auth.expires_at - timezone.now()).total_seconds()),
                "interval": POLL_INTERVAL_SECONDS,
            },
            status=status.HTTP_200_OK,
        )


def _error(code):
    return Response({"error": code}, status=status.HTTP_400_BAD_REQUEST)


class DeviceTokenEndpoint(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [DeviceTokenThrottle]

    def post(self, request):
        device_code = request.data.get("device_code")
        if not isinstance(device_code, str) or not device_code:
            return _error("invalid_request")

        now = timezone.now()
        # Lazy cleanup of expired rows
        DeviceAuthorization.objects.filter(expires_at__lte=now).delete()

        with transaction.atomic():
            auth = (
                DeviceAuthorization.objects.select_for_update()
                .filter(device_code_hash=hash_device_code(device_code))
                .first()
            )
            # Unknown, expired (just cleaned up) and already-delivered codes look the same
            if auth is None:
                return _error("expired_token")

            if auth.last_polled_at and (now - auth.last_polled_at).total_seconds() < POLL_INTERVAL_SECONDS:
                auth.last_polled_at = now
                auth.save(update_fields=["last_polled_at"])
                return _error("slow_down")
            auth.last_polled_at = now

            if auth.status == DeviceAuthorization.Status.PENDING:
                auth.save(update_fields=["last_polled_at"])
                return _error("authorization_pending")
            if auth.status == DeviceAuthorization.Status.DENIED:
                auth.delete()
                return _error("access_denied")

            # Approved: deliver the token exactly once
            if auth.token is None:
                return _error("expired_token")
            token, slug = auth.token.token, auth.workspace.slug if auth.workspace else None
            auth.token = None
            auth.save(update_fields=["token", "last_polled_at"])
            return Response({"token": token, "workspace_slug": slug}, status=status.HTTP_200_OK)


class DeviceVerifyBaseEndpoint(BaseAPIView):
    throttle_classes = [DeviceVerifyThrottle]

    def get_pending(self, user_code):
        auth = DeviceAuthorization.objects.filter(
            user_code=normalize_user_code(user_code), status=DeviceAuthorization.Status.PENDING
        ).first()
        if auth is None or auth.is_expired:
            return None
        return auth


class DeviceUserCodeEndpoint(DeviceVerifyBaseEndpoint):
    def get(self, request, user_code):
        auth = self.get_pending(user_code)
        if auth is None:
            return Response({"error": "Invalid or expired code"}, status=status.HTTP_404_NOT_FOUND)
        workspaces = Workspace.objects.filter(
            workspace_member__member=request.user, workspace_member__is_active=True
        ).values("id", "name", "slug")
        return Response(
            {
                "user_code": auth.display_user_code,
                "client_name": auth.client_name,
                "expires_at": auth.expires_at,
                "workspaces": list(workspaces),
            },
            status=status.HTTP_200_OK,
        )


class DeviceApproveEndpoint(DeviceVerifyBaseEndpoint):
    def post(self, request, user_code):
        slug = request.data.get("workspace")
        if not isinstance(slug, str) or not slug:
            return Response({"error": "workspace is required"}, status=status.HTTP_400_BAD_REQUEST)
        workspace = Workspace.objects.filter(
            slug=slug, workspace_member__member=request.user, workspace_member__is_active=True
        ).first()
        if workspace is None:
            return Response({"error": "Workspace not found"}, status=status.HTTP_404_NOT_FOUND)

        with transaction.atomic():
            auth = (
                DeviceAuthorization.objects.select_for_update()
                .filter(user_code=normalize_user_code(user_code), status=DeviceAuthorization.Status.PENDING)
                .first()
            )
            if auth is None or auth.is_expired:
                return Response({"error": "Invalid or expired code"}, status=status.HTTP_404_NOT_FOUND)
            auth.token = APIToken.objects.create(
                label=f"plane-cli@{auth.client_name}"[:255],
                description="Created by the Plane CLI device login",
                user=request.user,
                user_type=1 if request.user.is_bot else 0,
                workspace=workspace,
            )
            auth.user = request.user
            auth.workspace = workspace
            auth.status = DeviceAuthorization.Status.APPROVED
            auth.save(update_fields=["token", "user", "workspace", "status"])
        return Response({"status": "approved"}, status=status.HTTP_200_OK)


class DeviceDenyEndpoint(DeviceVerifyBaseEndpoint):
    def post(self, request, user_code):
        auth = self.get_pending(user_code)
        if auth is None:
            return Response({"error": "Invalid or expired code"}, status=status.HTTP_404_NOT_FOUND)
        auth.status = DeviceAuthorization.Status.DENIED
        auth.user = request.user
        auth.save(update_fields=["status", "user"])
        return Response({"status": "denied"}, status=status.HTTP_200_OK)
