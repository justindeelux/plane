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
import { registerIssue } from "../src/commands/issue";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const PID2 = "99999999-9999-4999-8999-999999999999";
const IID = "22222222-2222-4222-8222-222222222222";
const PARENT = "77777777-7777-4777-8777-777777777777";
const OTHER = "88888888-8888-4888-8888-888888888888";

const S_BACKLOG = "aaaaaaaa-0000-4000-8000-000000000001";
const S_TODO = "aaaaaaaa-0000-4000-8000-000000000002";
const S_DOING = "aaaaaaaa-0000-4000-8000-000000000003";
const S_DONE = "aaaaaaaa-0000-4000-8000-000000000004";
const S_CANCELLED = "aaaaaaaa-0000-4000-8000-000000000005";
const S_TRIAGE = "aaaaaaaa-0000-4000-8000-000000000006";

const W = "/api/v1/workspaces/acme";
const P = `${W}/projects/${PID}`;
const LIST = `${P}/work-items/`;

type Reply = { status?: number; body?: unknown; text?: string };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
type Handler = (c: Call) => Reply;

const project = { id: PID, identifier: "PROJ", name: "Project" };
const states = [
  { id: S_BACKLOG, name: "Backlog", group: "backlog" },
  { id: S_TODO, name: "Todo", group: "unstarted" },
  { id: S_DOING, name: "In Progress", group: "started" },
  { id: S_DONE, name: "Done", group: "completed" },
  { id: S_CANCELLED, name: "Cancelled", group: "cancelled" },
  { id: S_TRIAGE, name: "Triage", group: "triage" },
];

type TestIssue = {
  id: string;
  name: string;
  sequence_id: number;
  project: string;
  state: string;
  priority: string;
  assignees: string[];
  labels: string[];
  description_html: string;
  parent?: string | null;
  start_date?: string | null;
  target_date?: string | null;
};

const issueOf = (
  id: string,
  sequence_id: number,
  name: string,
  state: string,
  extra: Partial<TestIssue> = {}
): TestIssue => ({
  id,
  name,
  sequence_id,
  project: PID,
  state,
  priority: "none",
  assignees: [] as string[],
  labels: [] as string[],
  description_html: "",
  ...extra,
});

const issue = issueOf(IID, 7, "Fix login", S_TODO, {
  description_html: "<p>Login <strong>error</strong></p>",
});

let items: ReturnType<typeof issueOf>[];
let routes: Record<string, Handler>;
let calls: Call[];
let out: string;
let err: string;
let home: string;

const page = (results: unknown[]) => ({ results, next_page_results: false });

