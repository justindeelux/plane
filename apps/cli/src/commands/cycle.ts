/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { Client } from "../client";
import { CliError, EXIT, usageError } from "../errors";
import { printList, table } from "../format";
import { run, success } from "../output";
import {
  fetchAll,
  isUuid,
  printView,
  requireProject,
  resolveNamed,
  stateName,
  withScope,
  type IssueRow,
  type Project,
  type ScopeOptions,
} from "../resolve";

interface Cycle {
  id: string;
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  total_issues?: number;
  completed_issues?: number;
  owned_by?: string | { id?: string } | null;
  archived_at?: string | null;
  [k: string]: unknown;
}

interface CycleOptions extends ScopeOptions {
  name?: string;
  description?: string;
  descriptionFile?: string;
  startDate?: string;
  endDate?: string;
  ownedBy?: string;
  timezone?: string;
}

const STATUSES = ["current", "upcoming", "completed", "draft"];
const date = (d?: string | null) => (d ? d.slice(0, 10) : "");
const statusOf = (c: Cycle, now = Date.now()) => {
  if (!c.start_date && !c.end_date) return "draft";
  if (c.start_date && Date.parse(c.start_date) > now) return "upcoming";
  if (c.end_date && Date.parse(c.end_date) < now) return "completed";
  return "current";
};

const projectPath = (workspace: string, projectId: string) => `workspaces/${workspace}/projects/${projectId}`;
const pathOf = (workspace: string, projectId: string) => `${projectPath(workspace, projectId)}/cycles`;
/** CE may expand `owned_by` to an object on reads. */
const ownerId = (o: Cycle["owned_by"]) => (o && typeof o === "object" ? (o.id ?? "") : (o ?? ""));

// ---------- write helpers ----------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const checkDates = (start?: string | null, end?: string | null) => {
  if (start && !isDate(date(start))) throw usageError("--start-date must be a date, YYYY-MM-DD");
  if (end && !isDate(date(end))) throw usageError("--end-date must be a date, YYYY-MM-DD");
  if (start && end && date(start) > date(end)) throw usageError("--start-date must not be later than --end-date");
};

const MAX_DESCRIPTION = 1024 * 1024;
const descriptionOf = (o: CycleOptions): string | undefined => {
  if (o.description !== undefined && o.descriptionFile !== undefined)
    throw usageError("use only one of --description and --description-file");
  let text = o.description;
  if (o.descriptionFile !== undefined) {
    try {
      text = readFileSync(o.descriptionFile === "-" ? 0 : o.descriptionFile, "utf8");
    } catch (e) {
      throw usageError(`cannot read ${o.descriptionFile}: ${(e as Error).message}`);
    }
  }
  if (text !== undefined && Buffer.byteLength(text) > MAX_DESCRIPTION)
    throw usageError("description exceeds the CLI limit of 1 MiB");
  return text;
};

/** POST/PATCH body from the write flags; cycles take a plain-text description, not description_html. */
const fieldsOf = (o: CycleOptions): Record<string, unknown> => {
  const data: Record<string, unknown> = {};
  if (o.name !== undefined) data.name = o.name;
  if (o.startDate !== undefined) data.start_date = o.startDate;
  if (o.endDate !== undefined) data.end_date = o.endDate;
  if (o.timezone !== undefined) data.timezone = o.timezone;
  if (o.ownedBy !== undefined) {
    if (!isUuid(o.ownedBy)) throw usageError("--owned-by must be a user uuid");
    data.owned_by = o.ownedBy;
  }
  const description = descriptionOf(o);
  if (description !== undefined) data.description = description;
  return data;
};

const readBack = async <T>(client: Client, path: string, what: string) => {
  try {
    return await client.get<T>(path);
  } catch (e) {
    throw new CliError(`${what} but the read-back failed: ${(e as Error).message}`, EXIT.general, "read_back_failed");
  }
};

const findArchived = async (client: Client, project: string, ref: string): Promise<Cycle> => {
  if (isUuid(ref)) return { id: ref, name: ref };
  const all = await fetchAll<Cycle>(client, `${project}/archived-cycles/`);
  const hit = all.find((c) => c.name?.toLowerCase() === ref.toLowerCase());
  if (!hit) {
    const names = all.map((c) => c.name).slice(0, 20);
    throw new CliError(
      `archived cycle "${ref}" not found${names.length ? `; available: ${names.join(", ")}` : ""}`,
      EXIT.notFound,
      "not_found",
      404
    );
  }
  return hit;
};

