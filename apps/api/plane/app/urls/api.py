# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path
from plane.app.views import (
    ApiTokenEndpoint,
    DeviceApproveEndpoint,
    DeviceDenyEndpoint,
    DeviceUserCodeEndpoint,
)

urlpatterns = [
    # API Tokens
    path(
        "users/api-tokens/",
        ApiTokenEndpoint.as_view(),
        name="api-tokens",
    ),
    path(
        "users/api-tokens/<uuid:pk>/",
        ApiTokenEndpoint.as_view(),
        name="api-tokens-details",
    ),
    ## End API Tokens
    # CLI device login
    path("users/device/<str:user_code>/", DeviceUserCodeEndpoint.as_view(), name="device-user-code"),
    path("users/device/<str:user_code>/approve/", DeviceApproveEndpoint.as_view(), name="device-approve"),
    path("users/device/<str:user_code>/deny/", DeviceDenyEndpoint.as_view(), name="device-deny"),
]
