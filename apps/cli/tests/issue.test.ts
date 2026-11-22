/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssue } from "../src/commands/issue";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const IID = "22222222-2222-4222-8222-222222222222";
const S_TODO = "aaaaaaaa-0000-4000-8000-000000000001";
const S_DOING = "aaaaaaaa-0000-4000-8000-000000000002";
const S_DONE = "aaaaaaaa-0000-4000-8000-000000000003";
const L_BUG = "bbbbbbbb-0000-4000-8000-000000000001";
const U_ME = "cccccccc-0000-4000-8000-000000000001";
const U_ANN = "cccccccc-0000-4000-8000-000000000002";

const baseIssue = () => ({
  id: IID,
  name: "Fix login",
  sequence_id: 7,
  project: PID,
  state: S_TODO,
  priority: "none",
  assignees: [] as string[],
  labels: [] as string[],
  description_html: "<p>old</p>",
});

type Reply = { status?: number; body?: unknown; text?: string };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };

let ws = 0;
let calls: Call[];
let issue: ReturnType<typeof baseIssue>;
let overrides: Record<string, Reply | ((c: Call) => Reply)>;
let out: string;
let err: string;
let home: string;

const api = (c: Call): Reply => {
  const key = `${c.method} ${c.path}`;
  const o = overrides[key];
  if (o) return typeof o === "function" ? o(c) : o;
  const w = `/api/v1/workspaces/${currentWs()}`;
  const p = `${w}/projects/${PID}`;
  switch (key) {
    case "GET /api/v1/users/me/":
      return { body: { id: U_ME } };
    case `GET ${w}/projects/`:
      return { body: { results: [{ id: PID, identifier: "PROJ", name: "Project" }], next_page_results: false } };
    case `GET ${p}/`:
      return { body: { id: PID, identifier: "PROJ", name: "Project" } };
    case `GET ${p}/states/`:
      return {
        body: {
          results: [
            { id: S_TODO, name: "Todo", group: "unstarted", sequence: 1 },
            { id: S_DOING, name: "In Progress", group: "started", sequence: 2 },
            { id: S_DONE, name: "Done", group: "completed", sequence: 3 },
          ],
        },
      };
    case `GET ${p}/labels/`:
      return { body: { results: [{ id: L_BUG, name: "bug" }] } };
    case `GET ${p}/members/`:
      return {
        body: [
          { id: U_ME, display_name: "justin" },
          { id: U_ANN, display_name: "ann" },
        ],
      };
    case `GET ${w}/work-items/PROJ-7/`:
      return { body: issue };
    case `GET ${p}/work-items/`:
      return {
        body: {
          results: [
            issue,
            { ...baseIssue(), id: "x", sequence_id: 8, name: "Other", state: S_DONE, assignees: [U_ANN] },
          ],
          next_page_results: false,
        },
      };
    case `POST ${p}/work-items/`:
      return { status: 201, body: { ...issue, ...(c.body as object), id: IID, sequence_id: 9 } };
    case `PATCH ${p}/work-items/${IID}/`:
      return { body: { ...issue, ...(c.body as object) } };
    case `POST ${p}/work-items/${IID}/comments/`:
      return { status: 201, body: { id: "cm1", comment_html: (c.body as { comment_html: string }).comment_html } };
  }
  return { status: 404, body: { error: `no route ${key}` } };
};
const currentWs = () => `ws${ws}`;

const plane = async (...args: string[]) => {
  const program = new Command("plane")
    .option("--json")
    .option("-q, --quiet")
    .option("--debug")
    .option("--host <host>")
    .exitOverride()
    .hook("preAction", (cmd) => {
      const g = cmd.optsWithGlobals<{ json?: boolean; quiet?: boolean }>();
      setOutput({ json: !!g.json, quiet: !!g.quiet, debug: false });
    });
  registerIssue(program);
  process.exitCode = 0;
  await program.parseAsync(["node", "plane", ...args]);
  return Number(process.exitCode ?? 0);
};

beforeEach(() => {
  ws++;
  calls = [];
  issue = baseIssue();
  overrides = {};
  out = "";
  err = "";
  home = mkdtempSync(join(tmpdir(), "plane-cli-issue-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PLANE_URL", "https://plane.test");
  vi.stubEnv("PLANE_API_TOKEN", "tok");
  vi.stubEnv("PLANE_WORKSPACE", currentWs());
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += s), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += s), true));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      ...(init.body ? { body: JSON.parse(init.body as string) as Record<string, unknown> } : {}),
    };
    calls.push(call);
    const r = api(call);
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status ?? 200 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

const writes = () => calls.filter((c) => c.method !== "GET");