const WORK_ITEM = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const resolveIssue = async (client: Client, workspace: string, project: Project, ref: string) => {
  if (isUuid(ref)) return { id: ref, label: ref };
  const ident = ref.replace(/^[A-Za-z][A-Za-z0-9_]*(?=-\d+$)/, (m) => m.toUpperCase());
  if (!WORK_ITEM.test(ident))
    throw usageError(`"${ref}" is not a work item id (expected e.g. ${project.identifier}-123)`);
  const issue = await client.get<{ id: string; project: string }>(`workspaces/${workspace}/work-items/${ident}/`, {
    expect: ["id", "project"],
  });
  if (issue.project !== project.id)
    throw new CliError(`work item ${ident} belongs to a different project`, EXIT.usage, "wrong_project");
  return { id: issue.id, label: ident };
};

// ---------- commands ----------
const create = async (o: CycleOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.name) throw usageError("--name is required");
  const data = fieldsOf(o);
  checkDates(o.startDate, o.endDate);
  const base = pathOf(workspace, project.id);
  const created = await client.post<Cycle>(`${base}/`, data, { expect: ["id"] });
  const record = await readBack<Cycle>(client, `${base}/${created.id}/`, `cycle "${String(data.name)}" was created`);
  success(`Created cycle "${record.name}" ${record.id}`, "created", record);
};

const edit = async (ref: string, o: CycleOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const base = pathOf(workspace, project.id);
  const cycle = await resolveNamed<Cycle>(client, base, "cycle", ref);
  const path = `${base}/${cycle.id}/`;
  const record = await client.get<Cycle>(path);
  const data = fieldsOf(o);
  if (!Object.keys(data).length)
    throw usageError("no fields given; pass --name, --description, --start-date, --end-date, --owned-by or --timezone");
  checkDates((data.start_date as string) ?? record.start_date, (data.end_date as string) ?? record.end_date);
  // CE defaults an omitted owner to the caller, even on PATCH; send the current one back.
  const owner = ownerId(record.owned_by);
  if (!("owned_by" in data) && owner) data.owned_by = owner;
  await client.patch(path, data, { expect: ["id"] });
  const read = await readBack<Cycle>(client, path, `cycle "${cycle.name}" was updated`);
  const notApplied = ["name", "start_date", "end_date", "timezone"].filter((k) => {
    if (!(k in data)) return false;
    const got = read[k];
    return k.endsWith("date")
      ? date(data[k] as string) !== date(typeof got === "string" ? got : null)
      : got !== data[k];
  });
  if (notApplied.length)
    throw new CliError(
      `server did not apply ${notApplied.join(", ")} on cycle "${cycle.name}"`,
      EXIT.general,
      "not_applied"
    );
  success(`Updated cycle "${read.name}" ${read.id}`, "updated", read);
};

const remove = async (ref: string, o: ScopeOptions & { yes?: boolean }, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.yes) throw usageError("deleting a cycle requires --yes");
  const base = pathOf(workspace, project.id);
  const cycle = await resolveNamed<Cycle>(client, base, "cycle", ref);
  await client.raw("DELETE", `${base}/${cycle.id}/`);
  success(`Deleted cycle "${cycle.name}" ${cycle.id}`, "deleted", { id: cycle.id, deleted: true });
};

const complete = async (ref: string, o: ScopeOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const base = pathOf(workspace, project.id);
  const cycle = await resolveNamed<Cycle>(client, base, "cycle", ref);
  const path = `${base}/${cycle.id}/`;
  const record = await client.get<Cycle>(path);
  if (record.start_date && Date.parse(record.start_date) > Date.now())
    throw new CliError(
      `cannot complete cycle "${record.name}": its start date ${date(record.start_date)} is in the future`,
      EXIT.usage,
      "cycle_not_started"
    );
  const data: Record<string, unknown> = { end_date: new Date().toISOString() };
  const owner = ownerId(record.owned_by);
  if (owner) data.owned_by = owner;
  await client.patch(path, data, { expect: ["id"] });
  const read = await readBack<Cycle>(client, path, `cycle "${cycle.name}" was completed`);
  if (!read.end_date) throw new CliError(`server did not complete cycle "${cycle.name}"`, EXIT.general, "not_applied");
  success(`Completed cycle "${read.name}" (ended ${date(read.end_date)})`, "completed", read);
};

