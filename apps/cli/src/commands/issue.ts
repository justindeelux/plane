/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- cursor pages are inherently sequential */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { hasLossyHtml, htmlToMarkdown, markdownToHtml } from "@plane/markdown";
import type { Client, Page } from "../client";
import { fetchAll, isUuid, resolveProject as resolveProjectRef, type Project } from "../resolve";
import { getClient } from "../context";
import { CliError, EXIT, usageError } from "../errors";
import { printList } from "../format";
import { getOutput, noop, print, run, success } from "../output";

// ---------- types ----------
interface State {
  id: string;
  name: string;
  group: string;
  sequence?: number;
}
interface Named {
  id: string;
  name?: string;
  display_name?: string;
  email?: string;
}
export interface Issue {
  id: string;
  name: string;
  sequence_id: number;
  project: string;
  state?: string | null;
  priority?: string | null;
  assignees?: string[];
  labels?: string[];
  description_html?: string | null;
}
interface Comment {
  id: string;
  comment_html?: string;
}
interface Ctx {
  client: Client;
  ws: string;
  url: string;
  project: string | undefined;
}
interface Opts {
  workspace?: string;
  project?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  state?: string;
  priority?: string;
  assignee?: string[];
  label?: string[];
  removeAssignee?: string[];
  removeLabel?: string[];
  cycle?: string;
  module?: string;
  limit?: string;
  web?: boolean;
  force?: boolean;
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const REF = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

// ---------- helpers ----------
const collect = (v: string, a: string[] = []) => [...a, v];

const ctxOf = (cmd: Command, o: Opts): Ctx => {
  const { client, resolved } = getClient(cmd);
  const ws = o.workspace ?? resolved.workspace;
  if (!ws) throw usageError("no workspace; pass --workspace or run `plane config set workspace <slug>`");
  return { client, ws, url: resolved.url, project: o.project ?? resolved.project };
};

const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
};

/** Case-insensitive name match, or a "did you mean" usage error. */
const pick = <T>(kind: string, q: string, items: T[], nameOf: (t: T) => string[]): T => {
  const lq = q.toLowerCase();
  const hit = items.find((i) => nameOf(i).some((n) => n.toLowerCase() === lq));
  if (hit) return hit;
  const names = items.map((i) => nameOf(i)[0]!).filter(Boolean);
  const near =
    names.find((n) => n.toLowerCase().includes(lq) || lq.includes(n.toLowerCase())) ??
    names.map((n) => [n, lev(n.toLowerCase(), lq)] as const).toSorted((x, y) => x[1] - y[1])[0]?.[0];
  const hint = near ? `, did you mean "${near}"?` : names.length ? ` (available: ${names.slice(0, 8).join(", ")})` : "";
  throw new CliError(`${kind} "${q}" not found${hint}`, EXIT.usage, "not_found_name");
};

const resolveProject = (c: Ctx, ref = c.project): Promise<Project> => {
  if (!ref) throw usageError("no project; pass --project <identifier|uuid> or run `plane config set project <id>`");
  return resolveProjectRef(c.client, c.ws, ref);
};

const base = (c: Ctx, p: Project) => `workspaces/${c.ws}/projects/${p.id}`;
const states = (c: Ctx, p: Project) => fetchAll<State>(c.client, `${base(c, p)}/states/`);
const labels = (c: Ctx, p: Project) => fetchAll<Named>(c.client, `${base(c, p)}/labels/`);
const members = (c: Ctx, p: Project) => c.client.get<Named[]>(`${base(c, p)}/members/`);

const personName = (m: Named) => m.display_name ?? m.name ?? m.email ?? m.id;
const resolveAssignee = async (c: Ctx, q: string, all: Named[]): Promise<string> => {
  if (q === "me") return (await c.client.get<{ id: string }>("users/me/", { expect: ["id"] })).id;
  if (isUuid(q)) return q;
  return pick("assignee", q, all, (m) => [personName(m), m.email ?? ""]).id;
};

