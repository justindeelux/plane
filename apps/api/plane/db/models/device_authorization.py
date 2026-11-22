# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import hashlib
import secrets
from datetime import timedelta

# Django imports
from django.conf import settings
from django.db import models
from django.utils import timezone

from .base import BaseModel

# No 0/O/1/I so codes can be read aloud and typed without confusion
USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
DEVICE_CODE_TTL = timedelta(minutes=10)
POLL_INTERVAL_SECONDS = 5


def hash_device_code(device_code: str) -> str:
    return hashlib.sha256(device_code.encode()).hexdigest()


def generate_user_code() -> str:
    return "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(8))


def normalize_user_code(user_code: str) -> str:
    return user_code.replace("-", "").replace(" ", "").upper()


def default_expires_at():
    return timezone.now() + DEVICE_CODE_TTL


class DeviceAuthorization(BaseModel):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        DENIED = "denied", "Denied"

    device_code_hash = models.CharField(max_length=64, unique=True)
    # Stored normalized (no dash); displayed as XXXX-XXXX
    user_code = models.CharField(max_length=8, unique=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    client_name = models.CharField(max_length=255, default="unknown")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, null=True, blank=True, related_name="device_authorizations"
    )
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, null=True, blank=True, related_name="+")
    # Cleared once delivered to the CLI
    token = models.ForeignKey("db.APIToken", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    expires_at = models.DateTimeField(default=default_expires_at)
    last_polled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "Device Authorization"
        verbose_name_plural = "Device Authorizations"
        db_table = "device_authorizations"
        ordering = ("-created_at",)

    @property
    def is_expired(self) -> bool:
        return self.expires_at <= timezone.now()

    @property
    def display_user_code(self) -> str:
        return f"{self.user_code[:4]}-{self.user_code[4:]}"
