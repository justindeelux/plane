/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList, table } from "../format";
import { usageError } from "../errors";
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

interface Cycle {
  id: string;
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  total_issues?: number;
  completed_issues?: number;
  owned_by?: string;
  [k: string]: unknown;
}

const STATUSES = ["current", "upcoming", "completed", "draft"];
const date = (d?: string | null) => (d ? d.slice(0, 10) : "");
const statusOf = (c: Cycle, now = Date.now()) => {
  if (!c.start_date && !c.end_date) return "draft";
  if (c.start_date && Date.parse(c.start_date) > now) return "upcoming";
  if (c.end_date && Date.parse(c.end_date) < now) return "completed";
  return "current";
};

export const registerCycle = (program: Command) => {
  const g = program.command("cycle").description("List and view cycles");

  withScope(g.command("list").description("List cycles in a project"))
    .option("--status <status>", `only cycles that are ${STATUSES.join("|")} (server-side filter)`)
    .action(
      run(async (o: ScopeOptions & { status?: string }, cmd: Command) => {
        if (o.status && !STATUSES.includes(o.status))
          throw usageError(`--status must be one of ${STATUSES.join(", ")}`);
        const { client, workspace, project } = await requireProject(cmd, o);
        const items = await fetchAll<Cycle>(
          client,
          `workspaces/${workspace}/projects/${project.id}/cycles/`,
          o.status ? { cycle_view: o.status } : {}
        );
        printList(
          "cycles",
          ["NAME", "STATUS", "START", "END", "ISSUES", "ID"],
          items.map((c) => [
            c.name,
            statusOf(c),
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
        const base = `workspaces/${workspace}/projects/${project.id}/cycles`;
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
            ["owner", c.owned_by],
          ],
          issues
        );
      })
    );
};