const identifierOf = (p: Project, i: Issue) => `${p.identifier}-${i.sequence_id}`;
const urlOf = (c: Ctx, id: string) => `${c.url}/${c.ws}/browse/${id}/`;

/** `PROJ-123` (or a bare number with a project) -> the issue plus its project. */
const fetchIssue = async (c: Ctx, ref: string): Promise<{ issue: Issue; project: Project }> => {
  let ident = ref;
  if (/^\d+$/.test(ref)) ident = `${(await resolveProject(c)).identifier}-${ref}`;
  if (!REF.test(ident)) throw usageError(`"${ref}" is not a work item id (expected e.g. PROJ-123)`);
  const issue = await c.client.get<Issue>(`workspaces/${c.ws}/work-items/${ident}/`, { expect: ["id", "project"] });
  const project = await resolveProjectRef(c.client, c.ws, issue.project);
  return { issue, project };
};

// ---------- body input ----------
const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Markdown from --body / --body-file / `-` (stdin) / $EDITOR (TTY only); undefined when not given and not asked. */
const readBody = async (o: Opts, opts: { editor: boolean }): Promise<string | undefined> => {
  let md: string | undefined;
  if (o.body !== undefined && o.bodyFile !== undefined) throw usageError("use only one of --body and --body-file");
  if (o.body === "-" || o.bodyFile === "-") md = await readStdin();
  else if (o.body !== undefined) md = o.body;
  else if (o.bodyFile !== undefined) {
    try {
      md = readFileSync(o.bodyFile, "utf8");
    } catch (e) {
      throw usageError(`cannot read ${o.bodyFile}: ${(e as Error).message}`);
    }
  } else if (opts.editor) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined; // scripts: no body is fine
    const dir = mkdtempSync(join(tmpdir(), "plane-"));
    const file = join(dir, "body.md");
    try {
      writeFileSync(file, "");
      const [cmd, ...args] = (process.env.VISUAL || process.env.EDITOR || "vi").split(" ");
      const r = spawnSync(cmd!, [...args, file], { stdio: "inherit" });
      if (r.status !== 0) throw new CliError("editor exited with an error; nothing sent", EXIT.general, "editor");
      md = readFileSync(file, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (md !== undefined && !md.trim()) throw usageError("body is empty; nothing sent");
  return md;
};

const openBrowser = (url: string) => {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd!, args as string[], { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
};

const same = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x) => b.includes(x));
const checkPriority = (p?: string) => {
  if (p && !PRIORITIES.includes(p.toLowerCase())) throw usageError(`priority must be one of ${PRIORITIES.join(", ")}`);
  return p?.toLowerCase();
};

const summary = (c: Ctx, p: Project, i: Issue, st: State[], lb: Named[], mem: Named[]) => {
  const id = identifierOf(p, i);
  return {
    id,
    title: i.name,
    state: st.find((s) => s.id === i.state)?.name ?? "",
    priority: i.priority ?? "none",
    assignees: (i.assignees ?? []).map((a) => personName(mem.find((m) => m.id === a) ?? { id: a })),
    labels: (i.labels ?? []).map((l) => lb.find((x) => x.id === l)?.name ?? l),
    url: urlOf(c, id),
  };
};

// ---------- commands ----------
const list = async (o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const p = await resolveProject(c);
  const [st, lb, mem] = await Promise.all([states(c, p), labels(c, p), members(c, p)]);
  const limit = o.limit === undefined ? 30 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1) throw usageError("--limit must be a positive integer");

  const stateIds = o.state ? [pick("state", o.state, st, (s) => [s.name]).id] : undefined;
  const labelIds = o.label?.length ? o.label.map((l) => pick("label", l, lb, (x) => [x.name ?? ""]).id) : undefined;
  const assigneeIds = o.assignee?.length
    ? await Promise.all(o.assignee.map((a) => resolveAssignee(c, a, mem)))
    : undefined;

  let path = `${base(c, p)}/work-items/`;
  if (o.cycle || o.module) {
    const kind = o.cycle ? "cycles" : "modules";
    const q = (o.cycle ?? o.module)!;
    const all = await fetchAll<Named>(c.client, `${base(c, p)}/${kind}/`);
    const hit = isUuid(q) ? { id: q } : pick(kind.slice(0, -1), q, all, (x) => [x.name ?? ""]);
    path = `${base(c, p)}/${kind}/${hit.id}/${o.cycle ? "cycle" : "module"}-issues/`;
  }

  const match = (i: Issue) =>
    (!stateIds || stateIds.includes(i.state ?? "")) &&
    (!labelIds || labelIds.every((l) => i.labels?.includes(l))) &&
    (!assigneeIds || assigneeIds.some((a) => i.assignees?.includes(a)));

  // The v1 list endpoint has no filters, so filter client-side while paging.
  const found: Issue[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.client.get<Page<Issue>>(path, { query: { per_page: 100, cursor } });
    if (!Array.isArray(page.results)) {
      throw new CliError(`GET ${path} returned an unexpected shape`, EXIT.general, "malformed_response");
    }
    found.push(...page.results.filter(match));
    cursor = page.next_page_results ? page.next_cursor : undefined;
  } while (cursor && found.length < limit);

  const rows = found.slice(0, limit).map((i) => summary(c, p, i, st, lb, mem));
  printList(
    "issues",
    ["ID", "TITLE", "STATE", "ASSIGNEE", "PRIORITY"],
    rows.map((r) => [r.id, r.title, r.state, r.assignees.join(", "), r.priority]),
    rows.length ? found.slice(0, limit) : []
  );
};

