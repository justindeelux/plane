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
import { registerCycle } from "../src/commands/cycle";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const CID2 = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";
const U_OWNER = "cccccccc-0000-4000-8000-000000000001";
const IID = "dddddddd-0000-4000-8000-000000000001";
const W = "/api/v1/workspaces/acme";
const P = `${W}/projects/${PID}`;

const proj = { id: PID, name: "Web App", identifier: "WEB" };
const issue = { id: IID, sequence_id: 7, name: "Issue 7", state: { name: "Todo" } };
const baseCycle = () => ({
  id: CID,
  name: "Sprint 1",
  start_date: "2020-01-01" as string | null,
  end_date: "2020-01-14" as string | null,
  owned_by: U_OWNER,
  description: "notes",
  archived_at: null as string | null,
});

type Reply = { status?: number; body?: unknown };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
type Override = Reply | ((c: Call) => Reply);

let calls: Call[];
let cycle: ReturnType<typeof baseCycle>;
let created: Record<string, unknown>;
let overrides: Record<string, Override>;
let out: string;
let err: string;
let home: string;

const page = (results: unknown[], next?: string) => ({ results, next_cursor: next, next_page_results: !!next });

const api = (c: Call): Reply => {
  const key = `${c.method} ${c.path}`;
  const o = overrides[key];
  if (o) return typeof o === "function" ? o(c) : o;
  switch (key) {
    case `GET ${W}/projects/`:
      return { body: page([proj]) };
    case `GET ${P}/cycles/`:
      return { body: page([cycle, { ...baseCycle(), id: CID2, name: "Sprint 2" }]) };
    case `GET ${P}/cycles/${CID}/`:
      return { body: cycle };
    case `GET ${P}/cycles/${CID2}/`:
      return { body: { ...baseCycle(), id: CID2, name: "Sprint 2" } };
    case `POST ${P}/cycles/`:
      created = { ...cycle, ...(c.body as object), id: NEW };
      return { status: 201, body: created };
    case `GET ${P}/cycles/${NEW}/`:
      return { body: created };
    case `PATCH ${P}/cycles/${CID}/`:
      cycle = { ...cycle, ...(c.body as object) };
      return { body: cycle };
    case `GET ${P}/archived-cycles/`:
      return { body: page([]) };
    case `POST ${P}/cycles/${CID}/archive/`:
      return { status: 204 };
    case `DELETE ${P}/archived-cycles/${CID}/unarchive/`:
      return { status: 204 };
    case `POST ${P}/cycles/${CID}/transfer-issues/`:
      return { status: 201, body: {} };
    case `GET ${P}/cycles/${CID}/cycle-issues/`:
      return { body: page([issue]) };
    case `GET ${P}/cycles/${CID2}/cycle-issues/`:
      return { body: page([]) };
    case `POST ${P}/cycles/${CID}/cycle-issues/`:
      return { status: 201, body: {} };
    case `GET ${P}/cycles/${CID}/cycle-issues/${IID}/`:
      return { body: {} };
    case `DELETE ${P}/cycles/${CID}/cycle-issues/${IID}/`:
      return { status: 204 };
    case `GET ${W}/work-items/WEB-7/`:
      return { body: { id: IID, project: PID } };
  }
  return { status: 404, body: { error: `no route ${key}` } };
};

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
  registerCycle(program);
  process.exitCode = 0;
  await program.parseAsync(["node", "plane", ...args]);
  return Number(process.exitCode ?? 0);
};