const plane = async (...args: string[]) => {
  const program = new Command("plane")
    .option("--json")
    .option("-q, --quiet")
    .option("--debug")
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
  items = [
    issueOf(IID, 1, "Fix login", S_TODO, { description_html: "<p>Login <strong>error</strong></p>" }),
    issueOf("b0000000-0000-4000-8000-000000000001", 2, "Backlog item", S_BACKLOG),
    issueOf("c0000000-0000-4000-8000-000000000001", 3, "Child one", S_DOING, { parent: PARENT }),
    issueOf("d0000000-0000-4000-8000-000000000001", 4, "Done thing", S_DONE),
    issueOf("e0000000-0000-4000-8000-000000000001", 5, "Cancelled thing", S_CANCELLED),
    issueOf("f0000000-0000-4000-8000-000000000001", 6, "Triage thing", S_TRIAGE),
    issueOf("g0000000-0000-4000-8000-000000000001", 7, "Another child", S_BACKLOG, { parent: PARENT }),
    issueOf("h0000000-0000-4000-8000-000000000001", 8, "Unrelated", S_TODO, {
      description_html: "<p>nothing</p>",
    }),
  ];
  calls = [];
  out = "";
  err = "";
  issue.parent = null;
  issue.start_date = null;
  issue.target_date = null;
  issue.state = S_TODO;
  routes = {
    [`GET ${W}/projects/`]: () => ({ body: page([project]) }),
    [`GET ${W}/projects/${PID}/`]: () => ({ body: project }),
    [`GET ${W}/projects/${PID2}/`]: () => ({ body: { id: PID2, identifier: "OTHER", name: "Other" } }),
    [`GET ${W}/users/me/`]: () => ({ body: { id: "cccccccc-0000-4000-8000-000000000001" } }),
    [`GET ${P}/states/`]: () => ({ body: page(states) }),
    [`GET ${P}/labels/`]: () => ({ body: page([]) }),
    [`GET ${P}/members/`]: () => ({ body: [] }),
    [`GET ${W}/work-items/PROJ-7/`]: () => ({ body: issue }),
    [`GET ${W}/work-items/PROJ-8/`]: () => ({
      body: { id: PARENT, project: PID, sequence_id: 8, name: "Parent", parent: null },
    }),
    [`GET ${W}/work-items/PROJ-9/`]: () => ({
      body: { id: OTHER, project: PID2, sequence_id: 9, name: "Foreign", parent: null },
    }),
    [`GET ${P}/work-items/${PARENT}/`]: () => ({ body: { id: PARENT, parent: null } }),
    [`GET ${P}/work-items/${IID}/`]: () => ({ body: issue }),
    [`GET ${LIST}`]: () => ({ body: page(items) }),
    [`PATCH ${P}/work-items/${IID}/`]: (c) => ({ body: { ...issue, ...(c.body as object) } }),
    [`POST ${P}/work-items/`]: (c) => ({
      status: 201,
      body: {
        ...issueOf("new00000-0000-4000-8000-000000000001", 9, "New", S_TODO),
        ...(c.body as object),
      },
    }),
  };
  home = mkdtempSync(join(tmpdir(), "plane-cli-flags-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PLANE_URL", "https://plane.test");
  vi.stubEnv("PLANE_API_TOKEN", "tok");
  vi.stubEnv("PLANE_WORKSPACE", "acme");
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
    const handler = routes[`${call.method} ${call.path}`];
    const reply = handler ? handler(call) : { status: 404, body: { error: `no route ${call.method} ${call.path}` } };
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status ?? 200 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

const ids = () => JSON.parse(out).map((i: { sequence_id: number }) => i.sequence_id);
const writes = () => calls.filter((c) => c.method !== "GET");

describe("issue list groups", () => {
  it("--open keeps backlog, unstarted and started and excludes completed, cancelled and triage", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--open", "--json")).toBe(0);
    expect(ids()).toEqual([1, 2, 3, 7, 8]);
  });

  it("--group is repeatable and ORs the groups, triage included when asked", async () => {
    expect(
      await plane("issue", "list", "--project", "PROJ", "--group", "backlog", "--group", "started", "--json")
    ).toBe(0);
    expect(ids()).toEqual([2, 3, 7]);
    out = "";
    expect(await plane("issue", "list", "--project", "PROJ", "--group", "triage", "--json")).toBe(0);
    expect(ids()).toEqual([6]);
  });

  it("--open plus --group triage includes triage", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--open", "--group", "triage", "--json")).toBe(0);
    expect(ids()).toEqual([1, 2, 3, 6, 7, 8]);
  });

  it("rejects an unknown group before any request beyond setup", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--group", "nope")).toBe(2);
    expect(err).toMatch(/--group must be one of/);
  });

  it("fails when a state group cannot be resolved", async () => {
    items[0]!.state = "ffffffff-0000-4000-8000-000000000000";
    expect(await plane("issue", "list", "--project", "PROJ", "--open")).toBe(1);
    expect(err).toMatch(/unknown state group/);
  });
});

describe("issue list parent and text filters", () => {
  it("--parent keeps children of that work item", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--parent", "PROJ-8", "--json")).toBe(0);
    expect(ids()).toEqual([3, 7]);
  });

  it("--root-only keeps items without a parent; combining with --parent is a usage error", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--root-only", "--json")).toBe(0);
    expect(ids()).toEqual([1, 2, 4, 5, 6, 8]);
    expect(await plane("issue", "list", "--project", "PROJ", "--parent", "PROJ-8", "--root-only")).toBe(2);
    expect(err).toMatch(/use only one of --parent and --root-only/);
  });

  it("--query matches the name or the Markdown description, case-insensitively", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--query", "ERROR", "--json")).toBe(0);
    expect(ids()).toEqual([1]);
    out = "";
    expect(await plane("issue", "list", "--project", "PROJ", "--query", "backLOG", "--json")).toBe(0);
    expect(ids()).toEqual([2]);
    out = "";
    expect(await plane("issue", "list", "--project", "PROJ", "--query", "nothing", "--json")).toBe(0);
    expect(ids()).toEqual([8]);
  });

  it("combines filters with AND", async () => {
    expect(await plane("issue", "list", "--project", "PROJ", "--query", "child", "--group", "started", "--json")).toBe(
      0
    );
    expect(ids()).toEqual([3]);
  });

  it("follows every page before filtering", async () => {
    routes[`GET ${LIST}`] = (c) => {
      if (c.query.get("cursor") === "c1") return { body: { results: [items[0]], next_page_results: false } };
      return { body: { results: items.slice(1), next_page_results: true, next_cursor: "c1" } };
    };
    expect(await plane("issue", "list", "--project", "PROJ", "--query", "login", "--json")).toBe(0);
    expect(ids()).toEqual([1]);
    expect(calls.some((c) => c.path === LIST && c.query.get("cursor") === "c1")).toBe(true);
  });
});

