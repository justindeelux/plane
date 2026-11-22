/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPlaneServer, deviceLogin } from "../src/auth/device";
import { CliError } from "../src/errors";

const URL_ = "https://plane.test";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const CODE = {
  device_code: "dc",
  user_code: "ABCD-EFGH",
  verification_uri: `${URL_}/device`,
  verification_uri_complete: `${URL_}/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 5,
};
const pending = () => json({ error: "authorization_pending" }, 400);

/** Fake clock: sleep advances time and records the requested delay. */
const harness = (tokenReplies: Array<() => Response | Promise<Response>>, extra: Record<string, unknown> = {}) => {
  let t = 0;
  const sleeps: number[] = [];
  const calls: string[] = [];
  const replies = [...tokenReplies];
  const f = vi.fn(async (u: string | URL | Request, _init?: RequestInit) => {
    const url = String(u);
    calls.push(url);
    if (url.endsWith("/auth/device/code/")) return json(CODE);
    return replies.shift()!();
  });
  return {
    sleeps,
    calls,
    f,
    deps: {
      fetch: f as unknown as typeof fetch,
      sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)),
      now: () => t,
      ...extra,
    },
  };
};
const err = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e: unknown) => e
  )) as CliError;

describe("deviceLogin", () => {
  it("happy path: shows the code, opens the browser, returns token + workspace", async () => {
    const open = vi.fn(async () => undefined);
    const onCode = vi.fn();
    const h = harness([() => json({ token: "tok", workspace_slug: "acme" })], { open, onCode });
    expect(await deviceLogin(URL_, "my-host", h.deps)).toEqual({ token: "tok", workspace: "acme" });
    expect(open).toHaveBeenCalledWith(CODE.verification_uri_complete);
    expect(onCode).toHaveBeenCalledWith({
      userCode: "ABCD-EFGH",
      verificationUri: CODE.verification_uri,
      verificationUriComplete: CODE.verification_uri_complete,
    });
    const body = JSON.parse((h.f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ client_name: "my-host" });
    expect(h.sleeps).toEqual([5000]);
  });

  it("polls through pending until approved", async () => {
    const h = harness([pending, pending, () => json({ token: "tok", workspace_slug: "acme" })]);
    await deviceLogin(URL_, "h", h.deps);
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
    expect(h.calls.filter((c) => c.endsWith("/token/"))).toHaveLength(3);
  });

  it("slow_down adds 5s to the interval", async () => {
    const h = harness([
      () => json({ error: "slow_down" }, 400),
      () => json({ error: "slow_down" }, 400),
      () => json({ token: "tok", workspace_slug: null }),
    ]);
    const r = await deviceLogin(URL_, "h", h.deps);
    expect(h.sleeps).toEqual([5000, 10_000, 15_000]);
    expect(r).toEqual({ token: "tok" });
  });

  it("denied -> exit 3", async () => {
    const h = harness([() => json({ error: "access_denied" }, 400)]);
    const e = await err(deviceLogin(URL_, "h", h.deps));
    expect(e).toMatchObject({ exitCode: 3, code: "access_denied" });
  });

  it("server says expired_token -> exit 3 with re-run hint", async () => {
    const h = harness([() => json({ error: "expired_token" }, 400)]);
    const e = await err(deviceLogin(URL_, "h", h.deps));
    expect(e.exitCode).toBe(3);
    expect(e.message).toMatch(/run `plane auth login` again/);
  });

  it("local deadline passing also expires", async () => {
    const h = harness([pending, pending, pending, pending]);
    h.f.mockImplementation(async (u) =>
      String(u).endsWith("/code/") ? json({ ...CODE, expires_in: 8, interval: 5 }) : pending()
    );
    const e = await err(deviceLogin(URL_, "h", h.deps));
    expect(e).toMatchObject({ exitCode: 3, code: "expired_token" });
  });

  it("network failure -> exit 5", async () => {
    const e = await err(
      deviceLogin(URL_, "h", {
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      })
    );
    expect(e).toMatchObject({ exitCode: 5, code: "network" });
  });

  it("a browser that cannot open is ignored", async () => {
    const h = harness([() => json({ token: "tok", workspace_slug: "a" })], {
      open: async () => {
        throw new Error("no browser");
      },
    });
    expect(await deviceLogin(URL_, "h", h.deps)).toMatchObject({ token: "tok" });
  });

  it("abort (Ctrl-C) stops polling", async () => {
    const ac = new AbortController();
    const h = harness([pending], {
      signal: ac.signal,
      sleep: async () => {
        ac.abort();
        throw new CliError("login cancelled", 1, "cancelled");
      },
    });
    expect(await err(deviceLogin(URL_, "h", h.deps))).toMatchObject({ code: "cancelled" });
  });

  it("unexpected token response is a failure, not a hang", async () => {
    const h = harness([() => json({ error: "weird" }, 500)]);
    expect(await err(deviceLogin(URL_, "h", h.deps))).toMatchObject({ code: "device_token" });
  });

  it("not a Plane server when /auth/device/code/ is missing", async () => {
    const e = await err(
      deviceLogin(URL_, "h", { fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch })
    );
    expect(e).toMatchObject({ code: "device_code" });
  });
});

describe("default sleep (fake timers)", () => {
  afterEach(() => vi.useRealTimers());

  it("waits the interval, and rejects on abort", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const f = vi.fn(async (u: string | URL | Request) =>
      String(u).endsWith("/code/") ? json(CODE) : json({ token: "t", workspace_slug: "a" })
    );
    const p = deviceLogin(URL_, "h", { fetch: f as unknown as typeof fetch, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(4999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ token: "t" });

    const p2 = err(deviceLogin(URL_, "h", { fetch: f as unknown as typeof fetch, signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    expect(await p2).toMatchObject({ code: "cancelled" });
  });
});

describe("checkPlaneServer", () => {
  it("accepts JSON, rejects HTML / errors / unreachable with a hint", async () => {
    await checkPlaneServer(URL_, (async () => json({ instance: {} })) as unknown as typeof fetch);
    const bad = async (f: typeof fetch) => await err(checkPlaneServer(URL_, f));
    expect((await bad((async () => new Response("<html>")) as unknown as typeof fetch)).message).toMatch(
      /\/api\/instances\//
    );
    expect((await bad((async () => new Response("x", { status: 404 })) as unknown as typeof fetch)).code).toBe(
      "not_plane"
    );
    expect(
      (
        await bad((async () => {
          throw new Error("boom");
        }) as unknown as typeof fetch)
      ).exitCode
    ).toBe(5);
  });
});