const setArchived = (archived: boolean) => async (ref: string, o: ScopeOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const projectBase = projectPath(workspace, project.id);
  const base = pathOf(workspace, project.id);
  const cycle = archived
    ? await resolveNamed<Cycle>(client, base, "cycle", ref)
    : await findArchived(client, projectBase, ref);
  if (archived) await client.raw("POST", `${base}/${cycle.id}/archive/`);
  else await client.raw("DELETE", `${projectBase}/archived-cycles/${cycle.id}/unarchive/`);
  // CE hides archived cycles from the normal detail endpoint.
  const record = archived
    ? (await fetchAll<Cycle>(client, `${projectBase}/archived-cycles/`)).find((c) => c.id === cycle.id)
    : await client.get<Cycle>(`${base}/${cycle.id}/`);
  if (!record || Boolean(record.archived_at) !== archived)
    throw new CliError("archive change was not confirmed by read-back", EXIT.general, "not_applied");
  success(
    `${archived ? "Archived" : "Unarchived"} cycle "${record.name}" ${record.id}`,
    archived ? "archived" : "unarchived",
    record
  );
};

const transfer = async (ref: string, o: ScopeOptions & { to?: string }, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.to) throw usageError("--to is required");
  const base = pathOf(workspace, project.id);
  const from = await resolveNamed<Cycle>(client, base, "cycle", ref);
  const to = await resolveNamed<Cycle>(client, base, "cycle", o.to);
  if (from.id === to.id) throw usageError("source and destination cycles must be different");
  await client.raw("POST", `${base}/${from.id}/transfer-issues/`, { body: { new_cycle_id: to.id } });
  const source = await fetchAll<IssueRow>(client, `${base}/${from.id}/cycle-issues/`);
  const destination = await fetchAll<IssueRow>(client, `${base}/${to.id}/cycle-issues/`);
  success(
    `Transferred issues from "${from.name}" to "${to.name}" (${source.length} in source, ${destination.length} in destination)`,
    "transferred",
    { source, destination }
  );
};

const listIssues = async (ref: string, o: ScopeOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const base = pathOf(workspace, project.id);
  const cycle = await resolveNamed<Cycle>(client, base, "cycle", ref);
  const items = await fetchAll<IssueRow>(client, `${base}/${cycle.id}/cycle-issues/`, { expand: "state" });
  printList(
    "issues",
    ["ID", "TITLE", "STATE"],
    items.map((i) => [`${project.identifier}-${i.sequence_id}`, i.name, stateName(i.state)]),
    items
  );
};

const addIssue = async (ref: string, o: ScopeOptions & { issue?: string }, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.issue) throw usageError("--issue is required");
  const base = pathOf(workspace, project.id);
  const cycle = await resolveNamed<Cycle>(client, base, "cycle", ref);
  const issue = await resolveIssue(client, workspace, project, o.issue);
  const path = `${base}/${cycle.id}/cycle-issues/`;
  await client.raw("POST", path, { body: { issues: [issue.id] } });
  try {
    await client.get(`${path}${issue.id}/`);
  } catch (e) {
    throw new CliError(
      `${issue.label} was added to cycle "${cycle.name}" but the read-back failed: ${(e as Error).message}`,
      EXIT.general,
      "read_back_failed"
    );
  }
  success(`Added ${issue.label} to cycle "${cycle.name}"`, "added", { cycle: cycle.id, issue: issue.id, added: true });
};

const removeIssue = async (ref: string, o: ScopeOptions & { issue?: string }, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.issue) throw usageError("--issue is required");
  const base = pathOf(workspace, project.id);
  const cycle = await resolveNamed<Cycle>(client, base, "cycle", ref);
  const issue = await resolveIssue(client, workspace, project, o.issue);
  await client.raw("DELETE", `${base}/${cycle.id}/cycle-issues/${issue.id}/`);
  success(`Removed ${issue.label} from cycle "${cycle.name}"`, "removed", {
    cycle: cycle.id,
    issue: issue.id,
    removed: true,
  });
};

const write = (c: Command) =>
  c
    .option("--name <name>", "cycle name")
    .option("--description <text>", "plain text description (`-` reads stdin)")
    .option("--description-file <path>", "read the description from a file (`-` = stdin)")
    .option("--start-date <date>", "start date, YYYY-MM-DD")
    .option("--end-date <date>", "end date, YYYY-MM-DD")
    .option("--owned-by <uuid>", "owner user uuid")
    .option("--timezone <tz>", "timezone, e.g. Europe/Paris");

