/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "..", "dist", "index.mjs");
const home = mkdtempSync(join(tmpdir(), "plane-cli-smoke-"));
// Stub browser launchers so a login test never opens a real browser; they log the URL they were given.
const stubs = mkdtempSync(join(tmpdir(), "plane-cli-stubs-"));
const opened = join(stubs, "opened.log");
for (const n of ["open", "xdg-open"]) {
  writeFileSync(join(stubs, n), `#!/bin/sh\necho "$@" >> ${opened}\n`);
  chmodSync(join(stubs, n), 0o755);
}
// Async spawn: the fake server lives in this process, so the event loop must stay free.
const plane = (args: string[], input?: string, env: Record<string, string> = {}) =>
  new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
    const c = spawn(process.execPath, [bin, ...args], {
      env: { PATH: `${stubs}:${process.env.PATH ?? ""}`, XDG_CONFIG_HOME: home, ...env },
    });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ out, err, code }));
    c.stdin.end(input ?? "");
  });

let polls = 0;
let mode: "approve" | "deny" | "expire" = "approve";
let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const ok = req.headers["x-api-key"] === "good" || req.headers["x-api-key"] === "devtok";
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/instances/") return void res.end('{"instance":{}}');
    if (req.url === "/auth/device/code/") {
      polls = 0;
      return void res.end(
        JSON.stringify({
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: `${url}/device`,
          verification_uri_complete: `${url}/device?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 1,
        })
      );
    }
    if (req.url === "/auth/device/token/") {
      const err = (e: string) => void res.writeHead(400).end(JSON.stringify({ error: e }));
      if (mode === "expire") return err("expired_token");
      if (mode === "deny") return err("access_denied");
      if (++polls < 2) return err("authorization_pending");
      return void res.end('{"token":"devtok","workspace_slug":"acme"}');
    }
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
  rmSync(stubs, { recursive: true, force: true });
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

  it("-h/--help on every leaf command prints that command's own usage (exit 0, stdout)", async () => {
    // Enumerate the command tree from the built bin's own help output.
    const leaves: string[][] = [];
    const walk = async (path: string[]) => {
      const { out } = await plane([...path, "--help"]);
      const section = out.split(/^Commands:\n/m)[1]?.split(/\n\n/)[0] ?? "";
      const subs = [...section.matchAll(/^ {2}([a-z][\w-]*)/gm)].map((m) => m[1]).filter((n) => n !== "help");
      if (!subs.length) return void leaves.push(path);
      await Promise.all(subs.map((s) => walk([...path, s])));
    };
    await walk([]);
    expect(leaves.length).toBeGreaterThanOrEqual(14);
    const runs = leaves.flatMap((leaf) => ["-h", "--help"].map((flag) => ({ leaf, flag })));
    const results = await Promise.all(runs.map(({ leaf, flag }) => plane([...leaf, flag])));
    results.forEach((r, i) => {
      const name = `${runs[i].leaf.join(" ")} ${runs[i].flag}`;
      expect(r.code, name).toBe(0);
      expect(r.err, name).toBe("");
      expect(r.out.startsWith(`Usage: plane ${runs[i].leaf.join(" ")} `), name).toBe(true);
    });
  });

  it("auth status while logged out says so (stderr, exit 3), never empty", async () => {
    const r = await plane(["auth", "status"]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/✗ not logged in; run `plane auth login`/);
  });

  it("browser login without a URL in a non-TTY is a usage error (exit 2)", async () => {
    const r = await plane(["auth", "login"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--with-token/);
  });

  it("browser login against a non-Plane URL fails with a hint", async () => {
    const r = await plane(["auth", "login", "--url", "http://127.0.0.1:1"]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/cannot reach/);
  });

  it("device login: pending -> approved, saves 0600 config, prints the success line", async () => {
    mode = "approve";
    const r = await plane(["auth", "login", "--url", `${url}/`]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/! Confirmation code: ABCD-EFGH/);
    expect(r.out).toMatch(/^✓ Logged in as justin \(workspace: acme\) on 127\.0\.0\.1:\d+\n$/);
    expect(readFileSync(opened, "utf8")).toContain("/device?user_code=ABCD-EFGH");
    const file = join(home, "plane", "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.profiles[cfg.current]).toMatchObject({ url, token: "devtok", workspace: "acme" });
    await plane(["auth", "logout"]);
  });

  it("device login --json prints only JSON on stdout", async () => {
    mode = "approve";
    const r = await plane(["auth", "login", "--url", url, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, action: "login", item: { workspace: "acme" } });
    await plane(["auth", "logout"]);
  });

  it("device login denied -> exit 3, expired -> exit 3 with re-run hint, nothing saved", async () => {
    mode = "deny";
    let r = await plane(["auth", "login", "--url", url]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/denied/);
    mode = "expire";
    r = await plane(["auth", "login", "--url", url]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/plane auth login/);
    expect((await plane(["auth", "status"])).code).toBe(3);
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
