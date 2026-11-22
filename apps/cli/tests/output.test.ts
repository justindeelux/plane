/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../src/errors";
import { fail, noop, run, setOutput, success } from "../src/output";

let stdout: string[];
let stderr: string[];
beforeEach(() => {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  setOutput({ json: false, quiet: false, debug: false });
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("output contract", () => {
  it("success prints one ✓ line on stdout, exit 0", () => {
    success('Created PROJ-1 "Fix" https://x/y', "created");
    expect(stdout.join("")).toBe('✓ Created PROJ-1 "Fix" https://x/y\n');
    expect(process.exitCode).toBeUndefined();
  });

  it("--quiet hides success but not no-op or failure", () => {
    setOutput({ quiet: true });
    success("done", "created");
    expect(stdout).toEqual([]);
    noop("PROJ-1 is already Done, nothing to change");
    expect(stdout.join("")).toContain("already Done");
    fail(new CliError("boom", EXIT.notFound));
    expect(stderr.join("")).toBe("✗ boom\n");
  });

  it("no-op says so on stdout, exit 0", () => {
    noop("PROJ-1 is already Done, nothing to change");
    expect(stdout.join("")).toBe("PROJ-1 is already Done, nothing to change\n");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    [EXIT.general, 1],
    [EXIT.usage, 2],
    [EXIT.auth, 3],
    [EXIT.notFound, 4],
    [EXIT.rateLimit, 5],
  ])("failure exit %i goes to stderr as ✗ line", (code, expected) => {
    fail(new CliError("nope", code), "Update failed");
    expect(stderr.join("")).toBe("✗ Update failed: nope\n");
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(expected);
  });

  it("no stack trace unless --debug", () => {
    fail(new Error("x"));
    expect(stderr.join("")).not.toMatch(/at /);
    stderr.length = 0;
    setOutput({ debug: true });
    fail(new Error("x"));
    expect(stderr.join("")).toMatch(/at /);
  });

  it("--json shapes", () => {
    setOutput({ json: true });
    success("ignored", "created", { id: "1" });
    expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, action: "created", item: { id: "1" } });
    stdout.length = 0;
    fail(new CliError("gone", EXIT.notFound, "http_404", 404));
    expect(JSON.parse(stdout.join(""))).toEqual({
      ok: false,
      error: { code: "http_404", message: "gone", status: 404 },
    });
    expect(stderr).toEqual([]);
    expect(process.exitCode).toBe(4);
  });

  it("run() converts thrown errors into failures", async () => {
    await run(async () => {
      throw new CliError("denied", EXIT.auth);
    })();
    expect(stderr.join("")).toBe("✗ denied\n");
    expect(process.exitCode).toBe(3);
  });
});
