/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, normalizeUrl, resolve, saveConfig } from "../src/config";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plane-cli-"));
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const profile = { url: "https://plane.example.com", token: "tok", workspace: "acme" };

describe("config", () => {
  it("honours XDG_CONFIG_HOME and starts empty", () => {
    expect(configPath()).toBe(join(dir, "plane", "config.json"));
    expect(loadConfig()).toEqual({ profiles: {} });
  });

  it("saves with mode 0600 and round-trips", () => {
    saveConfig({ current: "plane.example.com", profiles: { "plane.example.com": profile } });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(loadConfig().profiles["plane.example.com"]).toEqual(profile);
  });

  it("resolves the current profile, or one chosen by --host", () => {
    saveConfig({
      current: "a.example.com",
      profiles: {
        "a.example.com": { ...profile, url: "https://a.example.com" },
        "b.example.com": { ...profile, url: "https://b.example.com", token: "b" },
      },
    });
    expect(resolve().url).toBe("https://a.example.com");
    expect(resolve("b.example.com").token).toBe("b");
  });

  it("lets env vars override the stored profile", () => {
    saveConfig({ current: "plane.example.com", profiles: { "plane.example.com": profile } });
    const r = resolve(undefined, { PLANE_URL: "https://other.test/", PLANE_API_TOKEN: "env", PLANE_WORKSPACE: "ws" });
    expect(r).toMatchObject({ url: "https://other.test", token: "env", workspace: "ws" });
  });

  it("rejects a corrupt file and bad URLs with clear errors", () => {
    saveConfig({ profiles: {} });
    expect(() => normalizeUrl("nope")).toThrow(/not a valid URL/);
    expect(() => normalizeUrl("ftp://x.test")).toThrow(/http/);
    expect(normalizeUrl("https://plane.example.com///")).toBe("https://plane.example.com");
  });
});
