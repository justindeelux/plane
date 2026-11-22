/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { getSignInRedirectUrl } from "./next-path.helper";

describe("getSignInRedirectUrl", () => {
  it("keeps the query string", () => {
    const url = getSignInRedirectUrl("/device/", "?user_code=7HBN-FW7K");
    expect(url).toBe("/?next_path=%2Fdevice%2F%3Fuser_code%3D7HBN-FW7K");
    expect(new URL(url, "http://x").searchParams.get("next_path")).toBe("/device/?user_code=7HBN-FW7K");
  });
  it("works without a query", () => expect(getSignInRedirectUrl("/a/b/")).toBe("/?next_path=%2Fa%2Fb%2F"));
  it("falls back to the root", () => expect(getSignInRedirectUrl("")).toBe("/"));
});
