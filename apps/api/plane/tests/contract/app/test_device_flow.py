# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from datetime import timedelta
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone
from rest_framework import status

from plane.app.views import device as device_views
from plane.db.models import APIToken, DeviceAuthorization, User, Workspace, WorkspaceMember
from plane.db.models.device_authorization import hash_device_code


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    cache.clear()
    yield
    cache.clear()


def other_workspace():
    owner = User.objects.create(email="o@plane.so", username="other-owner")
    return Workspace.objects.create(name="Other", slug="other", owner=owner)


def start(api_client, client_name="my-laptop"):
    resp = api_client.post(reverse("device-code"), {"client_name": client_name}, format="json")
    assert resp.status_code == status.HTTP_200_OK
    return resp.data


def poll(api_client, device_code, rewind=True):
    """Poll once; rewind last_polled_at so the interval check doesn't interfere."""
    if rewind:
        DeviceAuthorization.objects.filter(device_code_hash=hash_device_code(device_code)).update(
            last_polled_at=timezone.now() - timedelta(seconds=30)
        )
    return api_client.post(reverse("device-token"), {"device_code": device_code}, format="json")


def approve(session_client, user_code, workspace_slug="test-workspace"):
    return session_client.post(
        reverse("device-approve", kwargs={"user_code": user_code}), {"workspace": workspace_slug}, format="json"
    )


@pytest.mark.contract
@pytest.mark.django_db
class TestDeviceFlow:
    def test_code_response_shape_and_hashing(self, api_client):
        data = start(api_client)
        assert len(data["device_code"]) >= 43  # 32 bytes urlsafe-base64
        assert len(data["user_code"]) == 9 and data["user_code"][4] == "-"
        assert not set(data["user_code"].replace("-", "")) & set("01OI")
        assert data["interval"] == 5 and 0 < data["expires_in"] <= 600
        assert data["verification_uri"].endswith("/device")
        row = DeviceAuthorization.objects.get()
        assert row.device_code_hash == hash_device_code(data["device_code"])
        assert data["device_code"] not in (row.device_code_hash, row.user_code)

    def test_pending_approved_single_delivery(self, api_client, session_client, workspace):
        data = start(api_client, "my-laptop")
        first = poll(api_client, data["device_code"])
        assert first.status_code == 400 and first.data["error"] == "authorization_pending"

        resp = approve(session_client, data["user_code"])
        assert resp.status_code == 200

        ok = poll(api_client, data["device_code"])
        assert ok.status_code == 200
        assert ok.data["workspace_slug"] == "test-workspace"
        token = APIToken.objects.get(token=ok.data["token"])
        assert token.label == "plane-cli@my-laptop"
        assert token.user.email == "test@plane.so" and token.workspace == workspace

        again = poll(api_client, data["device_code"])
        assert again.status_code == 400 and again.data["error"] == "expired_token"
        assert "token" not in again.data
        assert DeviceAuthorization.objects.get().token is None

    def test_approve_accepts_dashed_lowercase_code(self, api_client, session_client, workspace):
        data = start(api_client)
        assert approve(session_client, data["user_code"].lower()).status_code == 200

    def test_expired(self, api_client):
        data = start(api_client)
        DeviceAuthorization.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        resp = poll(api_client, data["device_code"], rewind=False)
        assert resp.data["error"] == "expired_token"
        assert DeviceAuthorization.objects.count() == 0  # cleaned lazily

    def test_expired_code_cannot_be_approved(self, api_client, session_client, workspace):
        data = start(api_client)
        DeviceAuthorization.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        assert approve(session_client, data["user_code"]).status_code == 404
        assert APIToken.objects.count() == 0

    def test_deny(self, api_client, session_client, workspace):
        data = start(api_client)
        resp = session_client.post(reverse("device-deny", kwargs={"user_code": data["user_code"]}))
        assert resp.status_code == 200
        assert poll(api_client, data["device_code"]).data["error"] == "access_denied"
        assert APIToken.objects.count() == 0

    def test_slow_down(self, api_client):
        data = start(api_client)
        assert poll(api_client, data["device_code"], rewind=False).data["error"] == "authorization_pending"
        assert poll(api_client, data["device_code"], rewind=False).data["error"] == "slow_down"

    def test_wrong_user_code(self, session_client, workspace):
        resp = approve(session_client, "ZZZZ-ZZZZ")
        assert resp.status_code == 404
        resp = session_client.get(reverse("device-user-code", kwargs={"user_code": "ZZZZ-ZZZZ"}))
        assert resp.status_code == 404

    def test_unknown_device_code(self, api_client):
        assert poll(api_client, "nope", rewind=False).data["error"] == "expired_token"

    def test_missing_device_code(self, api_client):
        assert api_client.post(reverse("device-token"), {}, format="json").data["error"] == "invalid_request"

    def test_get_lists_user_workspaces(self, api_client, session_client, workspace, create_user):
        other = other_workspace()
        data = start(api_client, "box")
        resp = session_client.get(reverse("device-user-code", kwargs={"user_code": data["user_code"]}))
        assert resp.status_code == 200
        assert resp.data["client_name"] == "box"
        assert [w["slug"] for w in resp.data["workspaces"]] == ["test-workspace"]
        assert other.slug not in str(resp.data)

    def test_approve_requires_login(self, api_client):
        data = start(api_client)
        url = reverse("device-approve", kwargs={"user_code": data["user_code"]})
        resp = api_client.post(url, {"workspace": "test-workspace"}, format="json")
        assert resp.status_code in (401, 403)
        assert DeviceAuthorization.objects.get().status == "pending"

    def test_approve_requires_member_workspace(self, api_client, session_client, workspace):
        other_workspace()
        data = start(api_client)
        assert approve(session_client, data["user_code"], "other").status_code == 404
        assert approve(session_client, data["user_code"], "").status_code == 400
        # inactive membership doesn't count either
        WorkspaceMember.objects.filter(workspace=workspace).update(is_active=False)
        assert approve(session_client, data["user_code"]).status_code == 404
        assert APIToken.objects.count() == 0

    def test_cannot_approve_twice(self, api_client, session_client, workspace):
        data = start(api_client)
        assert approve(session_client, data["user_code"]).status_code == 200
        assert approve(session_client, data["user_code"]).status_code == 404
        assert APIToken.objects.count() == 1

    def test_code_endpoint_throttled_per_ip(self, api_client, monkeypatch):
        monkeypatch.setattr(device_views.DeviceCodeThrottle, "rate", "2/minute")
        assert api_client.post(reverse("device-code")).status_code == 200
        assert api_client.post(reverse("device-code")).status_code == 200
        assert api_client.post(reverse("device-code")).status_code == 429

    def test_token_endpoint_throttled_per_device_code(self, api_client, monkeypatch):
        monkeypatch.setattr(device_views.DeviceTokenThrottle, "rate", "2/minute")
        a, b = start(api_client), start(api_client)
        url = reverse("device-token")
        for _ in range(2):
            api_client.post(url, {"device_code": a["device_code"]}, format="json")
        assert api_client.post(url, {"device_code": a["device_code"]}, format="json").status_code == 429
        # a different device_code has its own budget
        assert api_client.post(url, {"device_code": b["device_code"]}, format="json").status_code == 400

    def test_verify_guessing_throttled(self, session_client, workspace, monkeypatch):
        monkeypatch.setattr(device_views.DeviceVerifyThrottle, "rate", "3/minute")
        url = reverse("device-user-code", kwargs={"user_code": "ZZZZ-ZZZZ"})
        codes = [session_client.get(url).status_code for _ in range(4)]
        assert codes == [404, 404, 404, 429]
