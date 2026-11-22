/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TDeviceRequest = {
  user_code: string;
  client_name: string;
  expires_at: string;
  workspaces: { id: string; name: string; slug: string }[];
};

export class DeviceService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getRequest(userCode: string): Promise<TDeviceRequest> {
    return this.get(`/api/users/device/${encodeURIComponent(userCode)}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response;
      });
  }

  async approve(userCode: string, workspace: string): Promise<void> {
    await this.post(`/api/users/device/${encodeURIComponent(userCode)}/approve/`, { workspace }).catch((error) => {
      throw error?.response;
    });
  }

  async deny(userCode: string): Promise<void> {
    await this.post(`/api/users/device/${encodeURIComponent(userCode)}/deny/`).catch((error) => {
      throw error?.response;
    });
  }
}
