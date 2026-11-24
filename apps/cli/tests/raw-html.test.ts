/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerComment } from "../src/commands/comment";
import { registerIssue } from "../src/commands/issue";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const IID = "22222222-2222-4222-8222-222222222222";
const CID = "33333333-3333-4333-8333-333333333333";
const WS = "/api/v1/workspaces/acme";
const HTML = "<p>hello <strong>world</strong></p>";

let routes: Record<string, unknown>;
let out: string;
let err: string;
let home: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, statusText: status === 404 ? "Not Found" : "OK" });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plane-cli-raw-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PLANE_URL", "https://plane.test");
  vi.stubEnv("PLANE_API_TOKEN", "tok");
  vi.stubEnv("PLANE_WORKSPACE", "acme");
  routes = {
    [`${WS}/work-items/PROJ-7/`]: {
      id: IID,
      name: "Fix login",
      sequence_id: 7,
      project: PID,
      state: null,
      priority: "none",
      assignees: [],
      labels: [],
      description_html: HTML,
    },
    [`${WS}/projects/${PID}/`]: { id: PID, identifier: "PROJ", name: "Project" },
    [`${WS}/projects/${PID}/states/`]: { results: [] },
    [`${WS}/projects/${PID}/labels/`]: { results: [] },
    [`${WS}/projects/${PID}/members/`]: [],
    [`${WS}/projects/${PID}/work-items/${IID}/comments/${CID}/`]: { id: CID, comment_html: HTML, actor: null },
  };
  out = "";
  err = "";
  process.exitCode = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const path = new URL(u).pathname;
      return path in routes ? json(routes[path]) : json({ error: "Not found." }, 404);
    })
  );
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
    .option("--raw-html")
    .option("--host <host>")
    .exitOverride()
    .hook("preAction", (cmd) => {
      const g = cmd.optsWithGlobals<{ json?: boolean; quiet?: boolean; debug?: boolean; rawHtml?: boolean }>();
      setOutput({ json: !!g.json, quiet: !!g.quiet, debug: !!g.debug, rawHtml: !!g.rawHtml });
    });
  registerIssue(program);
  registerComment(program);
  process.exitCode = 0;
  await program.parseAsync(["node", "plane", ...args]);
  return Number(process.exitCode ?? 0);
};

describe("--raw-html", () => {
  it("issue view hides description_html by default", async () => {
    expect(await plane("issue", "view", "PROJ-7", "--json")).toBe(0);
    const j = JSON.parse(out);
    expect(j.description_html).toBeUndefined();
    expect(j.body_markdown).toBe("hello **world**");
    expect(err).toBe("");
  });

  it("issue view --json keeps description_html alongside body_markdown", async () => {
    expect(await plane("issue", "view", "PROJ-7", "--json", "--raw-html")).toBe(0);
    const j = JSON.parse(out);
    expect(j.description_html).toBe(HTML);
    expect(j.body_markdown).toBe("hello **world**");
  });

  it("issue view prints the raw HTML block only with the flag", async () => {
    expect(await plane("issue", "view", "PROJ-7")).toBe(0);
    expect(out).toContain("hello **world**");
    expect(out).not.toContain("<strong>world</strong>");
    out = "";
    expect(await plane("issue", "view", "PROJ-7", "--raw-html")).toBe(0);
    expect(out).toContain("hello **world**");
    expect(out).toContain(`Raw HTML:\n${HTML}`);
  });

  it("comment view hides comment_html by default", async () => {
    expect(await plane("comment", "view", "PROJ-7", CID, "--json")).toBe(0);
    const j = JSON.parse(out);
    expect(j.comment_html).toBeUndefined();
    expect(j.body_markdown).toBe("hello **world**");
  });

  it("comment view --json keeps comment_html alongside body_markdown", async () => {
    expect(await plane("comment", "view", "PROJ-7", CID, "--json", "--raw-html")).toBe(0);
    const j = JSON.parse(out);
    expect(j.comment_html).toBe(HTML);
    expect(j.body_markdown).toBe("hello **world**");
  });

  it("comment view prints the raw HTML block only with the flag", async () => {
    expect(await plane("comment", "view", "PROJ-7", CID)).toBe(0);
    expect(out).toContain("hello **world**");
    expect(out).not.toContain("<strong>world</strong>");
    out = "";
    expect(await plane("comment", "view", "PROJ-7", CID, "--raw-html")).toBe(0);
    expect(out).toContain(`Raw HTML:\n${HTML}`);
  });

  it("works as a global flag before the command", async () => {
    expect(await plane("--raw-html", "issue", "view", "PROJ-7", "--json")).toBe(0);
    expect(JSON.parse(out).description_html).toBe(HTML);
  });
});
