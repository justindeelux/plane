/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConvert } from "../src/commands/convert";
import { setOutput } from "../src/output";

let out: string;
let err: string;
let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

const stdin = (text: string) =>
  vi
    .spyOn(process, "stdin", "get")
    .mockReturnValue(Readable.from([Buffer.from(text)]) as unknown as typeof process.stdin);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plane-cli-convert-"));
  // No login, no server: convert must never need either.
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PLANE_URL", "");
  vi.stubEnv("PLANE_API_TOKEN", "");
  vi.stubEnv("PLANE_WORKSPACE", "");
  out = "";
  err = "";
  process.exitCode = 0;
  fetchMock = vi.fn(() => Promise.reject(new Error("convert must not call fetch")));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += s), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += s), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

const plane = async (...args: string[]) => {
  const program = new Command("plane")
    .option("--json")
    .option("-q, --quiet")
    .option("--debug")
    .exitOverride()
    .hook("preAction", (cmd) =>
      setOutput({ json: !!cmd.optsWithGlobals<{ json?: boolean }>().json, quiet: false, debug: false, rawHtml: false })
    );
  registerConvert(program);
  process.exitCode = 0;
  await program.parseAsync(["node", "plane", ...args]);
  return Number(process.exitCode ?? 0);
};

describe("convert", () => {
  it("markdown-to-html reads a file and prints HTML", async () => {
    const file = join(home, "issue.md");
    writeFileSync(file, "# Title\n\n**bold**\n");
    expect(await plane("convert", "markdown-to-html", "--file", file)).toBe(0);
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(err).toBe("");
  });

  it("html-to-markdown reads stdin by default", async () => {
    stdin("<p>hello <strong>world</strong></p>");
    expect(await plane("convert", "html-to-markdown")).toBe(0);
    expect(out).toBe("hello **world**\n");
  });

  it("evaluates task lists the same way as issue bodies", async () => {
    stdin("- [x] done\n- [ ] todo\n");
    expect(await plane("convert", "markdown-to-html", "--file", "-")).toBe(0);
    expect(out).toContain('data-type="taskList"');
    expect(out).toContain('data-checked="true"');
  });

  it("--json returns {html} or {markdown}", async () => {
    const file = join(home, "issue.md");
    writeFileSync(file, "+ item\n");
    expect(await plane("convert", "markdown-to-html", "--file", file, "--json")).toBe(0);
    expect(JSON.parse(out).html).toContain("<li>item</li>");
    out = "";
    const html = join(home, "page.html");
    writeFileSync(html, "<h2>Hi</h2><ul><li>a</li></ul>");
    expect(await plane("convert", "html-to-markdown", "--file", html, "--json")).toBe(0);
    expect(JSON.parse(out)).toEqual({ markdown: "## Hi\n\n* a" });
  });

  it("needs no credentials and makes no HTTP request", async () => {
    stdin("plain");
    expect(await plane("convert", "markdown-to-html")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err).toBe("");
  });

  it("a missing file is a usage error", async () => {
    expect(await plane("convert", "html-to-markdown", "--file", join(home, "absent.html"))).toBe(2);
    expect(err).toMatch(/^✗ cannot read .*absent\.html/);
    expect(out).toBe("");
  });
});