describe("issue list", () => {
  it("prints a table and filters client-side", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--state", "done", "--assignee", "ann")).toBe(0);
    expect(out).toMatch(/PROJ-8\tOther\tDone\tann\tnone/);
    expect(out).not.toMatch(/Fix login/);
  });
  it("--assignee me resolves via users/me", async () => {
    issue.assignees = [U_ME];
    await plane("issue", "list", "--project", "PROJ", "--assignee", "me", "--json");
    expect(JSON.parse(out).map((i: { id: string }) => i.id)).toEqual([IID]);
  });
  it("says 'No issues match' / [] when empty", async () => {
    await plane("issue", "list", "--project", "PROJ", "--label", "bug");
    expect(out).toBe("No issues match\n");
    out = "";
    await plane("issue", "list", "--project", "PROJ", "--label", "bug", "--json");
    expect(JSON.parse(out)).toEqual([]);
  });
  it("--limit and unknown state with did-you-mean", async () => {
    await plane("issue", "list", "--project", "PROJ", "--limit", "1", "--json");
    expect(JSON.parse(out)).toHaveLength(1);
    expect(await plane("issue", "list", "--project", "PROJ", "--state", "Dne")).toBe(2);
    expect(err).toMatch(/^✗ state "Dne" not found, did you mean "Done"\?/);
  });
  it("suggests only close matches, else lists what is available", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--state", "Doing")).toBe(2);
    expect(err).toMatch(/state "Doing" not found \(available: Todo, In Progress, Done\)/);
    expect(err).not.toMatch(/did you mean/);
    err = "";
    expect(await plane("issue", "list", "--project", "PROJ", "--state", "Don")).toBe(2);
    expect(err).toMatch(/did you mean "Done"\?/);
    expect(await plane("issue", "list", "--project", "PROJ", "--state", "done")).toBe(0);
  });
  it("--cycle uses the cycle-issues endpoint", async () => {
    const w = `/api/v1/workspaces/${currentWs()}/projects/${PID}`;
    overrides[`GET ${w}/cycles/`] = { body: { results: [{ id: "cy1", name: "Sprint 1" }] } };
    overrides[`GET ${w}/cycles/cy1/cycle-issues/`] = { body: { results: [issue], next_page_results: false } };
    await plane("issue", "list", "--project", "PROJ", "--cycle", "sprint 1", "--json");
    expect(JSON.parse(out)).toHaveLength(1);
  });
  it("missing project is a usage error", async () => {
    expect(await plane("issue", "list")).toBe(2);
    expect(err).toMatch(/no project/);
  });
});

describe("issue view", () => {
  it("prints fields and description as Markdown", async () => {
    issue.description_html = "<p>hello <strong>world</strong></p>";
    issue.assignees = [U_ANN];
    expect(await plane("issue", "view", "PROJ-7")).toBe(0);
    expect(out).toContain("PROJ-7  Fix login");
    expect(out).toContain("State: Todo");
    expect(out).toContain("Assignee: ann");
    expect(out).toContain(`URL: https://plane.test/${currentWs()}/browse/PROJ-7/`);
    expect(out).toContain("hello **world**");
  });
  it("--json carries raw html and body_markdown", async () => {
    issue.description_html = "<p><em>x</em></p>";
    await plane("issue", "view", "PROJ-7", "--json");
    const j = JSON.parse(out);
    expect(j.description_html).toBe("<p><em>x</em></p>");
    expect(j.body_markdown).toBe("_x_");
  });
  it("accepts a lowercase project identifier (prj-7 -> PROJ-7)", async () => {
    expect(await plane("issue", "view", "proj-7")).toBe(0);
    expect(calls.some((c) => c.path.endsWith("/work-items/PROJ-7/"))).toBe(true);
  });
  it("404 -> exit 4, bad ref -> exit 2", async () => {
    overrides[`GET /api/v1/workspaces/${currentWs()}/work-items/PROJ-7/`] = { status: 404, body: { error: "nope" } };
    expect(await plane("issue", "view", "PROJ-7")).toBe(4);
    expect(err).toMatch(/^✗ 404/);
    expect(await plane("issue", "view", "banana")).toBe(2);
  });
});

