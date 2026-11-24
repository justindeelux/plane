/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { fetchAll } from "../resolve";
import { printList } from "../format";
import { run } from "../output";
import { common, ctxOf, fetchIssue, findIssueGroup, members, personName, type Named, type Opts } from "./issue";

interface Activity {
  id: string;
  verb?: string;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  actor?: string | null;
  created_at?: string;
}

const when = (value?: string) => (value ? value.slice(0, 19).replace("T", " ") : "");
const actorOf = (activity: Activity, mem: Named[]) => {
  const found = activity.actor ? mem.find((m) => m.id === activity.actor) : undefined;
  return found ? personName(found) : (activity.actor ?? "-");
};
const changeOf = (activity: Activity) =>
  activity.field ? `${activity.old_value ?? "-"} -> ${activity.new_value ?? "-"}` : (activity.new_value ?? "-");

const list = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project } = await fetchIssue(c, ref);
  const [items, mem] = await Promise.all([
    fetchAll<Activity>(c.client, `workspaces/${c.ws}/projects/${project.id}/work-items/${issue.id}/activities/`),
    members(c, project),
  ]);
  printList(
    "activities",
    ["WHEN", "ACTOR", "ACTION", "FIELD", "CHANGE"],
    items.map((activity) => [
      when(activity.created_at),
      actorOf(activity, mem),
      activity.verb ?? "",
      activity.field ?? "",
      changeOf(activity),
    ]),
    items
  );
};

export const registerActivity = (program: Command) => {
  const issue = findIssueGroup(program);
  const g = issue.command("activity").description("Read work item activity");

  common(g.command("list <issue>").description("List activity for a work item")).action(run(list));
};
