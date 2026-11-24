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
import { registerActivity } from "../src/commands/activity";
import { registerComment } from "../src/commands/comment";
import { registerDependency } from "../src/commands/dependency";
import { registerIssue } from "../src/commands/issue";
import { registerLink } from "../src/commands/link";
import { setOutput } from "../src/output";

const PID = "11111111-1111-4111-8111-111111111111";
const IID = "22222222-2222-4222-8222-222222222222";
const IID2 = "33333333-3333-4333-8333-333333333333";
const CID = "44444444-4444-4444-8444-444444444444";
const LID = "55555555-5555-4555-8555-555555555555";
const AID = "66666666-6666-4666-8666-666666666666";
const U_ANN = "cccccccc-0000-4000-8000-000000000002";

const W = "/api/v1/workspaces/acme";
const P = `${W}/projects/${PID}`;
const COMMENTS = `${P}/work-items/${IID}/comments`;
const RELATIONS = `${P}/work-items/${IID}/relations`;
const LINKS = `${P}/work-items/${IID}/links`;
const ACTIVITIES = `${P}/work-items/${IID}/activities`;

const project = { id: PID, identifier: "PROJ", name: "Project" };
const issue = (id: string, sequence_id: number, name: string) => ({
  id,
  name,
  sequence_id,
  project: PID,
  description_html: "<p>body</p>",
});
const issue1 = issue(IID, 7, "Fix login");
const issue2 = issue(IID2, 8, "Other");

type Reply = { status?: number; body?: unknown; text?: string };
type Call = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
type Handler = (c: Call) => Reply;

let calls: Call[];
let out: string;
let err: string;
let home: string;
let comments: Array<Record<string, unknown>>;
let activities: Array<Record<string, unknown>>;
let links: Array<Record<string, unknown>>;
let relations: Record<string, Array<{ project_id: string; issue_id: string }>>;
let routes: Record<string, Handler>;

const page = (results: unknown[]) => ({ results, next_page_results: false });
const emptyRelations = () => ({
  blocking: [],
  blocked_by: [],
  duplicate: [],
  relates_to: [],
  start_before: [],
  start_after: [],
  finish_before: [],
  finish_after: [],
});

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
  registerComment(program);
  registerDependency(program);
  registerLink(program);
  registerActivity(program);
  process.exitCode = 0;
  await program.parseAsync(["node", "plane", ...args]);
  return Number(process.exitCode ?? 0);
};

