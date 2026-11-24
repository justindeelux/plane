/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { printList } from "../format";
import { run } from "../output";
import { fetchAll, requireProject, withScope, type ScopeOptions } from "../resolve";

interface Member {
  id: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  [k: string]: unknown;
}

const memberName = (m: Member) =>
  m.display_name || [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email || m.id;

export const registerMember = (program: Command) => {
  const g = program.command("member").description("List project members");

  withScope(g.command("list").description("List members of a project")).action(
    run(async (o: ScopeOptions, cmd: Command) => {
      const { client, workspace, project } = await requireProject(cmd, o);
      const items = await fetchAll<Member>(client, `workspaces/${workspace}/projects/${project.id}/members/`);
      printList(
        "members",
        ["NAME", "EMAIL", "ID"],
        items.map((m) => [memberName(m), m.email, m.id]),
        items
      );
    })
  );
};