const view = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project: p } = await fetchIssue(c, ref);
  const [st, lb, mem] = await Promise.all([states(c, p), labels(c, p), members(c, p)]);
  const s = summary(c, p, issue, st, lb, mem);
  const body = issue.description_html ? htmlToMarkdown(issue.description_html).trim() : "";
  if (o.web) openBrowser(s.url);
  if (getOutput().json) {
    print("", { ...issue, identifier: s.id, url: s.url, body_markdown: body });
    return;
  }
  print(
    [
      `${s.id}  ${s.title}`,
      `State: ${s.state || "-"}   Priority: ${s.priority}`,
      `Assignee: ${s.assignees.join(", ") || "-"}`,
      `Labels: ${s.labels.join(", ") || "-"}`,
      `URL: ${s.url}`,
      "",
      body || "(no description)",
    ].join("\n")
  );
};

const create = async (o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const p = await resolveProject(c);
  if (!o.title) throw usageError("--title is required");
  const priority = checkPriority(o.priority);
  const md = await readBody(o, { editor: true });
  const payload: Record<string, unknown> = { name: o.title };
  if (md !== undefined) payload.description_html = markdownToHtml(md);
  if (priority) payload.priority = priority;
  if (o.state) payload.state = pick("state", o.state, await states(c, p), (s) => [s.name]).id;
  if (o.label?.length) {
    const lb = await labels(c, p);
    payload.labels = o.label.map((l) => pick("label", l, lb, (x) => [x.name ?? ""]).id);
  }
  if (o.assignee?.length) {
    const mem = await members(c, p);
    payload.assignees = await Promise.all(o.assignee.map((a) => resolveAssignee(c, a, mem)));
  }
  // One atomic request carries state/labels/assignees, so create cannot half-succeed.
  const issue = await c.client.post<Issue>(`${base(c, p)}/work-items/`, payload, {
    expect: ["id", "sequence_id", "name"],
  });
  const id = identifierOf(p, issue);
  success(`Created ${id} "${issue.name}" ${urlOf(c, id)}`, "created", { ...issue, identifier: id, url: urlOf(c, id) });
};