export const registerCycle = (program: Command) => {
  const g = program.command("cycle").description("List, create and manage cycles");

  withScope(g.command("list").description("List cycles in a project"))
    .option("--archived", "list archived cycles instead")
    .option("--status <status>", `only cycles that are ${STATUSES.join("|")} (server-side filter)`)
    .action(
      run(async (o: ScopeOptions & { status?: string; archived?: boolean }, cmd: Command) => {
        if (o.status && !STATUSES.includes(o.status))
          throw usageError(`--status must be one of ${STATUSES.join(", ")}`);
        const { client, workspace, project } = await requireProject(cmd, o);
        const base = projectPath(workspace, project.id);
        const items = await fetchAll<Cycle>(
          client,
          `${base}/${o.archived ? "archived-cycles" : "cycles"}/`,
          o.status && !o.archived ? { cycle_view: o.status } : {}
        );
        printList(
          "cycles",
          ["NAME", "STATUS", "START", "END", "ISSUES", "ID"],
          items.map((c) => [
            c.name,
            o.archived ? "archived" : statusOf(c),
            date(c.start_date),
            date(c.end_date),
            `${c.completed_issues ?? 0}/${c.total_issues ?? 0}`,
            c.id,
          ]),
          items
        );
      })
    );

  withScope(g.command("view <cycle>").description("Show a cycle (name or uuid)"))
    .option("--issues", "also list the cycle's issues")
    .option("--limit <n>", "max issues to list with --issues", "50")
    .action(
      run(async (ref: string, o: ScopeOptions & { issues?: boolean; limit: string }, cmd: Command) => {
        const { client, workspace, project } = await requireProject(cmd, o);
        const base = pathOf(workspace, project.id);
        const c = await resolveNamed<Cycle>(client, base, "cycle", ref);
        let issues: { rows: string; items: IssueRow[] } | undefined;
        if (o.issues) {
          const items = await client.paginate<IssueRow>(
            `${base}/${c.id}/cycle-issues/`,
            { expand: "state" },
            Number(o.limit) || 50
          );
          issues = {
            items,
            rows: items.length
              ? table(
                  ["ID", "TITLE", "STATE"],
                  items.map((i) => [`${project.identifier}-${i.sequence_id}`, i.name, stateName(i.state)])
                )
              : "No issues in this cycle",
          };
        }
        printView(
          c.name,
          c,
          [
            ["id", c.id],
            ["status", statusOf(c)],
            ["start", date(c.start_date)],
            ["end", date(c.end_date)],
            ["issues", `${c.completed_issues ?? 0}/${c.total_issues ?? 0} completed`],
            ["owner", ownerId(c.owned_by)],
          ],
          issues
        );
      })
    );

  withScope(write(g.command("create").description("Create a cycle (--name is required)"))).action(run(create));
  withScope(write(g.command("edit <cycle>").description("Edit a cycle (name or uuid)"))).action(run(edit));
  withScope(g.command("delete <cycle>").description("Delete a cycle (name or uuid)"))
    .option("--yes", "confirm deletion")
    .action(run(remove));
  withScope(
    g.command("complete <cycle>").description("End a cycle now (its start date must not be in the future)")
  ).action(run(complete));
  withScope(g.command("archive <cycle>").description("Archive a cycle (name or uuid)")).action(run(setArchived(true)));
  withScope(g.command("unarchive <cycle>").description("Restore an archived cycle (name or uuid)")).action(
    run(setArchived(false))
  );
  withScope(g.command("transfer <cycle>").description("Move every issue from <cycle> to another cycle"))
    .option("--to <cycle>", "destination cycle (name or uuid)")
    .action(run(transfer));
  withScope(g.command("issues <cycle>").description("List the issues in a cycle (name or uuid)")).action(
    run(listIssues)
  );
  withScope(g.command("add-issue <cycle>").description("Add a work item to a cycle"))
    .option("--issue <id>", "work item, e.g. WEB-123")
    .action(run(addIssue));
  withScope(g.command("remove-issue <cycle>").description("Remove a work item from a cycle"))
    .option("--issue <id>", "work item, e.g. WEB-123")
    .action(run(removeIssue));
};
