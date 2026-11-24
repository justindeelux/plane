/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList } from "../format";
import { CliError, EXIT, usageError } from "../errors";
import { readBool, readText } from "../input";
import { run, success } from "../output";
import { writeAndRead } from "../write";
import {
  getWorkspace,
  fetchAll,
  printView,
  resolveProject,
  withScope,
  type Project,
  type ScopeOptions,
} from "../resolve";

interface ProjectWriteOptions {
  name?: string;
  identifier?: string;
  description?: string;
  descriptionFile?: string;
  cycles?: string;
  timezone?: string;
  yes?: boolean;
}
type ProjectOptions = ProjectWriteOptions & ScopeOptions;

const projectFields = (c: Command) =>
  c
    .option("--name <name>", "project name")
    .option("--identifier <identifier>", "identifier, e.g. WEB")
    .option("--description <markdown>", "description text (`-` reads stdin)")
    .option("--description-file <path>", "read description from a file (`-` = stdin)")
    .option("--cycles <true|false>", "enable cycles for new work items")
    .option("--timezone <timezone>", "timezone, e.g. Asia/Tokyo");

const payload = async (o: ProjectWriteOptions) => {
  const data: Record<string, unknown> = {};
  if (o.name !== undefined) data.name = o.name;
  if (o.identifier !== undefined) data.identifier = o.identifier;
  const description = await readText(o.description, o.descriptionFile, "--description");
  if (description !== undefined) data.description = description;
  const cycles = readBool("--cycles", o.cycles);
  if (cycles !== undefined) data.cycle_view = cycles;
  if (o.timezone !== undefined) data.timezone = o.timezone;
  return data;
};

const refOf = (ref: string | undefined, configProject: string | undefined) => {
  const want = ref ?? configProject;
  if (!want) throw usageError("no project given; pass <project> or set one with `plane config set project`");
  return want;
};

const create = async (o: ProjectOptions, cmd: Command) => {
  const { client, workspace } = getWorkspace(cmd, o);
  if (!o.name) throw usageError("--name is required");
  if (!o.identifier) throw usageError("--identifier is required");
  const p = await writeAndRead<Project>(client, `workspaces/${workspace}/projects/`, "POST", await payload(o));
  success(`Created project ${p.identifier} "${p.name}"`, "created", p);
};

const edit = async (ref: string | undefined, o: ProjectOptions, cmd: Command) => {
  const { client, workspace, configProject } = getWorkspace(cmd, o);
  const found = await resolveProject(client, workspace, refOf(ref, configProject));
  const data = await payload(o);
  const keys = Object.keys(data);
  if (!keys.length) {
    throw usageError("no fields given; pass at least one of --name, --identifier, --description, --cycles, --timezone");
  }
  const p = await writeAndRead<Project>(client, `workspaces/${workspace}/projects/${found.id}/`, "PATCH", data);
  success(`Updated project ${p.identifier}: ${keys.join(", ")}`, "updated", p);
};

const remove = async (ref: string | undefined, o: ProjectOptions, cmd: Command) => {
  if (!o.yes) throw usageError("--yes is required to delete a project");
  const { client, workspace, configProject } = getWorkspace(cmd, o);
  const found = await resolveProject(client, workspace, refOf(ref, configProject));
  await client.delete(`workspaces/${workspace}/projects/${found.id}/`);
  success(`Deleted project ${found.identifier} "${found.name}"`, "deleted", { id: found.id, deleted: true });
};

const setArchived = (archived: boolean) => async (ref: string | undefined, o: ProjectOptions, cmd: Command) => {
  const { client, workspace, configProject } = getWorkspace(cmd, o);
  const found = await resolveProject(client, workspace, refOf(ref, configProject));
  const path = `workspaces/${workspace}/projects/${found.id}/`;
  await client.request(archived ? "POST" : "DELETE", `${path}archive/`);
  const record = await client.get<Project & { archived_at?: string | null }>(path);
  if (Boolean(record.archived_at) !== archived) {
    throw new CliError("archive change was not confirmed by read-back", EXIT.general, "not_applied");
  }
  success(
    `${archived ? "Archived" : "Unarchived"} project ${record.identifier} "${record.name}"`,
    archived ? "archived" : "unarchived",
    record
  );
};

export const registerProject = (program: Command) => {
  const g = program.command("project").description("List, view and manage projects");

  withScope(g.command("list").description("List projects in the workspace"), false).action(
    run(async (o: ScopeOptions, cmd: Command) => {
      const { client, workspace } = getWorkspace(cmd, o);
      const items = await fetchAll<Project>(client, `workspaces/${workspace}/projects/`);
      printList(
        "projects",
        ["IDENTIFIER", "NAME", "ID"],
        items.map((p) => [p.identifier, p.name, p.id]),
        items
      );
    })
  );

  withScope(g.command("view [project]").description("Show a project (identifier, name or uuid)")).action(
    run(async (ref: string | undefined, o: ScopeOptions, cmd: Command) => {
      const { client, workspace, configProject } = getWorkspace(cmd, o);
      const want = ref ?? o.project ?? configProject;
      if (!want) throw usageError("no project given; pass <project> or set one with `plane config set project`");
      const found = await resolveProject(client, workspace, want);
      // list entries and detail share fields; fetch detail so counts/lead are fresh
      const p = (await client.get<Project>(`workspaces/${workspace}/projects/${found.id}/`)) as Project &
        Record<string, unknown>;
      printView(`${p.name} (${p.identifier})`, p, [
        ["id", p.id],
        ["lead", p.project_lead],
        ["members", p.total_members],
        ["cycles", p.total_cycles],
        ["modules", p.total_modules],
        ["created", p.created_at],
      ]);
    })
  );

  projectFields(withScope(g.command("create").description("Create a project"), false)).action(run(create));
  projectFields(withScope(g.command("edit [project]").description("Edit a project"), false)).action(run(edit));
  withScope(g.command("archive [project]").description("Archive a project"), false).action(run(setArchived(true)));
  withScope(g.command("unarchive [project]").description("Unarchive a project"), false).action(run(setArchived(false)));
  withScope(g.command("delete [project]").description("Delete a project permanently"), false)
    .option("--yes", "confirm permanent deletion")
    .action(run(remove));
};
