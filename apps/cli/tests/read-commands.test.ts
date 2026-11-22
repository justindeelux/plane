/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCycle } from "../src/commands/cycle";
import { registerModule } from "../src/commands/module";
import { registerProject } from "../src/commands/project";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const MID = "33333333-3333-4333-8333-333333333333";
const WS = "/api/v1/workspaces/acme";
const proj = { id: PID, name: "Web App", identifier: "WEB", total_members: 3, total_cycles: 1, total_modules: 2 };
const cycle = (extra = {}) => ({
  id: CID,
  name: "Sprint 1",
  start_date: "2020-01-01",
  end_date: "2020-01-14",
  total_issues: 4,
  completed_issues: 1,
  ...extra,
});
const mod = {
  id: MID,
  name: "Auth",
  status: "in-progress",
  total_issues: 2,
  completed_issues: 0,
  description_html: "<p>Hello <strong>world</strong></p>",
};
const issue = (n: number) => ({ id: `i${n}`, sequence_id: n, name: `Issue ${n}`, state: { name: "Todo" } });

type Routes = Record<string, (url: URL) => unknown>;
let routes: Routes;
let calls: string[];
let out: string;
let err: string;
let home: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, statusText: status === 404 ? "Not Found" : "OK" });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plane-cli-read-"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("PLANE_URL", "https://plane.test");
  vi.stubEnv("PLANE_API_TOKEN", "tok");
  vi.stubEnv("PLANE_WORKSPACE", "acme");
  routes = {};
  calls = [];
  out = "";
  err = "";
  process.exitCode = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(u);
      calls.push(url.pathname + url.search);
      const r = routes[url.pathname];
      return r ? json(r(url)) : json({ error: "Not found." }, 404);
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
  process.exitCode = undefined;
});

const plane = async (...args: string[]) => {
  setOutput({ json: args.includes("--json"), quiet: false, debug: false });
  const p = new Command("plane");
  registerProject(p);
  registerCycle(p);
  registerModule(p);
  await p.parseAsync(["node", "plane", ...args.filter((a) => a !== "--json")]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { code };
};
const page = (results: unknown[], next?: string) => ({ results, next_cursor: next, next_page_results: !!next });

describe("project", () => {
  it("list prints rows; --json prints the raw array", async () => {
    routes[`${WS}/projects/`] = () => page([proj]);
    expect((await plane("project", "list")).code).toBe(0);
    expect(out).toContain("WEB\tWeb App\t" + PID);
    out = "";
    await plane("project", "list", "--json");
    expect(JSON.parse(out)).toEqual([proj]);
  });

  it("list follows pagination", async () => {
    routes[`${WS}/projects/`] = (u) =>
      u.searchParams.get("cursor") ? page([{ ...proj, identifier: "B" }]) : page([proj], "c2");
    await plane("project", "list", "--json");
    expect(JSON.parse(out)).toHaveLength(2);
  });

  it("empty list says so, never blank", async () => {
    routes[`${WS}/projects/`] = () => page([]);
    await plane("project", "list");
    expect(out).toBe("No projects match\n");
    out = "";
    await plane("project", "list", "--json");
    expect(JSON.parse(out)).toEqual([]);
  });

  it.each(["web", "Web App", PID])("view resolves project by %s", async (ref) => {
    routes[`${WS}/projects/`] = () => page([proj]);
    routes[`${WS}/projects/${PID}/`] = () => proj;
    expect((await plane("project", "view", ref)).code).toBe(0);
    expect(out).toContain("Web App (WEB)");
    expect(out).toContain("members:");
  });

  it("view unknown name -> exit 4 with hint, stderr ✗", async () => {
    routes[`${WS}/projects/`] = () => page([proj]);
    expect((await plane("project", "view", "nope")).code).toBe(4);
    expect(err).toMatch(/^✗ project "nope" not found; available: WEB \(Web App\)/);
    expect(out).toBe("");
  });

  it("view unknown uuid -> 404 exit 4; --json error envelope", async () => {
    expect((await plane("project", "view", PID, "--json")).code).toBe(4);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { status: 404 } });
  });

  it("auth failure -> exit 3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "bad" }, 401))
    );
    expect((await plane("project", "list")).code).toBe(3);
    expect(err).toMatch(/^✗ 401/);
  });

  it("view --json adds description_markdown from HTML", async () => {
    routes[`${WS}/projects/`] = () => page([proj]);
    routes[`${WS}/projects/${PID}/`] = () => ({ ...proj, description_html: "<p>Hi <em>there</em></p>" });
    await plane("project", "view", "WEB", "--json");
    const j = JSON.parse(out);
    expect(j.description_html).toBe("<p>Hi <em>there</em></p>");
    expect(j.description_markdown).toBe("Hi _there_");
  });

  it("missing workspace is a usage error (exit 2)", async () => {
    vi.stubEnv("PLANE_WORKSPACE", "");
    expect((await plane("project", "list")).code).toBe(2);
    expect(err).toMatch(/no workspace set/);
  });

  it("--workspace overrides the configured one", async () => {
    routes["/api/v1/workspaces/other/projects/"] = () => page([]);
    await plane("project", "list", "--workspace", "other");
    expect(out).toBe("No projects match\n");
  });
});

