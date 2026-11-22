/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT, usageError } from "./errors";

export interface Profile {
  url: string;
  token: string;
  workspace?: string;
  project?: string;
}
export interface ConfigFile {
  /** Profile key (host) used when --host is not given: the most recently logged-in one. */
  current?: string;
  profiles: Record<string, Profile>;
}
export interface Resolved {
  profile?: string;
  url?: string;
  token?: string;
  workspace?: string;
  project?: string;
}

export const SETTABLE_KEYS = ["url", "workspace", "project"] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

export const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "plane", "config.json");

export const normalizeUrl = (raw: string): string => {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw usageError(`"${raw}" is not a valid URL (expected e.g. https://plane.example.com)`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw usageError(`URL must start with http:// or https://`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
};

export const hostOf = (url: string) => new URL(url).host;

export const loadConfig = (): ConfigFile => {
  const p = configPath();
  if (!existsSync(p)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ConfigFile>;
    return { ...(parsed.current ? { current: parsed.current } : {}), profiles: parsed.profiles ?? {} };
  } catch {
    throw new CliError(`config file ${p} is not valid JSON; fix or delete it`, EXIT.general, "config");
  }
};

export const saveConfig = (cfg: ConfigFile) => {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
};

/** Pick a stored profile: by --host (key or URL host), else `current`. */
export const findProfile = (cfg: ConfigFile, host?: string): { key: string; profile: Profile } | undefined => {
  const key = host
    ? Object.keys(cfg.profiles).find(
        (k) => k === host || cfg.profiles[k]!.url === host || hostOf(cfg.profiles[k]!.url) === host
      )
    : cfg.current;
  const profile = key ? cfg.profiles[key] : undefined;
  return key && profile ? { key, profile } : undefined;
};

/** Stored profile overlaid with PLANE_URL / PLANE_API_TOKEN / PLANE_WORKSPACE. */
export const resolve = (host?: string, env: NodeJS.ProcessEnv = process.env): Resolved => {
  const found = findProfile(loadConfig(), host);
  const r: Resolved = { ...found?.profile, ...(found ? { profile: found.key } : {}) };
  if (env.PLANE_URL) r.url = normalizeUrl(env.PLANE_URL);
  if (env.PLANE_API_TOKEN) r.token = env.PLANE_API_TOKEN;
  if (env.PLANE_WORKSPACE) r.workspace = env.PLANE_WORKSPACE;
  return r;
};

export const requireAuth = (r: Resolved): Resolved & { url: string; token: string } => {
  if (!r.url || !r.token) {
    throw new CliError(
      "not logged in; run `plane auth login` (or set PLANE_URL and PLANE_API_TOKEN)",
      EXIT.auth,
      "auth"
    );
  }
  return r as Resolved & { url: string; token: string };
};
