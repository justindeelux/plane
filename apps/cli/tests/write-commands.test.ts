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
import { registerLabel } from "../src/commands/label";
import { registerMember } from "../src/commands/member";
import { registerProject } from "../src/commands/project";
import { registerState } from "../src/commands/state";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const LID = "33333333-3333-4333-8333-333333333333";
const WS = "/api/v1/workspaces/acme";

const project = { id: PID, name: "Web App", identifier: "WEB" };
const state = () => ({
  id: SID,
  name: "Todo",
  color: "#808080",
  group: "unstarted",
  default: true,
  sequence: 1,
});
const label = () => ({ id: LID, name: "bug", color: "#ff0000", description: "Something broke" });

type Reply = { status?: number; body?: unknown };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
let routes: Record<string, (u: URL, body?: Record<string, unknown>) => Reply>;
let calls: Call[];
let out: string;
let err: string;
let home: string;

const page = (results: unknown[], next?: string) => ({ results, next_cursor: next, next_page_results: !!next });
const base = `${WS}/projects/${PID}`;

beforeEach(() => {
  routes = {};
  calls = [];
  out = "";
  err = "";
  process.exitCode = undefined;
  home = mkdtempSync(join(tmpdir(), "plane-cli-write-"));
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
    const reply = routes[`${call.method} ${call.path}`]?.(u, call.body);
    const status = reply?.status ?? (reply ? 200 : 404);
    const text = reply?.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(status === 204 ? null : text, { status });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

const plane = async (...args: string[]) => {
  setOutput({ json: args.includes("--json"), quiet: false, debug: false });
  const p = new Command("plane");
  registerProject(p);
  registerState(p);
  registerLabel(p);
  registerMember(p);
  await p.parseAsync(["node", "plane", ...args.filter((a) => a !== "--json")]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { code };
};
const writes = () => calls.filter((c) => c.method !== "GET");

describe("project writes", () => {
  it("create posts fields, reads back, and prints the success line", async () => {
    routes[`POST ${WS}/projects/`] = (_u, body) => ({ status: 201, body: { ...project, ...body } });
    routes[`GET ${WS}/projects/${PID}/`] = () => ({ body: project });
    const { code } = await plane(
      "project",
      "create",
      "--name",
      "Web App",
      "--identifier",
      "WEB",
      "--description",
      "Customer app",
      "--cycles",
      "true"
    );
    expect(code).toBe(0);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toEqual({
      name: "Web App",
      identifier: "WEB",
      description: "Customer app",
      cycle_view: true,
    });
    expect(calls.at(-1)!.method).toBe("GET");
    expect(out).toBe('✓ Created project WEB "Web App"\n');
  });

  it("create --json returns the read-back record", async () => {
    routes[`POST ${WS}/projects/`] = (_u, body) => ({ status: 201, body: { ...project, ...body } });
    routes[`GET ${WS}/projects/${PID}/`] = () => ({ body: { ...project, total_members: 3 } });
    await plane("project", "create", "--name", "Web App", "--identifier", "WEB", "--json");
    expect(JSON.parse(out)).toMatchObject({ ok: true, action: "created", item: { id: PID, total_members: 3 } });
  });

  it("create needs --name and --identifier and sends nothing", async () => {
    expect((await plane("project", "create", "--identifier", "WEB")).code).toBe(2);
    expect(err).toMatch(/--name is required/);
    err = "";
    expect((await plane("project", "create", "--name", "Web App")).code).toBe(2);
    expect(err).toMatch(/--identifier is required/);
    expect(writes()).toHaveLength(0);
  });

  it("edit patches, reads back, and names the changed fields", async () => {
    routes[`GET ${WS}/projects/`] = () => ({ body: page([project]) });
    routes[`PATCH ${base}/`] = (_u, body) => ({ body: { ...project, ...body } });
    routes[`GET ${base}/`] = () => ({ body: { ...project, name: "Web Platform" } });
    const { code } = await plane("project", "edit", "WEB", "--name", "Web Platform");
    expect(code).toBe(0);
    expect(writes()[0]!.body).toEqual({ name: "Web Platform" });
    expect(out).toBe("✓ Updated project WEB: name\n");
  });

  it("edit with no fields is a usage error", async () => {
    routes[`GET ${base}/`] = () => ({ body: project });
    expect((await plane("project", "edit", PID)).code).toBe(2);
    expect(err).toMatch(/no fields given/);
    expect(writes()).toHaveLength(0);
  });

  it("delete needs --yes, then deletes and prints the record", async () => {
    routes[`GET ${WS}/projects/`] = () => ({ body: page([project]) });
    expect((await plane("project", "delete", "WEB")).code).toBe(2);
    expect(err).toMatch(/--yes is required to delete a project/);
    expect(writes()).toHaveLength(0);

    routes[`DELETE ${base}/`] = () => ({ status: 204 });
    expect((await plane("project", "delete", "WEB", "--yes")).code).toBe(0);
    expect(out).toBe(`✓ Deleted project WEB "Web App"\n`);

    out = "";
    routes[`DELETE ${base}/`] = () => ({ status: 204 });
    await plane("project", "delete", "WEB", "--yes", "--json");
    expect(JSON.parse(out)).toMatchObject({ ok: true, action: "deleted", item: { id: PID, deleted: true } });
  });

  it("archive and unarchive check the read-back", async () => {
    routes[`GET ${WS}/projects/`] = () => ({ body: page([project]) });
    routes[`POST ${base}/archive/`] = () => ({ body: { archived_at: "2026-01-01T00:00:00Z" } });
    routes[`GET ${base}/`] = () => ({ body: { ...project, archived_at: "2026-01-01T00:00:00Z" } });
    expect((await plane("project", "archive", "WEB")).code).toBe(0);
    expect(out).toBe('✓ Archived project WEB "Web App"\n');

    out = "";
    routes[`GET ${base}/`] = () => ({ body: project });
    expect((await plane("project", "archive", "WEB")).code).toBe(1);
    expect(err).toMatch(/not confirmed by read-back/);

    routes[`DELETE ${base}/archive/`] = () => ({ status: 204 });
    expect((await plane("project", "unarchive", "WEB")).code).toBe(0);
    expect(out).toBe('✓ Unarchived project WEB "Web App"\n');
  });
});

describe("state commands", () => {
  beforeEach(() => {
    routes[`GET ${WS}/projects/`] = () => ({ body: page([project]) });
  });

  it("list prints a table", async () => {
    routes[`GET ${base}/states/`] = () => ({ body: page([state()]) });
    expect((await plane("state", "list", "--project", "WEB")).code).toBe(0);
    expect(out).toBe(`NAME\tGROUP\tCOLOR\tDEFAULT\tID\nTodo\tunstarted\t#808080\tyes\t${SID}\n`);
  });

  it("view resolves a name and shows the description", async () => {
    routes[`GET ${base}/states/`] = () => ({ body: page([{ ...state(), description: "Where work starts" }]) });
    await plane("state", "view", "todo", "--project", "WEB");
    expect(out).toContain("Todo");
    expect(out).toContain("group:");
    expect(out).toContain("Where work starts");
  });

  it("create validates flags, posts, and reads back", async () => {
    let created = state();
    routes[`POST ${base}/states/`] = (_u, body) => ({ status: 201, body: (created = { ...created, ...body }) });
    routes[`GET ${base}/states/${SID}/`] = () => ({ body: created });

    expect((await plane("state", "create", "--project", "WEB", "--name", "Review")).code).toBe(2);
    expect(err).toMatch(/--color is required/);
    err = "";
    expect((await plane("state", "create", "--project", "WEB", "--name", "Review", "--color", "#f59e0b")).code).toBe(2);
    expect(err).toMatch(/--group is required/);
    err = "";
    expect(
      (await plane("state", "create", "--project", "WEB", "--name", "Review", "--color", "#f59e0b", "--group", "nope"))
        .code
    ).toBe(2);
    expect(err).toMatch(/--group must be one of/);

    const { code } = await plane(
      "state",
      "create",
      "--project",
      "WEB",
      "--name",
      "Review",
      "--color",
      "#f59e0b",
      "--group",
      "started",
      "--default",
      "true"
    );
    expect(code).toBe(0);
    expect(writes().at(-1)!.body).toEqual({
      name: "Review",
      color: "#f59e0b",
      group: "started",
      default: true,
    });
    expect(out).toBe('✓ Created state "Review" in WEB\n');
  });

  it("edit patches and delete requires --yes", async () => {
    let current = state();
    routes[`PATCH ${base}/states/${SID}/`] = (_u, body) => ({ body: (current = { ...current, ...body }) });
    routes[`GET ${base}/states/${SID}/`] = () => ({ body: current });
    routes[`DELETE ${base}/states/${SID}/`] = () => ({ status: 204 });

    expect((await plane("state", "edit", SID, "--project", "WEB", "--color", "#000000")).code).toBe(0);
    expect(out).toBe('✓ Updated state "Todo": color\n');

    out = "";
    expect((await plane("state", "delete", SID, "--project", "WEB")).code).toBe(2);
    expect(err).toMatch(/--yes is required to delete a state/);
    out = "";
    expect((await plane("state", "delete", SID, "--project", "WEB", "--yes")).code).toBe(0);
    expect(out).toBe('✓ Deleted state "Todo"\n');
  });

  it("view unknown name -> exit 4 with available names", async () => {
    routes[`GET ${base}/states/`] = () => ({ body: page([state()]) });
    expect((await plane("state", "view", "zzz", "--project", "WEB")).code).toBe(4);
    expect(err).toMatch(/state "zzz" not found; available: Todo/);
  });
});

describe("label commands", () => {
  beforeEach(() => {
    routes[`GET ${WS}/projects/`] = () => ({ body: page([project]) });
  });

  it("list and view", async () => {
    routes[`GET ${base}/labels/`] = () => ({ body: page([label()]) });
    await plane("label", "list", "--project", "WEB");
    expect(out).toBe(`NAME\tCOLOR\tID\nbug\t#ff0000\t${LID}\n`);
    out = "";
    await plane("label", "view", "Bug", "--project", "WEB");
    expect(out).toContain("Something broke");
  });

  it("create, edit and delete", async () => {
    let current = label();
    routes[`POST ${base}/labels/`] = (_u, body) => ({ status: 201, body: (current = { ...current, ...body }) });
    routes[`GET ${base}/labels/${LID}/`] = () => ({ body: current });
    routes[`PATCH ${base}/labels/${LID}/`] = (_u, body) => ({ body: (current = { ...current, ...body }) });
    routes[`DELETE ${base}/labels/${LID}/`] = () => ({ status: 204 });

    expect((await plane("label", "create", "--project", "WEB", "--name", "bug")).code).toBe(2);
    expect(err).toMatch(/--color is required/);

    out = "";
    await plane("label", "create", "--project", "WEB", "--name", "bug", "--color", "#ff0000");
    expect(writes().at(-1)!.body).toEqual({ name: "bug", color: "#ff0000" });
    expect(out).toBe('✓ Created label "bug" in WEB\n');

    out = "";
    await plane("label", "edit", LID, "--project", "WEB", "--name", "defect");
    expect(out).toBe('✓ Updated label "defect": name\n');

    out = "";
    await plane("label", "delete", LID, "--project", "WEB", "--yes");
    expect(out).toBe('✓ Deleted label "defect"\n');
  });
});

describe("member commands", () => {
  it("list prints display names and emails", async () => {
    routes[`GET ${WS}/projects/`] = () => ({ body: page([project]) });
    routes[`GET ${base}/members/`] = () => ({
      body: [
        { id: "u1", display_name: "ann", email: "ann@example.com" },
        { id: "u2", first_name: "Bob", last_name: "Lee", email: "bob@example.com" },
      ],
    });
    expect((await plane("member", "list", "--project", "WEB")).code).toBe(0);
    expect(out).toBe("NAME\tEMAIL\tID\nann\tann@example.com\tu1\nBob Lee\tbob@example.com\tu2\n");
  });
});
