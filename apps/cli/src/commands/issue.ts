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
import type { Client } from "../client";
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
export interface Named {
  id: string;
  name?: string;
  display_name?: string;
  email?: string;
}
interface IssueState {
  id?: string;
  name?: string;
  group?: string;
}
export interface Issue {
  id: string;
  name: string;
  sequence_id: number;
  project: string;
  state?: string | IssueState | null;
  priority?: string | null;
  assignees?: string[];
  labels?: string[];
  parent?: string | IssueState | null;
  start_date?: string | null;
  target_date?: string | null;
  description_html?: string | null;
}
interface Comment {
  id: string;
  comment_html?: string;
}
export interface Ctx {
  client: Client;
  ws: string;
  url: string;
  project: string | undefined;
}
export interface Opts {
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
  yes?: boolean;
  open?: boolean;
  group?: string[];
  parent?: string;
  rootOnly?: boolean;
  query?: string;
  clearParent?: boolean;
  startDate?: string;
  targetDate?: string;
  clearDates?: boolean;
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];
const GROUPS_WITH_TRIAGE = [...GROUPS, "triage"];
const OPEN_GROUPS = ["backlog", "unstarted", "started"];
const REF = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

// ---------- helpers ----------
const collect = (v: string, a: string[] = []) => [...a, v];

