/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList } from "../format";
import { usageError } from "../errors";
import { readText } from "../input";
import { run, success } from "../output";
import { writeAndRead } from "../write";
import { fetchAll, requireProject, resolveNamed, printView, withScope, type ScopeOptions } from "../resolve";

interface Label {
  id: string;
  name: string;
  color?: string;
  [k: string]: unknown;
}
interface LabelWriteOptions {
  name?: string;
  color?: string;
  description?: string;
  descriptionFile?: string;
  yes?: boolean;
}
type LabelOptions = LabelWriteOptions & ScopeOptions;

const labelsPath = (workspace: string, projectId: string) => `workspaces/${workspace}/projects/${projectId}/labels`;

const labelFields = (c: Command) =>
  c
    .option("--name <name>", "label name")
    .option("--color <color>", "display color, e.g. #f59e0b")
    .option("--description <markdown>", "description text (`-` reads stdin)")
    .option("--description-file <path>", "read description from a file (`-` = stdin)");

const payload = async (o: LabelWriteOptions) => {
  const data: Record<string, unknown> = {};
  if (o.name !== undefined) data.name = o.name;
  if (o.color !== undefined) data.color = o.color;
  const description = await readText(o.description, o.descriptionFile, "--description");
  if (description !== undefined) data.description = description;
  return data;
};

const list = async (o: LabelOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const items = await fetchAll<Label>(client, `${labelsPath(workspace, project.id)}/`);
  printList(
    "labels",
    ["NAME", "COLOR", "ID"],
    items.map((l) => [l.name, l.color, l.id]),
    items
  );
};

const view = async (ref: string, o: LabelOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const l = await resolveNamed<Label>(client, labelsPath(workspace, project.id), "label", ref);
  printView(l.name, l, [
    ["id", l.id],
    ["color", l.color],
  ]);
};

const create = async (o: LabelOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  if (!o.name) throw usageError("--name is required");
  if (!o.color) throw usageError("--color is required");
  const l = await writeAndRead<Label>(client, `${labelsPath(workspace, project.id)}/`, "POST", await payload(o));
  success(`Created label "${l.name}" in ${project.identifier}`, "created", l);
};

const edit = async (ref: string, o: LabelOptions, cmd: Command) => {
  const { client, workspace, project } = await requireProject(cmd, o);
  const found = await resolveNamed<Label>(client, labelsPath(workspace, project.id), "label", ref);
  const data = await payload(o);
  const keys = Object.keys(data);
  if (!keys.length) throw usageError("no fields given; pass at least one of --name, --color, --description");
  const l = await writeAndRead<Label>(client, `${labelsPath(workspace, project.id)}/${found.id}/`, "PATCH", data);
  success(`Updated label "${l.name}": ${keys.join(", ")}`, "updated", l);
};

const remove = async (ref: string, o: LabelOptions, cmd: Command) => {
  if (!o.yes) throw usageError("--yes is required to delete a label");
  const { client, workspace, project } = await requireProject(cmd, o);
  const found = await resolveNamed<Label>(client, labelsPath(workspace, project.id), "label", ref);
  await client.delete(`${labelsPath(workspace, project.id)}/${found.id}/`);
  success(`Deleted label "${found.name}"`, "deleted", { id: found.id, deleted: true });
};

export const registerLabel = (program: Command) => {
  const g = program.command("label").description("List and manage work item labels");

  withScope(g.command("list").description("List labels in a project")).action(run(list));
  withScope(g.command("view <label>").description("Show a label (name or uuid)")).action(run(view));
  labelFields(withScope(g.command("create").description("Create a label"))).action(run(create));
  labelFields(withScope(g.command("edit <label>").description("Edit a label (name or uuid)"))).action(run(edit));
  withScope(g.command("delete <label>").description("Delete a label (name or uuid)"))
    .option("--yes", "confirm permanent deletion")
    .action(run(remove));
};