describe("issue parent flags", () => {
  it("create sets a same-project parent and reads its chain", async () => {
    expect(
      await plane("issue", "create", "--project", "PROJ", "--title", "Child", "--parent", "PROJ-8", "--json")
    ).toBe(0);
    expect(writes()[0]!.body).toEqual({ name: "Child", parent: PARENT });
    expect(calls.some((c) => c.method === "GET" && c.path === `${P}/work-items/${PARENT}/`)).toBe(true);
  });

  it("create rejects a parent from another project before writing", async () => {
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "Child", "--parent", "PROJ-9")).toBe(2);
    expect(err).toMatch(/belongs to OTHER/);
    expect(writes()).toHaveLength(0);
  });

  it("create rejects --parent with --clear-parent", async () => {
    expect(
      await plane("issue", "create", "--project", "PROJ", "--title", "Child", "--parent", "PROJ-8", "--clear-parent")
    ).toBe(2);
    expect(err).toMatch(/use only one of --parent and --clear-parent/);
    expect(writes()).toHaveLength(0);
  });

  it("edit sets and clears the parent", async () => {
    expect(await plane("issue", "edit", "PROJ-7", "--parent", "PROJ-8", "--json")).toBe(0);
    expect(writes()[0]!.body).toEqual({ parent: PARENT });
    out = "";
    issue.parent = PARENT;
    expect(await plane("issue", "edit", "PROJ-7", "--clear-parent", "--json")).toBe(0);
    expect(writes()[1]!.body).toEqual({ parent: null });
  });

  it("edit rejects a hierarchy cycle, including making the item its own parent", async () => {
    routes[`GET ${P}/work-items/${PARENT}/`] = () => ({ body: { id: PARENT, parent: IID } });
    expect(await plane("issue", "edit", "PROJ-7", "--parent", "PROJ-8")).toBe(2);
    expect(err).toMatch(/hierarchy cycle/);
    expect(writes()).toHaveLength(0);
    err = "";
    expect(await plane("issue", "edit", "PROJ-7", "--parent", "PROJ-7")).toBe(2);
    expect(err).toMatch(/hierarchy cycle/);
    expect(writes()).toHaveLength(0);
  });

  it("does not write when the parent is unchanged", async () => {
    issue.parent = PARENT;
    expect(await plane("issue", "edit", "PROJ-7", "--parent", "PROJ-8")).toBe(0);
    expect(out).toMatch(/already matches/);
    expect(writes()).toHaveLength(0);
  });
});

describe("issue date flags", () => {
  it("create sends validated dates", async () => {
    expect(
      await plane(
        "issue",
        "create",
        "--project",
        "PROJ",
        "--title",
        "Dated",
        "--start-date",
        "2026-11-01",
        "--target-date",
        "2026-11-07",
        "--json"
      )
    ).toBe(0);
    expect(writes()[0]!.body).toEqual({ name: "Dated", start_date: "2026-11-01", target_date: "2026-11-07" });
  });

  it("create --clear-dates sends nulls", async () => {
    expect(await plane("issue", "create", "--project", "PROJ", "--title", "Dated", "--clear-dates", "--json")).toBe(0);
    expect(writes()[0]!.body).toEqual({ name: "Dated", start_date: null, target_date: null });
  });

  it("rejects bad, reversed and mixed-clear dates before writing", async () => {
    const base = ["issue", "create", "--project", "PROJ", "--title", "t"];
    expect(await plane(...base, "--start-date", "2026-02-30")).toBe(2);
    expect(err).toMatch(/--start-date must be a date, YYYY-MM-DD/);
    err = "";
    expect(await plane(...base, "--target-date", "11/07/2026")).toBe(2);
    expect(err).toMatch(/--target-date must be a date, YYYY-MM-DD/);
    err = "";
    expect(await plane(...base, "--start-date", "2026-11-08", "--target-date", "2026-11-07")).toBe(2);
    expect(err).toMatch(/must not be later than --target-date/);
    err = "";
    expect(await plane(...base, "--clear-dates", "--target-date", "2026-11-07")).toBe(2);
    expect(err).toMatch(/--clear-dates cannot be combined/);
    expect(writes()).toHaveLength(0);
  });

  it("edit sends only changed dates and clears both with --clear-dates", async () => {
    issue.start_date = "2026-11-01";
    issue.target_date = "2026-11-07";
    expect(await plane("issue", "edit", "PROJ-7", "--start-date", "2026-11-02")).toBe(0);
    expect(writes()[0]!.body).toEqual({ start_date: "2026-11-02" });
    expect(out).toMatch(/start date 2026-11-01 -> 2026-11-02/);
    out = "";
    expect(await plane("issue", "edit", "PROJ-7", "--clear-dates")).toBe(0);
    expect(writes()[1]!.body).toEqual({ start_date: null, target_date: null });
    expect(out).toMatch(/start date cleared, target date cleared/);
  });

  it("edit no-ops when the date already matches and rejects invalid input", async () => {
    issue.start_date = "2026-11-01";
    expect(await plane("issue", "edit", "PROJ-7", "--start-date", "2026-11-01")).toBe(0);
    expect(out).toMatch(/already matches/);
    expect(writes()).toHaveLength(0);
    expect(await plane("issue", "edit", "PROJ-7", "--target-date", "2026-13-01")).toBe(2);
    expect(err).toMatch(/YYYY-MM-DD/);
    err = "";
    expect(await plane("issue", "edit", "PROJ-7", "--clear-dates", "--start-date", "2026-11-01")).toBe(2);
    expect(err).toMatch(/--clear-dates cannot be combined/);
    expect(writes()).toHaveLength(0);
  });
});