describe("issue create", () => {
  it("converts Markdown, resolves names, prints the success line", async () => {
    const code = await plane(
      "issue",
      "create",
      "--project",
      "PROJ",
      "--title",
      "New thing",
      "--body",
      "- [ ] todo\n\n**bold**",
      "--state",
      "in progress",
      "--priority",
      "high",
      "--assignee",
      "me",
      "--label",
      "bug"
    );
    expect(code).toBe(0);
    expect(out).toBe(`✓ Created PROJ-9 "New thing" https://plane.test/${currentWs()}/browse/PROJ-9/\n`);
    const body = writes()[0]!.body!;
    expect(body).toMatchObject({
      name: "New thing",
      state: S_DOING,
      priority: "high",
      assignees: [U_ME],
      labels: [L_BUG],
    });
    expect(body.description_html).toContain("<strong>bold</strong>");
    expect(body.description_html).toContain('data-type="taskList"');
  });
  it("reads the body from a file", async () => {
    const f = join(home, "b.md");
    writeFileSync(f, "# Title\n");
    await plane("issue", "create", "--project", "PROJ", "--title", "t", "--body-file", f);
    expect(writes()[0]!.body!.description_html).toContain("<h1>");
  });
  it("--json envelope; --quiet hides only the line", async () => {
    await plane("issue", "create", "--project", "PROJ", "--title", "t", "--json");
    expect(JSON.parse(out)).toMatchObject({ ok: true, action: "created", item: { identifier: "PROJ-9" } });
    out = "";
    await plane("issue", "create", "--project", "PROJ", "--title", "t", "-q");
    expect(out).toBe("");
  });
  it("unknown label/assignee/priority fail before any write", async () => {
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t", "--label", "bgu")).toBe(2);
    expect(err).toMatch(/label "bgu" not found, did you mean "bug"\?/);
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t", "--assignee", "zed")).toBe(2);
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t", "--priority", "huge")).toBe(2);
    expect(writes()).toHaveLength(0);
  });
  it("missing title is a usage error; no body without a TTY means no description", async () => {
    expect(await plane("issue", "create", "--project", "PROJ")).toBe(2);
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t", "--json")).toBe(0);
    expect(writes()[0]!.body).not.toHaveProperty("description_html");
  });
  it("server 403 -> stderr, exit 3; empty 2xx -> failure", async () => {
    const w = `POST /api/v1/workspaces/${currentWs()}/projects/${PID}/work-items/`;
    overrides[w] = { status: 403, body: { error: "Forbidden" } };
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t")).toBe(3);
    expect(err).toMatch(/^✗ 403/);
    err = "";
    overrides[w] = { status: 403, body: { detail: "Given API token is not valid" } };
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t", "--json")).toBe(3);
    expect(JSON.parse(out).error.message).toContain("run `plane auth login` (or check PLANE_API_TOKEN)");
    err = "";
    out = "";
    overrides[w] = { status: 201 };
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t")).toBe(1);
    expect(err).toMatch(/empty 201 response/);
    expect(out).toBe("");
    overrides[w] = { status: 201, body: { id: IID } };
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t")).toBe(1);
    expect(err).toMatch(/malformed/);
  });
  it("--json failure envelope on stdout", async () => {
    overrides[`POST /api/v1/workspaces/${currentWs()}/projects/${PID}/work-items/`] = { status: 201 };
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "t", "--json")).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "empty_response" } });
  });
});

describe("issue edit", () => {
  const path = () => `PATCH /api/v1/workspaces/${currentWs()}/projects/${PID}/work-items/${IID}/`;
  it("reports the fields that changed and only sends those", async () => {
    expect(await plane("issue", "edit", "PROJ-7", "--state", "Done", "--label", "bug", "--priority", "high")).toBe(0);
    expect(out).toBe("✓ Updated PROJ-7: priority none -> high, state Todo -> Done, labels +bug\n");
    expect(writes()[0]!.body).toEqual({ priority: "high", state: S_DONE, labels: [L_BUG] });
  });
  it("no-op line when nothing changes, and no write", async () => {
    expect(await plane("issue", "edit", "PROJ-7", "--state", "todo", "--title", "Fix login")).toBe(0);
    expect(out).toBe("PROJ-7 already matches, nothing to change\n");
    expect(writes()).toHaveLength(0);
  });
  it("body edits convert Markdown; edits without a body never resend the description", async () => {
    await plane("issue", "edit", "PROJ-7", "--title", "Renamed");
    expect(writes()[0]!.body).toEqual({ name: "Renamed" });
    await plane("issue", "edit", "PROJ-7", "--body", "new *text*");
    expect(writes()[1]!.body!.description_html).toContain("<em>text</em>");
    expect(out).toMatch(/description updated/);
  });
  it("refuses to flatten a lossy description unless --force", async () => {
    issue.description_html = '<p>hi <mention-component entity_name="user_mention"></mention-component></p>';
    expect(await plane("issue", "edit", "PROJ-7", "--body", "replaced")).toBe(2);
    expect(err).toMatch(/--force/);
    expect(writes()).toHaveLength(0);
    err = "";
    expect(await plane("issue", "edit", "PROJ-7", "--body", "replaced", "--force")).toBe(0);
    expect(writes()).toHaveLength(1);
    // non-body edits are fine on a lossy description
    expect(await plane("issue", "edit", "PROJ-7", "--priority", "low")).toBe(0);
    expect(writes()[1]!.body).toEqual({ priority: "low" });
  });
  it("removes labels/assignees", async () => {
    issue.labels = [L_BUG];
    issue.assignees = [U_ANN];
    await plane("issue", "edit", "PROJ-7", "--remove-label", "bug", "--remove-assignee", "ann", "--assignee", "me");
    expect(writes()[0]!.body).toEqual({ labels: [], assignees: [U_ME] });
    expect(out).toMatch(/labels -bug, assignees \+justin -ann/);
  });
  it("empty 2xx, malformed, and unapplied responses are failures", async () => {
    overrides[path()] = { status: 200 };
    expect(await plane("issue", "edit", "PROJ-7", "--title", "x")).toBe(1);
    expect(err).toMatch(/empty 200 response/);
    err = "";
    overrides[path()] = { body: { ...issue, name: "unchanged" } };
    expect(await plane("issue", "edit", "PROJ-7", "--title", "x")).toBe(1);
    expect(err).toMatch(/server did not apply name/);
    err = "";
    overrides[path()] = { status: 403, body: { error: "no" } };
    expect(await plane("issue", "edit", "PROJ-7", "--title", "x")).toBe(3);
    expect(out).toBe("");
  });
});

