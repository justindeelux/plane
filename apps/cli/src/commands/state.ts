/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList } from "../format";
import { usageError } from "../errors";
import { readBool, readText } from "../input";
import { run, success } from "../output";
import { writeAndRead } from "../write";
import { fetchAll, requireProject, resolveNamed, printView, withScope, type ScopeOptions } from "../resolve";

interface State {
  id: string;
  name: string;
  color?: string;
  group?: string;
  default?: boolean;
  sequence?: number;
  [k: string]: unknown;
}
interface StateWriteOptions {
  name?: string;
  color?: string;
  group?: string;
  default?: string;
  description?: string;
  descriptionFile?: string;
  yes?: boolean;
}
type StateOptions = StateWriteOptions & ScopeOptions;

const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];
const statesPath = (workspace: string, projectId: string) => `workspaces/${workspace}/projects/${projectId}/states`;

const stateFields = (c: Command) =>
  c
    .option("--name <name>", "state name")
    .option("--color <color>", "display color, e.g. #f59e0b")
    .option("--group <group>", GROUPS.join("|"))
    .option("--default <true|false>", "make this the project's default state")
    .option("--description <markdown>", "description text (`-` reads stdin)")
    .option("--description-file <path>", "read description from a file (`-` = stdin)");

const payload = async (o: StateWriteOptions) => {
  const data: Record<string, unknown> = {};
  if (o.name !== undefined) data.name = o.name;
  if (o.color !== undefined) data.color = o.color;
  if (o.group !== undefined) {
    if (!GROUPS.includes(o.group)) throw usageError(`--group must be one of ${GROUPS.join(", ")}`);
    data.group = o.group;
  }
  const isDefault = readBool("--default", o.default);
  if (isDefault !== undefined) data.default = isDefault;
  const description = await readText(o.description, o.descriptionFile, "--description");
  if (description !== undefined) data.description = description;
  return data;
};

const list = async (o: StateOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const items = await fetchAll<State>(client, `${statesPath(workspace, project.id)}/`);
  printList(
    "states",
    ["NAME", "GROUP", "COLOR", "DEFAULT", "ID"],
    items.map((s) => [s.name, s.group, s.color, s.default ? "yes" : "no", s.id]),
    items
  );
};

const view = async (ref: string, o: StateOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const s = await resolveNamed<State>(client, statesPath(workspace, project.id), "state", ref);
  printView(s.name, s, [
    ["id", s.id],
    ["group", s.group],
    ["color", s.color],
    ["default", s.default ? "yes" : "no"],
    ["sequence", s.sequence],
  ]);
};

const create = async (o: StateOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.name) throw usageError("--name is required");
  if (!o.color) throw usageError("--color is required");
  if (!o.group) throw usageError("--group is required");
  const s = await writeAndRead<State>(client, `${statesPath(workspace, project.id)}/`, "POST", await payload(o));
  success(`Created state "${s.name}" in ${project.identifier}`, "created", s);
};

const edit = async (ref: string, o: StateOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const found = await resolveNamed<State>(client, statesPath(workspace, project.id), "state", ref);
  const data = await payload(o);
  const keys = Object.keys(data);
  if (!keys.length) {
    throw usageError("no fields given; pass at least one of --name, --color, --group, --default, --description");
  }
  const s = await writeAndRead<State>(client, `${statesPath(workspace, project.id)}/${found.id}/`, "PATCH", data);
  success(`Updated state "${s.name}": ${keys.join(", ")}`, "updated", s);
};

const remove = async (ref: string, o: StateOptions, cmd: Command) => {
  if (!o.yes) throw usageError("--yes is required to delete a state");
  const { client, workspace, project } = await requireProject(cmd, o);
  const found = await resolveNamed<State>(client, statesPath(workspace, project.id), "state", ref);
  await client.delete(`${statesPath(workspace, project.id)}/${found.id}/`);
  success(`Deleted state "${found.name}"`, "deleted", { id: found.id, deleted: true });
};

export const registerState = (program: Command) => {
  const g = program.command("state").description("List and manage workflow states");

  withScope(g.command("list").description("List states in a project")).action(run(list));
  withScope(g.command("view <state>").description("Show a state (name or uuid)")).action(run(view));
  stateFields(withScope(g.command("create").description("Create a state"))).action(run(create));
  stateFields(withScope(g.command("edit <state>").description("Edit a state (name or uuid)"))).action(run(edit));
  withScope(g.command("delete <state>").description("Delete a state (name or uuid)"))
    .option("--yes", "confirm permanent deletion")
    .action(run(remove));
};
