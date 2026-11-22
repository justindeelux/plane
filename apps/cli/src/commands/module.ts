/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList, table } from "../format";
import { run } from "../output";
import {
  fetchAll,
  requireProject,
  resolveNamed,
  printView,
  stateName,
  withScope,
  type IssueRow,
  type ScopeOptions,
} from "../resolve";

interface Module {
  id: string;
  name: string;
  status?: string;
  start_date?: string | null;
  target_date?: string | null;
  total_issues?: number;
  completed_issues?: number;
  lead?: string | null;
  [k: string]: unknown;
}

const date = (d?: string | null) => (d ? d.slice(0, 10) : "");

export const registerModule = (program: Command) => {
  const g = program.command("module").description("List and view modules");

  withScope(g.command("list").description("List modules in a project")).action(
    run(async (o: ScopeOptions, cmd: Command) => {
      const { client, workspace, project } = await requireProject(cmd, o);
      const items = await fetchAll<Module>(client, `workspaces/${workspace}/projects/${project.id}/modules/`);
      printList(
        "modules",
        ["NAME", "STATUS", "START", "TARGET", "ISSUES", "ID"],
        items.map((m) => [
          m.name,
          m.status,
          date(m.start_date),
          date(m.target_date),
          `${m.completed_issues ?? 0}/${m.total_issues ?? 0}`,
          m.id,
        ]),
        items
      );
    })
  );

  withScope(g.command("view <module>").description("Show a module (name or uuid)"))
    .option("--issues", "also list the module's issues")
    .option("--limit <n>", "max issues to list with --issues", "50")
    .action(
      run(async (ref: string, o: ScopeOptions & { issues?: boolean; limit: string }, cmd: Command) => {
        const { client, workspace, project } = await requireProject(cmd, o);
        const base = `workspaces/${workspace}/projects/${project.id}/modules`;
        const m = await resolveNamed<Module>(client, base, "module", ref);
        let issues: { rows: string; items: IssueRow[] } | undefined;
        if (o.issues) {
          const items = await client.paginate<IssueRow>(
            `${base}/${m.id}/module-issues/`,
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
              : "No issues in this module",
          };
        }
        printView(
          m.name,
          m,
          [
            ["id", m.id],
            ["status", m.status],
            ["start", date(m.start_date)],
            ["target", date(m.target_date)],
            ["issues", `${m.completed_issues ?? 0}/${m.total_issues ?? 0} completed`],
            ["lead", m.lead],
          ],
          issues
        );
      })
    );
};