beforeEach(() => {
  calls = [];
  cycle = baseCycle();
  created = {};
  overrides = {};
  out = "";
  err = "";
  home = mkdtempSync(join(tmpdir(), "plane-cli-cycle-"));
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
    const r = api(call);
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(r.status === 204 ? null : text, { status: r.status ?? 200 });
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
const has = (method: string, path: string) => calls.some((c) => c.method === method && c.path === path);

describe("cycle list --archived", () => {
  it("reads the archived-cycles endpoint and marks rows archived", async () => {
    overrides[`GET ${P}/archived-cycles/`] = { body: page([{ ...cycle, archived_at: "2026-01-01T00:00:00Z" }]) };
    expect(await plane("cycle", "list", "--project", "WEB", "--archived")).toBe(0);
    expect(out).toContain(`Sprint 1\tarchived\t2020-01-01\t2020-01-14\t0/0\t${CID}`);
    expect(has("GET", `${P}/archived-cycles/`)).toBe(true);
  });
});

describe("cycle create", () => {
  it("posts the fields, reads the cycle back and prints the success line", async () => {
    const code = await plane(
      "cycle",
      "create",
      "--project",
      "WEB",
      "--name",
      "Sprint 2",
      "--description",
      "plan",
      "--start-date",
      "2026-01-01",
      "--end-date",
      "2026-01-14"
    );
    expect(code).toBe(0);
    expect(out).toBe(`✓ Created cycle "Sprint 2" ${NEW}\n`);
    expect(writes()[0]!.body).toEqual({
      name: "Sprint 2",
      description: "plan",
      start_date: "2026-01-01",
      end_date: "2026-01-14",
    });
    expect(has("GET", `${P}/cycles/${NEW}/`)).toBe(true);
  });

  it("--json envelope", async () => {
    await plane("cycle", "create", "--project", "WEB", "--name", "Sprint 2", "--json");
    expect(JSON.parse(out)).toMatchObject({ ok: true, action: "created", item: { id: NEW, name: "Sprint 2" } });
  });

  it("rejects a missing name, bad dates and a non-uuid owner before writing", async () => {
    expect(await plane("cycle", "create", "--project", "WEB")).toBe(2);
    expect(err).toMatch(/--name is required/);
    expect(await plane("cycle", "create", "--project", "WEB", "--name", "x", "--start-date", "2026-02-31")).toBe(2);
    expect(err).toMatch(/--start-date must be a date/);
    expect(
      await plane(
        "cycle",
        "create",
        "--project",
        "WEB",
        "--name",
        "x",
        "--start-date",
        "2026-02-10",
        "--end-date",
        "2026-02-01"
      )
    ).toBe(2);
    expect(err).toMatch(/must not be later/);
    expect(await plane("cycle", "create", "--project", "WEB", "--name", "x", "--owned-by", "nope")).toBe(2);
    expect(err).toMatch(/--owned-by must be a user uuid/);
    expect(writes()).toHaveLength(0);
  });

  it("empty and malformed 201 responses are failures", async () => {
    overrides[`POST ${P}/cycles/`] = { status: 201 };
    expect(await plane("cycle", "create", "--project", "WEB", "--name", "x")).toBe(1);
    expect(err).toMatch(/empty 201 response/);
    err = "";
    overrides[`POST ${P}/cycles/`] = { status: 201, body: {} };
    expect(await plane("cycle", "create", "--project", "WEB", "--name", "x")).toBe(1);
    expect(err).toMatch(/malformed/);
  });
});

describe("cycle edit", () => {
  it("patches the given fields, keeps the current owner, and reads back", async () => {
    expect(
      await plane("cycle", "edit", "Sprint 1", "--project", "WEB", "--name", "Sprint 1b", "--start-date", "2020-01-02")
    ).toBe(0);
    expect(out).toBe(`✓ Updated cycle "Sprint 1b" ${CID}\n`);
    expect(writes()[0]!.body).toEqual({ name: "Sprint 1b", start_date: "2020-01-02", owned_by: U_OWNER });
  });

  it("requires at least one field", async () => {
    expect(await plane("cycle", "edit", "Sprint 1", "--project", "WEB")).toBe(2);
    expect(err).toMatch(/no fields given/);
    expect(writes()).toHaveLength(0);
  });

  it("checks the new end date against the stored start date", async () => {
    expect(await plane("cycle", "edit", "Sprint 1", "--project", "WEB", "--end-date", "2019-12-01")).toBe(2);
    expect(err).toMatch(/must not be later/);
    expect(writes()).toHaveLength(0);
  });

  it("unknown name -> exit 4", async () => {
    expect(await plane("cycle", "edit", "zzz", "--project", "WEB", "--name", "x")).toBe(4);
    expect(err).toMatch(/cycle "zzz" not found/);
  });

  it("reports fields the server did not apply, and empty responses fail", async () => {
    overrides[`PATCH ${P}/cycles/${CID}/`] = { body: { ...cycle } };
    expect(await plane("cycle", "edit", "Sprint 1", "--project", "WEB", "--name", "x")).toBe(1);
    expect(err).toMatch(/server did not apply name/);
    err = "";
    overrides[`PATCH ${P}/cycles/${CID}/`] = { status: 200 };
    expect(await plane("cycle", "edit", "Sprint 1", "--project", "WEB", "--name", "x")).toBe(1);
    expect(err).toMatch(/empty 200 response/);
  });
});

describe("cycle delete", () => {
  it("requires --yes and sends no request without it", async () => {
    expect(await plane("cycle", "delete", "Sprint 1", "--project", "WEB")).toBe(2);
    expect(err).toMatch(/requires --yes/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes with --yes and reports it", async () => {
    overrides[`DELETE ${P}/cycles/${CID}/`] = { status: 204 };
    expect(await plane("cycle", "delete", "Sprint 1", "--project", "WEB", "--yes")).toBe(0);
    expect(out).toBe(`✓ Deleted cycle "Sprint 1" ${CID}\n`);
    expect(has("DELETE", `${P}/cycles/${CID}/`)).toBe(true);
  });

  it("--json returns the deleted marker", async () => {
    overrides[`DELETE ${P}/cycles/${CID}/`] = { status: 204 };
    await plane("cycle", "delete", CID, "--project", "WEB", "--yes", "--json");
    expect(JSON.parse(out)).toMatchObject({ ok: true, action: "deleted", item: { id: CID, deleted: true } });
  });
});

describe("cycle complete", () => {
  it("refuses a cycle that has not started", async () => {
    cycle.start_date = "2999-01-01";
    expect(await plane("cycle", "complete", CID, "--project", "WEB")).toBe(2);
    expect(err).toMatch(/in the future/);
    expect(writes()).toHaveLength(0);
  });

  it("ends the cycle now, keeps the owner, and verifies the read-back", async () => {
    expect(await plane("cycle", "complete", CID, "--project", "WEB")).toBe(0);
    const body = writes()[0]!.body!;
    expect(body.owned_by).toBe(U_OWNER);
    expect(Math.abs(Date.parse(body.end_date as string) - Date.now())).toBeLessThan(10_000);
    expect(out).toMatch(/^✓ Completed cycle "Sprint 1" \(ended /);
  });

  it("empty responses fail", async () => {
    overrides[`PATCH ${P}/cycles/${CID}/`] = { status: 200 };
    expect(await plane("cycle", "complete", CID, "--project", "WEB")).toBe(1);
    expect(err).toMatch(/empty 200 response/);
  });
});

describe("cycle archive / unarchive", () => {
  it("archives and confirms through the archived list", async () => {
    overrides[`GET ${P}/archived-cycles/`] = { body: page([{ ...cycle, archived_at: "2026-01-01T00:00:00Z" }]) };
    expect(await plane("cycle", "archive", "Sprint 1", "--project", "WEB")).toBe(0);
    expect(out).toBe(`✓ Archived cycle "Sprint 1" ${CID}\n`);
    expect(has("POST", `${P}/cycles/${CID}/archive/`)).toBe(true);
  });

  it("fails when the archived read-back does not confirm the change", async () => {
    expect(await plane("cycle", "archive", "Sprint 1", "--project", "WEB")).toBe(1);
    expect(err).toMatch(/not confirmed/);
  });

  it("unarchives by name and confirms through the cycle detail", async () => {
    overrides[`GET ${P}/archived-cycles/`] = {
      body: page([{ ...cycle, name: "Old", archived_at: "2026-01-01T00:00:00Z" }]),
    };
    cycle = { ...cycle, name: "Old", archived_at: null };
    expect(await plane("cycle", "unarchive", "Old", "--project", "WEB")).toBe(0);
    expect(out).toBe(`✓ Unarchived cycle "Old" ${CID}\n`);
    expect(has("DELETE", `${P}/archived-cycles/${CID}/unarchive/`)).toBe(true);
  });

  it("unarchive of an unknown archived name -> exit 4", async () => {
    expect(await plane("cycle", "unarchive", "Old", "--project", "WEB")).toBe(4);
    expect(err).toMatch(/archived cycle "Old" not found/);
  });
});

describe("cycle transfer", () => {
  it("moves issues and reports both cycle sizes", async () => {
    expect(await plane("cycle", "transfer", "Sprint 1", "--project", "WEB", "--to", "Sprint 2")).toBe(0);
    expect(out).toBe(`✓ Transferred issues from "Sprint 1" to "Sprint 2" (1 in source, 0 in destination)\n`);
    expect(writes()[0]!.body).toEqual({ new_cycle_id: CID2 });
  });

  it("rejects the same source and destination, and a missing --to", async () => {
    expect(await plane("cycle", "transfer", CID, "--project", "WEB", "--to", CID)).toBe(2);
    expect(err).toMatch(/must be different/);
    expect(await plane("cycle", "transfer", CID, "--project", "WEB")).toBe(2);
    expect(err).toMatch(/--to is required/);
    expect(writes()).toHaveLength(0);
  });
});

describe("cycle issues", () => {
  it("prints the table and --json returns the raw items", async () => {
    expect(await plane("cycle", "issues", "Sprint 1", "--project", "WEB")).toBe(0);
    expect(out).toBe("ID\tTITLE\tSTATE\nWEB-7\tIssue 7\tTodo\n");
    out = "";
    await plane("cycle", "issues", CID, "--project", "WEB", "--json");
    expect(JSON.parse(out)).toEqual([issue]);
  });

  it("says so when the cycle is empty", async () => {
    overrides[`GET ${P}/cycles/${CID}/cycle-issues/`] = { body: page([]) };
    await plane("cycle", "issues", CID, "--project", "WEB");
    expect(out).toBe("No issues match\n");
  });

  it("adds an item, confirms the link by read-back, and requires --issue", async () => {
    expect(await plane("cycle", "add-issue", "Sprint 1", "--project", "WEB", "--issue", "WEB-7")).toBe(0);
    expect(out).toBe(`✓ Added WEB-7 to cycle "Sprint 1"\n`);
    expect(writes()[0]!.body).toEqual({ issues: [IID] });
    expect(has("GET", `${P}/cycles/${CID}/cycle-issues/${IID}/`)).toBe(true);
    expect(await plane("cycle", "add-issue", "Sprint 1", "--project", "WEB")).toBe(2);
    expect(err).toMatch(/--issue is required/);
  });

  it("reports a failed add read-back and a cross-project item", async () => {
    overrides[`GET ${P}/cycles/${CID}/cycle-issues/${IID}/`] = { status: 404, body: { error: "nope" } };
    expect(await plane("cycle", "add-issue", "Sprint 1", "--project", "WEB", "--issue", "WEB-7")).toBe(1);
    expect(err).toMatch(/read-back failed/);
    err = "";
    overrides[`GET ${W}/work-items/WEB-7/`] = { body: { id: IID, project: "other" } };
    expect(await plane("cycle", "add-issue", "Sprint 1", "--project", "WEB", "--issue", "WEB-7")).toBe(2);
    expect(err).toMatch(/different project/);
  });

  it("removes an item", async () => {
    expect(await plane("cycle", "remove-issue", "Sprint 1", "--project", "WEB", "--issue", "WEB-7")).toBe(0);
    expect(out).toBe(`✓ Removed WEB-7 from cycle "Sprint 1"\n`);
    expect(has("DELETE", `${P}/cycles/${CID}/cycle-issues/${IID}/`)).toBe(true);
  });
});