beforeEach(() => {
  calls = [];
  out = "";
  err = "";
  comments = [
    {
      id: CID,
      comment_html: "<p>hello <strong>world</strong></p>",
      actor: U_ANN,
      created_at: "2026-01-02T03:04:05Z",
      edited_at: null,
    },
  ];
  activities = [
    {
      id: AID,
      verb: "updated",
      field: "priority",
      old_value: "low",
      new_value: "high",
      actor: U_ANN,
      created_at: "2026-01-02T03:04:05Z",
    },
  ];
  links = [{ id: LID, title: "Docs", url: "https://example.com/docs", created_at: "2026-01-02T03:04:05Z" }];
  relations = emptyRelations();
  routes = {
    [`GET ${W}/projects/`]: () => ({ body: page([project]) }),
    [`GET ${P}/`]: () => ({ body: project }),
    [`GET ${W}/work-items/PROJ-7/`]: () => ({ body: issue1 }),
    [`GET ${W}/work-items/PROJ-8/`]: () => ({ body: issue2 }),
    [`GET ${P}/members/`]: () => ({ body: [{ id: U_ANN, display_name: "ann" }] }),
    [`GET ${COMMENTS}/`]: () => ({ body: page(comments) }),
    [`GET ${COMMENTS}/${CID}/`]: () => ({ body: comments[0] }),
    [`PATCH ${COMMENTS}/${CID}/`]: (c) => {
      comments[0] = { ...comments[0], ...(c.body as object), edited_at: "2026-01-03T00:00:00Z" };
      return { body: comments[0] };
    },
    [`DELETE ${COMMENTS}/${CID}/`]: () => ({ status: 204 }),
    [`GET ${RELATIONS}/`]: () => ({ body: relations }),
    [`GET ${P}/work-items/${IID2}/relations/`]: () => ({ body: emptyRelations() }),
    [`POST ${RELATIONS}/`]: (c) => {
      const body = c.body as { relation_type: string; issues: string[] };
      relations[body.relation_type] = [
        ...(relations[body.relation_type] ?? []),
        { project_id: PID, issue_id: body.issues[0]! },
      ];
      return { status: 201, body: [{ id: "relation" }] };
    },
    [`GET ${LINKS}/`]: () => ({ body: page(links) }),
    [`GET ${LINKS}/${LID}/`]: () => ({ body: links[0] }),
    [`POST ${LINKS}/`]: (c) => {
      const body = c.body as { url: string; title?: string };
      links = [{ id: LID, url: body.url, title: body.title ?? "", created_at: "2026-01-02T03:04:05Z" }];
      return { status: 201, body: links[0] };
    },
    [`PATCH ${LINKS}/${LID}/`]: (c) => {
      links[0] = { ...links[0], ...(c.body as object) };
      return { body: links[0] };
    },
    [`DELETE ${LINKS}/${LID}/`]: () => {
      links = [];
      return { status: 204 };
    },
    [`GET ${ACTIVITIES}/`]: () => ({ body: page(activities) }),
    [`DELETE ${P}/work-items/${IID}/`]: () => ({ status: 204 }),
  };
  home = mkdtempSync(join(tmpdir(), "plane-cli-extras-"));
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
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(status === 204 ? null : text, { status });
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

describe("issue delete", () => {
  it("requires --yes and deletes only then", async () => {
    expect(await plane("issue", "delete", "PROJ-7")).toBe(2);
    expect(err).toMatch(/--yes/);
    expect(writes()).toHaveLength(0);
    err = "";
    expect(await plane("issue", "delete", "PROJ-7", "--yes")).toBe(0);
    expect(out).toBe("✓ Deleted PROJ-7\n");
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${P}/work-items/${IID}/`)).toBe(true);
  });

  it("--json returns the deleted envelope", async () => {
    expect(await plane("issue", "delete", "PROJ-7", "--yes", "--json")).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      action: "deleted",
      item: { identifier: "PROJ-7", deleted: true },
    });
  });
});

describe("comment", () => {
  it("list shows the author, date and Markdown body", async () => {
    expect(await plane("comment", "list", "PROJ-7")).toBe(0);
    expect(out).toContain(`${CID}\tann\t2026-01-02\thello **world**`);
    out = "";
    await plane("comment", "list", "PROJ-7", "--json");
    expect(JSON.parse(out)[0]).toMatchObject({ id: CID, body_markdown: "hello **world**" });
  });

  it("view prints Markdown and --json carries body_markdown", async () => {
    expect(await plane("comment", "view", "PROJ-7", CID)).toBe(0);
    expect(out).toContain("hello **world**");
    out = "";
    await plane("comment", "view", "PROJ-7", CID, "--json");
    expect(JSON.parse(out).body_markdown).toBe("hello **world**");
  });

  it("edit converts Markdown and verifies the read-back", async () => {
    expect(await plane("comment", "edit", "PROJ-7", CID, "--body", "new *text*")).toBe(0);
    expect(out).toMatch(/^✓ Updated comment /);
    expect(writes()[0]!.body!.comment_html).toContain("<em>text</em>");
    expect(calls.filter((c) => c.method === "GET" && c.path === `${COMMENTS}/${CID}/`)).toHaveLength(1);
  });

  it("edit needs a body and a UUID; a mismatched read-back fails", async () => {
    expect(await plane("comment", "edit", "PROJ-7", CID)).toBe(2);
    expect(await plane("comment", "edit", "PROJ-7", "nope", "--body", "x")).toBe(2);
    routes[`GET ${COMMENTS}/${CID}/`] = () => ({ body: { ...comments[0], comment_html: "<p>other</p>" } });
    expect(await plane("comment", "edit", "PROJ-7", CID, "--body", "x")).toBe(1);
    expect(err).toMatch(/did not apply the comment body/);
  });

  it("delete requires --yes", async () => {
    expect(await plane("comment", "delete", "PROJ-7", CID)).toBe(2);
    expect(writes()).toHaveLength(0);
    expect(await plane("comment", "delete", "PROJ-7", CID, "--yes")).toBe(0);
    expect(out).toMatch(/^✓ Deleted comment/);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${COMMENTS}/${CID}/`)).toBe(true);
  });
});

