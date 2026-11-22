/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- polling is inherently sequential */
import { CliError, EXIT } from "../errors";

export interface DeviceDeps {
  fetch?: typeof fetch;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Best effort: failures are ignored. */
  open?: (url: string) => Promise<unknown>;
  signal?: AbortSignal;
  /** Called once with the code to show the user. */
  onCode?: (c: { userCode: string; verificationUri: string; verificationUriComplete: string }) => void;
}
export interface DeviceResult {
  token: string;
  workspace?: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const cancelled = () => new CliError("login cancelled", EXIT.general, "cancelled");
const network = (url: string, e: unknown) =>
  new CliError(`cannot reach ${url}: ${(e as Error).message}`, EXIT.rateLimit, "network");

const post = async (f: typeof fetch, url: string, body: unknown, signal?: AbortSignal) => {
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    throw network(url, e);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* handled by callers via status */
  }
  return { status: res.status, ok: res.ok, json };
};

/** Check the URL answers like a Plane server. */
export const checkPlaneServer = async (url: string, f: typeof fetch = fetch): Promise<void> => {
  const hint = `is ${url} a Plane server? (check ${url}/api/instances/)`;
  let res: Response;
  try {
    res = await f(`${url}/api/instances/`, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw network(url, e);
  }
  if (!res.ok) throw new CliError(`${url}/api/instances/ returned ${res.status}; ${hint}`, EXIT.general, "not_plane");
  try {
    JSON.parse(await res.text());
  } catch {
    throw new CliError(`${url}/api/instances/ did not return JSON; ${hint}`, EXIT.general, "not_plane");
  }
};

/** RFC 8628-style device flow against `<url>/auth/device/*`. */
export const deviceLogin = async (url: string, clientName: string, d: DeviceDeps = {}): Promise<DeviceResult> => {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? defaultSleep;
  const now = d.now ?? Date.now;

  const code = await post(f, `${url}/auth/device/code/`, { client_name: clientName }, d.signal);
  const c = code.json;
  if (!code.ok || typeof c.device_code !== "string" || typeof c.user_code !== "string") {
    throw new CliError(
      `could not start device login (${code.status}); is ${url} a Plane server with CLI login support?`,
      EXIT.general,
      "device_code"
    );
  }
  const verificationUri = String(c.verification_uri ?? `${url}/device`);
  const complete = String(c.verification_uri_complete ?? verificationUri);
  d.onCode?.({ userCode: c.user_code, verificationUri, verificationUriComplete: complete });
  try {
    await d.open?.(complete);
  } catch {
    /* the URL is printed anyway */
  }

  let interval = Number(c.interval) > 0 ? Number(c.interval) : 5;
  const deadline = now() + (Number(c.expires_in) > 0 ? Number(c.expires_in) : 600) * 1000;
  const expired = () =>
    new CliError("the login code expired; run `plane auth login` again", EXIT.auth, "expired_token");

  for (;;) {
    await sleep(interval * 1000, d.signal);
    if (now() >= deadline) throw expired();
    const r = await post(f, `${url}/auth/device/token/`, { device_code: c.device_code }, d.signal);
    if (r.ok && typeof r.json.token === "string") {
      return {
        token: r.json.token,
        ...(typeof r.json.workspace_slug === "string" ? { workspace: r.json.workspace_slug } : {}),
      };
    }
    switch (r.json.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        interval += 5;
        break;
      case "access_denied":
        throw new CliError("login was denied in the browser", EXIT.auth, "access_denied");
      case "expired_token":
        throw expired();
      default:
        throw new CliError(
          `unexpected response from ${url}/auth/device/token/ (${r.status})`,
          EXIT.general,
          "device_token"
        );
    }
  }
};