export const ctxOf = (cmd: Command, o: Opts): Ctx => {
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
  for (let i = 2; i <= a.length; i++)
    for (let j = 2; j <= b.length; j++)
      if (a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  return d[a.length]![b.length]!;
};

/** Case-insensitive name match, or a "did you mean" usage error. */
const pick = <T>(kind: string, q: string, items: T[], nameOf: (t: T) => string[]): T => {
  const lq = q.toLowerCase();
  const hit = items.find((i) => nameOf(i).some((n) => n.toLowerCase() === lq));
  if (hit) return hit;
  const names = items.map((i) => nameOf(i)[0]!).filter(Boolean);
  // Suggest only a close match: substring, or a small edit distance relative to the name's length.
  const near = names.find((n) => {
    const ln = n.toLowerCase();
    if (ln.includes(lq) || lq.includes(ln)) return true;
    const d = lev(ln, lq);
    return d <= 2 && d <= Math.max(1, ln.length / 3);
  });
  const hint = near ? `, did you mean "${near}"?` : names.length ? ` (available: ${names.slice(0, 8).join(", ")})` : "";
  throw new CliError(`${kind} "${q}" not found${hint}`, EXIT.usage, "not_found_name");
};

const resolveProject = (c: Ctx, ref = c.project): Promise<Project> => {
  if (!ref) throw usageError("no project; pass --project <identifier|uuid> or run `plane config set project <id>`");
  return resolveProjectRef(c.client, c.ws, ref);
};

export const base = (c: Ctx, p: Project) => `workspaces/${c.ws}/projects/${p.id}`;
const states = (c: Ctx, p: Project) => fetchAll<State>(c.client, `${base(c, p)}/states/`);
const labels = (c: Ctx, p: Project) => fetchAll<Named>(c.client, `${base(c, p)}/labels/`);
export const members = (c: Ctx, p: Project) => c.client.get<Named[]>(`${base(c, p)}/members/`);

export const personName = (m: Named) => m.display_name ?? m.name ?? m.email ?? m.id;
const resolveAssignee = async (c: Ctx, q: string, all: Named[]): Promise<string> => {
  if (q === "me") return (await c.client.get<{ id: string }>("users/me/", { expect: ["id"] })).id;
  if (isUuid(q)) return q;
  return pick("assignee", q, all, (m) => [personName(m), m.email ?? ""]).id;
};

export const identifierOf = (p: Project, i: Issue) => `${p.identifier}-${i.sequence_id}`;
export const urlOf = (c: Ctx, id: string) => `${c.url}/${c.ws}/browse/${id}/`;

/** `PROJ-123` (or a bare number with a project) -> the issue plus its project. */
export const fetchIssue = async (c: Ctx, ref: string): Promise<{ issue: Issue; project: Project }> => {
  let ident = ref.replace(/^[A-Za-z][A-Za-z0-9_]*(?=-\d+$)/, (m) => m.toUpperCase());
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
export const readBody = async (o: Opts, opts: { editor: boolean }): Promise<string | undefined> => {
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

const idOf = (v?: string | IssueState | null) => (v && typeof v === "object" ? (v.id ?? null) : (v ?? null));
const stateIdOf = (s: Issue["state"]) => idOf(s);
const parentIdOf = (p: Issue["parent"]) => idOf(p);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const day = (v?: string | null) => (v ? v.slice(0, 10) : null);

/** start_date / target_date from the write flags, validated before anything is sent. */
const dateFields = (o: Opts) => {
  if (o.clearDates && (o.startDate !== undefined || o.targetDate !== undefined))
    throw usageError("--clear-dates cannot be combined with --start-date or --target-date");
  const data: Record<string, string | null> = {};
  if (o.startDate !== undefined) data.start_date = o.startDate;
  if (o.targetDate !== undefined) data.target_date = o.targetDate;
  if (o.clearDates) Object.assign(data, { start_date: null, target_date: null });
  for (const [key, flag] of [
    ["start_date", "--start-date"],
    ["target_date", "--target-date"],
  ] as const) {
    const v = data[key];
    if (typeof v === "string" && !isDate(v)) throw usageError(`${flag} must be a date, YYYY-MM-DD`);
  }
  if (typeof data.start_date === "string" && typeof data.target_date === "string" && data.start_date > data.target_date)
    throw usageError("--start-date must not be later than --target-date");
  return data;
};

/** Parent id in the same project; a UUID is read through the project to prove it belongs there. */
const parentRef = async (c: Ctx, p: Project, ref: string): Promise<string> => {
  if (isUuid(ref)) {
    const rec = await c.client.get<Issue>(`${base(c, p)}/work-items/${ref}/`, { expect: ["id"] });
    return rec.id;
  }
  const { issue, project } = await fetchIssue(c, ref);
  if (project.id !== p.id)
    throw usageError(`parent ${ref} belongs to ${project.identifier ?? project.id}, not ${p.identifier}`);
  return issue.id;
};

/** Walk the parent chain; reaching the edited item (or a repeat) is a cycle. */
const checkHierarchy = async (c: Ctx, p: Project, issueId: string | undefined, parent: string) => {
  const seen = new Set<string>(issueId ? [issueId] : []);
  let cur: string | null = parent;
  while (cur) {
    if (seen.has(cur)) throw usageError("parent assignment would create a hierarchy cycle");
    seen.add(cur);
    const rec = await c.client.get<Issue>(`${base(c, p)}/work-items/${cur}/`, { expect: ["id"] });
    cur = parentIdOf(rec.parent);
  }
};

const parentFlag = (o: Opts) => {
  if (o.parent !== undefined && o.clearParent) throw usageError("use only one of --parent and --clear-parent");
};

const summary = (c: Ctx, p: Project, i: Issue, st: State[], lb: Named[], mem: Named[]) => {
  const id = identifierOf(p, i);
  return {
    id,
    title: i.name,
    state: st.find((s) => s.id === stateIdOf(i.state))?.name ?? "",
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
  if (o.parent !== undefined && o.rootOnly) throw usageError("use only one of --parent and --root-only");

  const groups = new Set(o.group ?? []);
  if (o.open) for (const g of OPEN_GROUPS) groups.add(g);
  for (const g of groups)
    if (!GROUPS_WITH_TRIAGE.includes(g)) throw usageError(`--group must be one of ${GROUPS_WITH_TRIAGE.join(", ")}`);

  const stateIds = o.state ? [pick("state", o.state, st, (s) => [s.name]).id] : undefined;
  const labelIds = o.label?.length ? o.label.map((l) => pick("label", l, lb, (x) => [x.name ?? ""]).id) : undefined;
  const assigneeIds = o.assignee?.length
    ? await Promise.all(o.assignee.map((a) => resolveAssignee(c, a, mem)))
    : undefined;
  const parentId = o.parent !== undefined ? await parentRef(c, p, o.parent) : undefined;
  const query = o.query?.toLowerCase();

  let path = `${base(c, p)}/work-items/`;
  if (o.cycle || o.module) {
    const kind = o.cycle ? "cycles" : "modules";
    const q = (o.cycle ?? o.module)!;
    const all = await fetchAll<Named>(c.client, `${base(c, p)}/${kind}/`);
    const hit = isUuid(q) ? { id: q } : pick(kind.slice(0, -1), q, all, (x) => [x.name ?? ""]);
    path = `${base(c, p)}/${kind}/${hit.id}/${o.cycle ? "cycle" : "module"}-issues/`;
  }

  const groupsById = new Map(st.map((s) => [s.id, s.group]));
  const groupOf = (i: Issue) => {
    const s = i.state;
    if (s && typeof s === "object") return s.group ?? (s.id ? groupsById.get(s.id) : undefined);
    return s ? groupsById.get(s) : undefined;
  };
  const match = (i: Issue) => {
    if (stateIds && !stateIds.includes(stateIdOf(i.state) ?? "")) return false;
    if (groups.size) {
      const group = groupOf(i);
      if (group === undefined)
        throw new CliError(
          `${identifierOf(p, i)} has an unknown state group; refusing an incomplete filtered result`,
          EXIT.general,
          "unknown_state_group"
        );
      if (!groups.has(group)) return false;
    }
    if (labelIds && !labelIds.every((l) => i.labels?.includes(l))) return false;
    if (assigneeIds && !assigneeIds.some((a) => i.assignees?.includes(a))) return false;
    if (parentId !== undefined && parentIdOf(i.parent) !== parentId) return false;
    if (o.rootOnly && parentIdOf(i.parent)) return false;
    if (query && !`${i.name} ${htmlToMarkdown(i.description_html ?? "")}`.toLowerCase().includes(query)) return false;
    return true;
  };

  // The v1 list endpoint has no filters: follow every cursor, then filter.
  const all = await fetchAll<Issue>(c.client, path, { expand: "state" });
  const found = all.filter(match);
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
  const { description_html, ...rest } = issue;
  if (o.web) openBrowser(s.url);
  if (getOutput().json) {
    print("", {
      ...rest,
      ...(getOutput().rawHtml ? { description_html } : {}),
      identifier: s.id,
      url: s.url,
      body_markdown: body,
    });
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
    ].join("\n") + (getOutput().rawHtml && description_html ? `\n\nRaw HTML:\n${description_html}` : "")
  );
};

const create = async (o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const p = await resolveProject(c);
  if (!o.title) throw usageError("--title is required");
  const priority = checkPriority(o.priority);
  parentFlag(o);
  const dates = dateFields(o);
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
  if (o.parent !== undefined) {
    const parent = await parentRef(c, p, o.parent);
    await checkHierarchy(c, p, undefined, parent);
    payload.parent = parent;
  } else if (o.clearParent) {
    payload.parent = null;
  }
  Object.assign(payload, dates);
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
  parentFlag(o);
  const dates = dateFields(o);
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
    if (target.id !== stateIdOf(issue.state)) {
      patch.state = target.id;
      changes.push(`state ${st.find((s) => s.id === stateIdOf(issue.state))?.name ?? "-"} -> ${target.name}`);
    }
  }
  const currentParent = parentIdOf(issue.parent);
  let nextParent: string | null | undefined;
  if (o.parent !== undefined) nextParent = await parentRef(c, p, o.parent);
  else if (o.clearParent) nextParent = null;
  if (nextParent !== undefined && nextParent !== currentParent) {
    if (nextParent) await checkHierarchy(c, p, issue.id, nextParent);
    patch.parent = nextParent;
    changes.push(nextParent ? `parent ${currentParent ?? "-"} -> ${nextParent}` : "parent cleared");
  }
  for (const [key, label] of [
    ["start_date", "start date"],
    ["target_date", "target date"],
  ] as const) {
    if (!(key in dates)) continue;
    const next = dates[key]!;
    const current = day(issue[key]);
    if (current === next) continue;
    patch[key] = next;
    changes.push(next === null ? `${label} cleared` : `${label} ${current ?? "-"} -> ${next}`);
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
      ["state", stateIdOf(updated.state) === patch.state],
      ["labels", same(updated.labels, patch.labels as string[])],
      ["assignees", same(updated.assignees, patch.assignees as string[])],
      ["parent", parentIdOf(updated.parent) === ((patch.parent as string | null | undefined) ?? null)],
      ["start_date", day(updated.start_date) === ((patch.start_date as string | null | undefined) ?? null)],
      ["target_date", day(updated.target_date) === ((patch.target_date as string | null | undefined) ?? null)],
    ] as const
  ).filter(([k, ok]) => k in patch && !ok);
  if (bad.length) {
    throw new CliError(`server did not apply ${bad.map(([k]) => k).join(", ")} on ${id}`, EXIT.general, "not_applied");
  }
  success(`Updated ${id}: ${changes.join(", ")}`, "updated", { ...updated, identifier: id, url: urlOf(c, id) });
};

const deleteIssue = async (ref: string, o: Opts, cmd: Command) => {
  if (!o.yes) throw usageError("deletion requires --yes");
  const c = ctxOf(cmd, o);
  const { issue, project: p } = await fetchIssue(c, ref);
  const id = identifierOf(p, issue);
  await c.client.delete(`${base(c, p)}/work-items/${issue.id}/`);
  success(`Deleted ${id}`, "deleted", { id, identifier: id, url: urlOf(c, id), deleted: true });
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

export const common = (c: Command) =>
  c
    .option("--workspace <slug>", "workspace slug (default: config)")
    .option("--project <id>", "project identifier or uuid");
export const body = (c: Command) =>
  c
    .option("--body <markdown>", "Markdown body (`-` reads stdin)")
    .option("--body-file <path>", "read Markdown body from a file (`-` = stdin)");

/** The `issue` command must be registered before its subcommand groups attach to it. */
export const findIssueGroup = (program: Command): Command => {
  const issue = program.commands.find((c) => c.name() === "issue");
  if (!issue) throw new Error("registerIssue must run before issue subcommand groups");
  return issue;
};

export const registerIssue = (program: Command) => {
  const issue = program.command("issue").description("Manage work items (bodies are Markdown)");
  const fields = (c: Command) =>
    c
      .option("--state <name>", "state name")
      .option("--priority <p>", PRIORITIES.join("|"))
      .option("--assignee <user>", "assignee name, uuid or `me` (repeatable)", collect)
      .option("--label <name>", "label name (repeatable)", collect)
      .option("--parent <id>", "parent work item (PROJ-123)")
      .option("--clear-parent", "remove the parent")
      .option("--start-date <date>", "start date, YYYY-MM-DD")
      .option("--target-date <date>", "target date, YYYY-MM-DD")
      .option("--clear-dates", "clear both dates");

  common(issue.command("list").description("List work items"))
    .option("--state <name>", "filter by state")
    .option("--assignee <user>", "filter by assignee (`me` ok, repeatable)", collect)
    .option("--label <name>", "filter by label (repeatable, all must match)", collect)
    .option("--open", "only backlog, unstarted and started items (excludes triage)")
    .option("--group <group>", `${GROUPS_WITH_TRIAGE.join("|")} (repeatable)`, collect)
    .option("--parent <id>", "only children of this work item")
    .option("--root-only", "only items without a parent")
    .option("--query <text>", "case-insensitive match on title and description")
    .option("--cycle <name>", "only items in this cycle")
    .option("--module <name>", "only items in this module")
    .option("--limit <n>", "max items (default 30)")
    .action(run(list));
  common(issue.command("view <id>").description("Show a work item, e.g. PROJ-123"))
    .option("--web", "open in the browser")
    .action(run(view));
  common(issue.command("delete <id>").description("Delete a work item"))
    .option("--yes", "confirm deletion")
    .action(run(deleteIssue));
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