describe("cycle", () => {
  const base = `${WS}/projects/${PID}/cycles/`;
  beforeEach(() => {
    routes[`${WS}/projects/`] = () => page([proj]);
  });

  it("list shows derived status and counts", async () => {
    routes[base] = () => page([cycle(), cycle({ id: "x", name: "Draft", start_date: null, end_date: null })]);
    await plane("cycle", "list", "--project", "WEB");
    expect(out).toContain("Sprint 1\tcompleted\t2020-01-01\t2020-01-14\t1/4\t" + CID);
    expect(out).toContain("Draft\tdraft");
  });

  it("list uses configured project and passes --status as cycle_view", async () => {
    vi.stubEnv("PLANE_URL", "https://plane.test");
    routes[base] = () => page([cycle()]);
    await plane("cycle", "list", "--project", "web", "--status", "completed");
    expect(calls.at(-1)).toContain("cycle_view=completed");
  });

  it("current status handles the bare-array response", async () => {
    routes[base] = () => [cycle({ end_date: "2999-01-01" })];
    await plane("cycle", "list", "--project", "WEB", "--status", "current", "--json");
    expect(JSON.parse(out)).toHaveLength(1);
  });

  it("empty and bad --status", async () => {
    routes[base] = () => page([]);
    await plane("cycle", "list", "--project", "WEB");
    expect(out).toBe("No cycles match\n");
    expect((await plane("cycle", "list", "--project", "WEB", "--status", "weird")).code).toBe(2);
  });

  it("no project -> usage error", async () => {
    expect((await plane("cycle", "list")).code).toBe(2);
    expect(err).toMatch(/no project set/);
  });

  it("view by name with --issues paginates and shows ids/state", async () => {
    routes[base] = () => page([cycle()]);
    routes[`${base}${CID}/cycle-issues/`] = (u) =>
      u.searchParams.get("cursor") ? page([issue(2)]) : page([issue(1)], "n");
    expect((await plane("cycle", "view", "sprint 1", "--project", "WEB", "--issues")).code).toBe(0);
    expect(out).toContain("Sprint 1");
    expect(out).toContain("WEB-1\tIssue 1\tTodo");
    expect(out).toContain("WEB-2\tIssue 2\tTodo");
    expect(calls.some((c) => c.includes("expand=state"))).toBe(true);
  });

  it("view --issues with none, and --limit", async () => {
    routes[`${base}${CID}/`] = () => cycle();
    routes[`${base}${CID}/cycle-issues/`] = () => page([]);
    await plane("cycle", "view", CID, "--project", "WEB", "--issues");
    expect(out).toContain("No issues in this cycle");
    routes[`${base}${CID}/cycle-issues/`] = () => page([issue(1), issue(2), issue(3)]);
    out = "";
    await plane("cycle", "view", CID, "--project", "WEB", "--issues", "--limit", "2", "--json");
    expect(JSON.parse(out).issues).toHaveLength(2);
  });

  it("view unknown name -> exit 4 with available names", async () => {
    routes[base] = () => page([cycle()]);
    expect((await plane("cycle", "view", "zzz", "--project", "WEB")).code).toBe(4);
    expect(err).toMatch(/cycle "zzz" not found; available: Sprint 1/);
  });
});

describe("module", () => {
  const base = `${WS}/projects/${PID}/modules/`;
  beforeEach(() => {
    routes[`${WS}/projects/`] = () => page([proj]);
  });

  it("list, empty, json", async () => {
    routes[base] = () => page([mod]);
    await plane("module", "list", "--project", "WEB");
    expect(out).toContain("Auth\tin-progress");
    routes[base] = () => page([]);
    out = "";
    await plane("module", "list", "--project", "WEB");
    expect(out).toBe("No modules match\n");
    out = "";
    await plane("module", "list", "--project", "WEB", "--json");
    expect(JSON.parse(out)).toEqual([]);
  });

  it("view renders HTML description as Markdown; --json has both", async () => {
    routes[base] = () => page([mod]);
    await plane("module", "view", "auth", "--project", "WEB");
    expect(out).toContain("Hello **world**");
    out = "";
    await plane("module", "view", "Auth", "--project", "WEB", "--json");
    expect(JSON.parse(out)).toMatchObject({
      description_markdown: "Hello **world**",
      description_html: mod.description_html,
    });
  });

  it("view --issues and not found", async () => {
    routes[`${base}${MID}/`] = () => mod;
    routes[`${base}${MID}/module-issues/`] = () => page([issue(7)]);
    await plane("module", "view", MID, "--project", "WEB", "--issues");
    expect(out).toContain("WEB-7\tIssue 7\tTodo");
    expect((await plane("module", "view", "44444444-4444-4444-8444-444444444444", "--project", "WEB")).code).toBe(4);
    expect(err).toMatch(/^✗ 404/);
  });
});