const edit = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project: p } = await fetchIssue(c, ref);
  const id = identifierOf(p, issue);
  const priority = checkPriority(o.priority);
  const md = await readBody(o, { editor: false });
  const [st, lb, mem] = await Promise.all([states(c, p), labels(c, p), members(c, p)]);

  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  if (o.title !== undefined && o.title !== issue.name) {
    patch.name = o.title;
    changes.push(`title "${issue.name}" -> "${o.title}"`);
  }
  if (priority && priority !== (issue.priority ?? "none")) {
    patch.priority = priority;
    changes.push(`priority ${issue.priority ?? "none"} -> ${priority}`);
  }
  if (o.state) {
    const target = pick("state", o.state, st, (s) => [s.name]);
    if (target.id !== issue.state) {
      patch.state = target.id;
      changes.push(`state ${st.find((s) => s.id === issue.state)?.name ?? "-"} -> ${target.name}`);
    }
  }
  const nameOfLabel = (l: string) => lb.find((x) => x.id === l)?.name ?? l;
  const nameOfPerson = (a: string) => personName(mem.find((m) => m.id === a) ?? { id: a });
  const setDiff = async (
    key: "labels" | "assignees",
    add: string[] | undefined,
    remove: string[] | undefined,
    toId: (q: string) => Promise<string> | string,
    label: (id: string) => string
  ) => {
    const cur = issue[key] ?? [];
    const addIds = await Promise.all((add ?? []).map(toId));
    const rmIds = await Promise.all((remove ?? []).map(toId));
    const next = [...cur.filter((x) => !rmIds.includes(x)), ...addIds.filter((x) => !cur.includes(x))];
    if (same(cur, next)) return;
    patch[key] = next;
    const added = next.filter((x) => !cur.includes(x)).map((x) => `+${label(x)}`);
    const removed = cur.filter((x) => !next.includes(x)).map((x) => `-${label(x)}`);
    changes.push(`${key} ${[...added, ...removed].join(" ")}`);
  };
  await setDiff("labels", o.label, o.removeLabel, (q) => pick("label", q, lb, (x) => [x.name ?? ""]).id, nameOfLabel);
  await setDiff("assignees", o.assignee, o.removeAssignee, (q) => resolveAssignee(c, q, mem), nameOfPerson);
  if (md !== undefined) {
    const html = markdownToHtml(md);
    const old = issue.description_html ?? "";
    if (old.trim() && hasLossyHtml(old) && !o.force) {
      throw new CliError(
        `${id}'s description has formatting Markdown cannot express (colors, mentions, embeds, ...) and would be flattened; re-run with --force to overwrite it`,
        EXIT.usage,
        "lossy_description"
      );
    }
    if (html.trim() !== old.trim()) {
      patch.description_html = html;
      changes.push("description updated");
    }
  }

  if (!Object.keys(patch).length) {
    noop(`${id} already matches, nothing to change`, issue);
    return;
  }
  const updated = await c.client.patch<Issue>(`${base(c, p)}/work-items/${issue.id}/`, patch, { expect: ["id"] });
  const bad = (
    [
      ["name", updated.name === patch.name],
      ["priority", updated.priority === patch.priority],
      ["state", updated.state === patch.state],
      ["labels", same(updated.labels, patch.labels as string[])],
      ["assignees", same(updated.assignees, patch.assignees as string[])],
    ] as const
  ).filter(([k, ok]) => k in patch && !ok);
  if (bad.length) {
    throw new CliError(`server did not apply ${bad.map(([k]) => k).join(", ")} on ${id}`, EXIT.general, "not_applied");
  }
  success(`Updated ${id}: ${changes.join(", ")}`, "updated", { ...updated, identifier: id, url: urlOf(c, id) });
};