describe("issue comment", () => {
  const path = () => `POST /api/v1/workspaces/${currentWs()}/projects/${PID}/work-items/${IID}/comments/`;
  it("converts Markdown and prints the success line", async () => {
    expect(await plane("issue", "comment", "PROJ-7", "--body", "looks **good**")).toBe(0);
    expect(out).toBe(`✓ Commented on PROJ-7 https://plane.test/${currentWs()}/browse/PROJ-7/\n`);
    expect(writes()[0]!.body!.comment_html).toContain("<strong>good</strong>");
  });
  it("empty / malformed / error responses fail", async () => {
    overrides[path()] = { status: 201 };
    expect(await plane("issue", "comment", "PROJ-7", "--body", "x")).toBe(1);
    expect(err).toMatch(/empty 201/);
    overrides[path()] = { status: 201, body: { id: "c" } };
    expect(await plane("issue", "comment", "PROJ-7", "--body", "x")).toBe(1);
    overrides[path()] = { status: 503, body: { error: "down" } };
    expect(await plane("issue", "comment", "PROJ-7", "--body", "x", "--json")).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false });
  });
  it("empty body is a usage error", async () => {
    expect(await plane("issue", "comment", "PROJ-7", "--body", "  ")).toBe(2);
    expect(writes()).toHaveLength(0);
  });
});

describe("issue close / reopen", () => {
  it("close moves to the completed group", async () => {
    expect(await plane("issue", "close", "PROJ-7")).toBe(0);
    expect(out).toBe("✓ Closed PROJ-7: state Todo -> Done\n");
    expect(writes()[0]!.body).toEqual({ state: S_DONE });
  });
  it("no-op when already there", async () => {
    issue.state = S_DONE;
    expect(await plane("issue", "close", "PROJ-7")).toBe(0);
    expect(out).toBe("PROJ-7 is already Done, nothing to change\n");
    expect(writes()).toHaveLength(0);
    out = "";
    issue.state = S_TODO;
    await plane("issue", "reopen", "PROJ-7");
    expect(out).toBe("PROJ-7 is already Todo, nothing to change\n");
  });
  it("reopen with --state, and unknown state fails", async () => {
    issue.state = S_DONE;
    expect(await plane("issue", "reopen", "PROJ-7", "--state", "In Progress")).toBe(0);
    expect(out).toBe("✓ Reopened PROJ-7: state Done -> In Progress\n");
    expect(await plane("issue", "reopen", "PROJ-7", "--state", "in progres")).toBe(2);
    expect(err).toMatch(/state "in progres" not found, did you mean "In Progress"\?/);
  });
  it("empty and unapplied responses fail", async () => {
    const p = `PATCH /api/v1/workspaces/${currentWs()}/projects/${PID}/work-items/${IID}/`;
    overrides[p] = { status: 200 };
    expect(await plane("issue", "close", "PROJ-7")).toBe(1);
    expect(err).toMatch(/empty 200/);
    overrides[p] = { body: { ...issue } };
    expect(await plane("issue", "close", "PROJ-7")).toBe(1);
    expect(err).toMatch(/server did not move/);
  });
});
