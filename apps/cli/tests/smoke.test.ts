/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "..", "dist", "index.mjs");
const home = mkdtempSync(join(tmpdir(), "plane-cli-smoke-"));
// Async spawn: the fake server lives in this process, so the event loop must stay free.
const plane = (args: string[], input?: string, env: Record<string, string> = {}) =>
  new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
    const c = spawn(process.execPath, [bin, ...args], {
      env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: home, ...env },
    });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ out, err, code }));
    c.stdin.end(input ?? "");
  });

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const ok = req.headers["x-api-key"] === "good";
    res.setHeader("content-type", "application/json");
    if (!ok) return void res.writeHead(401).end('{"error":"Given API token is not valid"}');
    if (req.url === "/api/v1/empty/") return void res.writeHead(req.method === "DELETE" ? 204 : 200).end();
    if (req.url === "/api/v1/html/") return void res.end("<html>");
    if (req.url === "/api/v1/users/me/") return void res.end('{"id":"u1","display_name":"justin"}');
    if (req.url?.startsWith("/api/v1/workspaces/acme/projects/")) return void res.end('{"results":[]}');
    res.writeHead(404).end('{"error":"Not found."}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

describe("built bin", () => {
  it("--help prints usage", async () => {
    const r = await plane(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Usage: plane/);
  });

  it.each(["project", "cycle", "module"])("%s --help lists list and view", async (group) => {
    const r = await plane([group, "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/list/);
    expect(r.out).toMatch(/view/);
    const v = await plane([group, "view", "--help"]);
    expect(v.out).toMatch(/--workspace/);
  });

  it("auth status while logged out says so (stderr, exit 3), never empty", async () => {
    const r = await plane(["auth", "status"]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/✗ not logged in; run `plane auth login`/);
  });

  it("interactive login explains device flow is unavailable", async () => {
    const r = await plane(["auth", "login"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--with-token/);
  });

  it("unknown command is a usage error (exit 2)", async () => {
    const r = await plane(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^✗ unknown command/);
  });

  it("login --with-token, status, api, config, logout against a fake server", async () => {
    let r = await plane(["auth", "login", "--with-token", "--url", url, "--workspace", "acme"], "bad\n");
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^✗ 401/);

    r = await plane(["auth", "login", "--with-token", "--url", url, "--workspace", "nope"], "good\n");
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/workspace "nope" not found/);

    r = await plane(["auth", "login", "--with-token", "--url", url, "--workspace", "acme"], "good\n");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^✓ Logged in to 127\.0\.0\.1:\d+ as justin \(workspace: acme\)/);
    expect(statSync(join(home, "plane", "config.json")).mode & 0o777).toBe(0o600);

    expect((await plane(["auth", "status"])).out).toMatch(/Logged in to .* as justin/);
    expect((await plane(["auth", "token"])).out).toBe("good\n");
    expect((await plane(["config", "get", "workspace"])).out).toBe("acme\n");
    expect((await plane(["config", "set", "workspace", "acme"])).out).toMatch(/already acme, nothing to change/);
    expect((await plane(["config", "set", "workspace", "other"])).out).toBe("✓ Set workspace = other\n");
    expect((await plane(["config", "list", "--json"])).out).not.toContain("good");

    r = await plane(["api", "users/me/"]);
    expect(JSON.parse(r.out)).toEqual({ id: "u1", display_name: "justin" });
    r = await plane(["api", "nothing/"]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/^✗ 404/);

    // empty/malformed 2xx: failure for POST/PUT, fine for GET and DELETE 204
    r = await plane(["api", "empty/", "-X", "POST"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^✗ POST empty\/ returned an empty 200 response/);
    r = await plane(["api", "empty/", "-X", "POST", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: "empty_response", status: 200 } });
    r = await plane(["api", "html/", "-X", "PUT"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/non-JSON/);
    r = await plane(["api", "empty/"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("✓ GET /empty/: 200 OK\n");
    r = await plane(["api", "empty/", "-X", "DELETE"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^✓ DELETE \/empty\/: 204/);

    r = await plane(["auth", "logout"]);
    expect(r.out).toMatch(/^✓ Logged out of 127\.0\.0\.1/);
    expect((await plane(["auth", "logout"])).out).toMatch(/Not logged in, nothing to do/);
  });

  it("env vars alone are enough to authenticate", async () => {
    const r = await plane(["auth", "status", "--json"], undefined, {
      PLANE_URL: url,
      PLANE_API_TOKEN: "good",
      PLANE_WORKSPACE: "acme",
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).user.id).toBe("u1");
  });
});