const comment = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const md = await readBody(o, { editor: true });
  if (md === undefined) throw usageError("no comment body given");
  const { issue, project: p } = await fetchIssue(c, ref);
  const id = identifierOf(p, issue);
  const created = await c.client.post<Comment>(
    `${base(c, p)}/work-items/${issue.id}/comments/`,
    { comment_html: markdownToHtml(md) },
    { expect: ["id", "comment_html"] }
  );
  success(`Commented on ${id} ${urlOf(c, id)}`, "commented", created);
};

/** close/reopen: move to a state in `group` (or --state), no-op when already there. */
const transition = (group: "completed" | "unstarted", past: string) => async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project: p } = await fetchIssue(c, ref);
  const id = identifierOf(p, issue);
  const st = await states(c, p);
  const cur = st.find((s) => s.id === issue.state);
  const target = o.state
    ? pick("state", o.state, st, (s) => [s.name])
    : (st.filter((s) => s.group === group).toSorted((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))[0] ??
      (() => {
        throw new CliError(`${p.identifier} has no "${group}" state; pass --state`, EXIT.usage, "no_state");
      })());
  if (cur && (o.state ? cur.id === target.id : cur.group === group)) {
    noop(`${id} is already ${cur.name}, nothing to change`, issue);
    return;
  }
  const updated = await c.client.patch<Issue>(
    `${base(c, p)}/work-items/${issue.id}/`,
    { state: target.id },
    { expect: ["id", "state"] }
  );
  if (updated.state !== target.id) {
    throw new CliError(`server did not move ${id} to ${target.name}`, EXIT.general, "not_applied");
  }
  success(`${past} ${id}: state ${cur?.name ?? "-"} -> ${target.name}`, past.toLowerCase(), {
    ...updated,
    identifier: id,
    url: urlOf(c, id),
  });
};

const common = (c: Command) =>
  c
    .option("--workspace <slug>", "workspace slug (default: config)")
    .option("--project <id>", "project identifier or uuid");
const body = (c: Command) =>
  c
    .option("--body <markdown>", "Markdown body (`-` reads stdin)")
    .option("--body-file <path>", "read Markdown body from a file (`-` = stdin)");

export const registerIssue = (program: Command) => {
  const issue = program.command("issue").description("Manage work items (bodies are Markdown)");
  const fields = (c: Command) =>
    c
      .option("--state <name>", "state name")
      .option("--priority <p>", PRIORITIES.join("|"))
      .option("--assignee <user>", "assignee name, uuid or `me` (repeatable)", collect)
      .option("--label <name>", "label name (repeatable)", collect);

  common(issue.command("list").description("List work items"))
    .option("--state <name>", "filter by state")
    .option("--assignee <user>", "filter by assignee (`me` ok, repeatable)", collect)
    .option("--label <name>", "filter by label (repeatable, all must match)", collect)
    .option("--cycle <name>", "only items in this cycle")
    .option("--module <name>", "only items in this module")
    .option("--limit <n>", "max items (default 30)")
    .action(run(list));
  common(issue.command("view <id>").description("Show a work item, e.g. PROJ-123"))
    .option("--web", "open in the browser")
    .action(run(view));
  body(
    fields(common(issue.command("create").description("Create a work item")).option("-t, --title <title>", "title"))
  ).action(run(create));
  body(
    fields(common(issue.command("edit <id>").description("Edit a work item")))
      .option("-t, --title <title>", "new title")
      .option("--remove-assignee <user>", "remove an assignee (repeatable)", collect)
      .option("--remove-label <name>", "remove a label (repeatable)", collect)
      .option("--force", "overwrite a description that has formatting Markdown cannot express")
  ).action(run(edit));
  body(common(issue.command("comment <id>").description("Add a comment"))).action(run(comment));
  common(issue.command("close <id>").description("Move to a completed state"))
    .option("--state <name>", "target state")
    .action(run(transition("completed", "Closed")));
  common(issue.command("reopen <id>").description("Move back to an unstarted state"))
    .option("--state <name>", "target state")
    .action(run(transition("unstarted", "Reopened")));
};