describe("issue dependency", () => {
  it("list prints rows and --json keeps the grouped object", async () => {
    relations.blocking = [{ project_id: PID, issue_id: IID2 }];
    expect(await plane("issue", "dependency", "list", "PROJ-7")).toBe(0);
    expect(out).toContain(`blocking\t${IID2}\t${PID}`);
    out = "";
    await plane("issue", "dependency", "list", "PROJ-7", "--json");
    expect(JSON.parse(out).blocking).toEqual([{ project_id: PID, issue_id: IID2 }]);
  });

  it("list with no relations says so", async () => {
    expect(await plane("issue", "dependency", "list", "PROJ-7")).toBe(0);
    expect(out).toBe("No dependencies match\n");
  });

  it("add posts the relation, reads it back and prints the result", async () => {
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", "PROJ-8", "--type", "relates_to")).toBe(0);
    expect(out).toBe("✓ Added relates_to relation PROJ-7 -> PROJ-8\n");
    expect(writes()[0]!.body).toEqual({ relation_type: "relates_to", issues: [IID2] });
    expect(relations.relates_to).toEqual([{ project_id: PID, issue_id: IID2 }]);
  });

  it("add is a no-op when the relation already exists", async () => {
    relations.blocked_by = [{ project_id: PID, issue_id: IID2 }];
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", "PROJ-8")).toBe(0);
    expect(out).toBe("PROJ-7 already has a blocked_by relation with PROJ-8\n");
    expect(writes()).toHaveLength(0);
  });

  it("rejects itself, bad types and a blocking cycle", async () => {
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", "PROJ-7")).toBe(2);
    expect(err).toMatch(/cannot depend on itself/);
    err = "";
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", IID2)).toBe(2);
    expect(err).toMatch(/--target-project/);
    err = "";
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", "PROJ-8", "--type", "nope")).toBe(2);
    expect(err).toMatch(/--type/);
    err = "";
    routes[`GET ${P}/work-items/${IID2}/relations/`] = () => ({
      body: { ...emptyRelations(), blocking: [{ project_id: PID, issue_id: IID }] },
    });
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", "PROJ-8", "--type", "blocking")).toBe(2);
    expect(err).toMatch(/blocking cycle/);
    expect(writes()).toHaveLength(0);
  });

  it("fails when the relation is not on read-back", async () => {
    routes[`POST ${RELATIONS}/`] = () => ({ status: 201, body: [{ id: "relation" }] });
    expect(await plane("issue", "dependency", "add", "PROJ-7", "--target", "PROJ-8", "--type", "relates_to")).toBe(1);
    expect(err).toMatch(/read-back/);
  });

  it("remove explains that the API has no deletion route", async () => {
    expect(await plane("issue", "dependency", "remove", "PROJ-7", "--target", "PROJ-8")).toBe(1);
    expect(err).toMatch(/no public dependency deletion route/);
    expect(writes()).toHaveLength(0);
  });
});

describe("issue link", () => {
  it("list and view", async () => {
    expect(await plane("issue", "link", "list", "PROJ-7")).toBe(0);
    expect(out).toContain(`Docs\thttps://example.com/docs\t${LID}`);
    out = "";
    expect(await plane("issue", "link", "view", "PROJ-7", LID, "--json")).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ id: LID, title: "Docs", url: "https://example.com/docs" });
  });

  it("add validates the URL and reads the link back", async () => {
    expect(await plane("issue", "link", "add", "PROJ-7", "--url", "ftp://example.com")).toBe(2);
    expect(err).toMatch(/HTTP or HTTPS/);
    expect(writes()).toHaveLength(0);
    err = "";
    expect(await plane("issue", "link", "add", "PROJ-7", "--url", "https://example.com/new", "--title", "New")).toBe(0);
    expect(out).toBe('✓ Added link "New" to PROJ-7\n');
    expect(writes()[0]!.body).toEqual({ url: "https://example.com/new", title: "New" });
  });

  it("edit requires a field and verifies the URL read-back", async () => {
    expect(await plane("issue", "link", "edit", "PROJ-7", LID)).toBe(2);
    expect(err).toMatch(/--url or --title/);
    err = "";
    expect(await plane("issue", "link", "edit", "PROJ-7", LID, "--title", "Renamed")).toBe(0);
    expect(writes()[0]!.body).toEqual({ title: "Renamed" });
    routes[`GET ${LINKS}/${LID}/`] = () => ({ body: { ...links[0], url: "https://stale.test/" } });
    expect(await plane("issue", "link", "edit", "PROJ-7", LID, "--url", "https://example.com/x")).toBe(1);
    expect(err).toMatch(/did not apply the link URL/);
  });

  it("delete requires --yes", async () => {
    expect(await plane("issue", "link", "delete", "PROJ-7", LID)).toBe(2);
    expect(writes()).toHaveLength(0);
    expect(await plane("issue", "link", "delete", "PROJ-7", LID, "--yes")).toBe(0);
    expect(out).toMatch(/^✓ Deleted link/);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${LINKS}/${LID}/`)).toBe(true);
  });
});

describe("issue activity", () => {
  it("list shows when, who, field and change", async () => {
    expect(await plane("issue", "activity", "list", "PROJ-7")).toBe(0);
    expect(out).toContain("2026-01-02 03:04:05\tann\tupdated\tpriority\tlow -> high");
    out = "";
    await plane("issue", "activity", "list", "PROJ-7", "--json");
    expect(JSON.parse(out)[0]).toMatchObject({ id: AID, field: "priority", new_value: "high" });
  });

  it("says no activities when empty", async () => {
    activities = [];
    expect(await plane("issue", "activity", "list", "PROJ-7")).toBe(0);
    expect(out).toBe("No activities match\n");
  });
});
