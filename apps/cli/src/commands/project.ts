/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList } from "../format";
import { usageError } from "../errors";
import { run } from "../output";
import {
  getWorkspace,
  fetchAll,
  printView,
  resolveProject,
  withScope,
  type Project,
  type ScopeOptions,
} from "../resolve";

export const registerProject = (program: Command) => {
  const g = program.command("project").description("List and view projects");

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
};
