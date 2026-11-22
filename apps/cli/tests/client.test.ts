/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { Client } from "../src/client";
import { CliError, EXIT } from "../src/errors";

const res = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
const raw = (text: string, status = 200) => ({ status, statusText: "OK", text });
const make = (f: ReturnType<typeof vi.fn>, extra = {}) =>
  new Client({
    url: "https://plane.example.com/",
    token: "tok",
    fetch: f as never,
    sleep: async () => undefined,
    ...extra,
  });

describe("Client", () => {
  it("calls <url>/api/v1 with X-Api-Key", async () => {
    const f = vi.fn().mockResolvedValue(res('{"id":"1"}'));
    await make(f).get("users/me/");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://plane.example.com/api/v1/users/me/");
    expect((init as RequestInit).headers).toMatchObject({ "X-Api-Key": "tok" });
  });

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const f = vi
      .fn()
      .mockResolvedValueOnce(res("", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(res('{"id":"1"}'));
    await expect(make(f, { sleep }).get("x/")).resolves.toEqual({ id: "1" });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up on persistent 429 with exit code 5", async () => {
    const f = vi.fn().mockImplementation(async () => res("", { status: 429, statusText: "Too Many Requests" }));
    const err = (await make(f, { maxRetries: 2 })
      .get("x/")
      .catch((e: unknown) => e)) as CliError;
    expect(f).toHaveBeenCalledTimes(3);
    expect(err.exitCode).toBe(EXIT.rateLimit);
  });

  it.each([
    [401, EXIT.auth, /plane auth login/],
    [403, EXIT.auth, /403/],
    [404, EXIT.notFound, /not found/i],
    [500, EXIT.general, /500/],
  ])("maps HTTP %i to exit %i", async (status, exit, msg) => {
    const f = vi.fn().mockResolvedValue(res('{"error":"Not found."}', { status, statusText: "Err" }));
    const err = (await make(f)
      .get("x/")
      .catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(exit);
    if (status === 404) expect(err.message).toMatch(msg);
    else expect(err.message).toMatch(msg);
    expect(err.status).toBe(status);
  });

  it.each([
    [401, '{"detail":"x"}', true],
    [403, '{"detail":"Given API token is not valid"}', true],
    [403, '{"detail":"You do not have permission to perform this action."}', false],
  ])("auth hint for %i %s -> %s", async (status, body, hint) => {
    const f = vi.fn().mockResolvedValue(res(body, { status, statusText: "Err" }));
    const err = (await make(f)
      .get("x/")
      .catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(EXIT.auth);
    if (hint) expect(err.message).toContain("run `plane auth login` (or check PLANE_API_TOKEN)");
    else expect(err.message).not.toMatch(/plane auth login/);
  });

  it("reports network failure as exit 5", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = (await make(f)
      .get("x/")
      .catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(EXIT.rateLimit);
    expect(err.message).toMatch(/cannot reach/);
  });

  it("treats empty or malformed 2xx on writes as failure", async () => {
    await Promise.all(
      ["", "not json", "{}", "[]"].map((body) => {
        const f = vi.fn().mockResolvedValue(res(body, { status: body ? 200 : 201 }));
        return expect(make(f).post("projects/", { name: "x" }, { expect: ["id"] })).rejects.toBeInstanceOf(CliError);
      })
    );
    const missingId = vi.fn().mockResolvedValue(res('{"name":"x"}'));
    await expect(make(missingId).patch("p/", {}, { expect: ["id"] })).rejects.toThrow(/missing id/);
  });

  it("flags a non-JSON 200 on reads as a probable non-Plane server; allows 204 DELETE", async () => {
    await expect(make(vi.fn().mockResolvedValue(res("<html>"))).get("x/")).rejects.toThrow(/api\/instances/);
    await expect(
      make(vi.fn().mockResolvedValue(new Response(null, { status: 204 }))).delete("x/")
    ).resolves.toBeUndefined();
  });

  it("parseBody: write needs a JSON body; DELETE 204 and empty GET are the caller's call", () => {
    const c = make(vi.fn());
    expect(() => c.parseBody("POST", "empty", raw(""))).toThrow(/empty 200/);
    expect(() => c.parseBody("PUT", "bad", raw("<html>"))).toThrow(/non-JSON/);
    expect(c.parseBody("DELETE", "x", raw("", 204))).toBeUndefined();
    expect(c.parseBody("PATCH", "x", raw('{"id":"1"}'))).toEqual({ id: "1" });
  });

  it("follows cursor pagination", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(JSON.stringify({ results: [1, 2], next_page_results: true, next_cursor: "c2" })))
      .mockResolvedValueOnce(res(JSON.stringify({ results: [3], next_page_results: false, next_cursor: "c3" })));
    await expect(make(f).paginate("issues/")).resolves.toEqual([1, 2, 3]);
    expect(String(f.mock.calls[1]![0])).toContain("cursor=c2");
  });
});
