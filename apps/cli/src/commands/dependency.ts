/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- dependency cycle walks are inherently sequential */
import type { Command } from "commander";
import { isUuid, resolveProject, type Project } from "../resolve";
import { CliError, EXIT, usageError } from "../errors";
import { table } from "../format";
import { getOutput, noop, print, run, success } from "../output";
import {
  common,
  ctxOf,
  fetchIssue,
  findIssueGroup,
  identifierOf,
  base,
  type Ctx,
  type Issue,
  type Opts,
} from "./issue";

export const RELATIONS = [
  "blocking",
  "blocked_by",
  "relates_to",
  "duplicate",
  "start_before",
  "start_after",
  "finish_before",
  "finish_after",
] as const;
type RelationType = (typeof RELATIONS)[number];

interface Relation {
  project_id: string;
  issue_id: string;
}
type Relations = Record<string, Relation[]>;
interface DependencyOpts extends Opts {
  target?: string;
  targetProject?: string;
  type?: string;
}

const checkType = (value: string): RelationType => {
  if (!RELATIONS.includes(value as RelationType)) throw usageError(`--type must be one of ${RELATIONS.join(", ")}`);
  return value as RelationType;
};

const targetOf = async (c: Ctx, o: DependencyOpts): Promise<{ issue: Issue; project: Project }> => {
  if (!o.target) throw usageError("--target is required");
  if (!o.targetProject) {
    if (isUuid(o.target)) throw usageError("a UUID target needs --target-project");
    return fetchIssue(c, o.target);
  }
  const project = await resolveProject(c.client, c.ws, o.targetProject);
  if (isUuid(o.target)) {
    const issue = await c.client.get<Issue>(`workspaces/${c.ws}/projects/${project.id}/work-items/${o.target}/`, {
      expect: ["id", "project"],
    });
    return { issue, project };
  }
  const found = await fetchIssue({ ...c, project: project.identifier }, o.target);
  if (found.project.id !== project.id) {
    throw usageError(`issue "${o.target}" is not in project ${project.identifier}`);
  }
  return found;
};

/** A blocking edge closes a loop when the destination already reaches the source. */
const checkCycle = async (c: Ctx, source: string, dest: { id: string; project: string }) => {
  const todo = [{ project: dest.project, issue: dest.id }];
  const visited = new Set<string>();
  while (todo.length) {
    const current = todo.pop()!;
    if (current.issue === source) {
      throw new CliError("dependency would create a blocking cycle", EXIT.usage, "cycle");
    }
    if (visited.has(current.issue)) continue;
    visited.add(current.issue);
    const related = await c.client.get<Relations>(
      `workspaces/${c.ws}/projects/${current.project}/work-items/${current.issue}/relations/`
    );
    for (const relation of related.blocking ?? []) {
      todo.push({ project: relation.project_id, issue: relation.issue_id });
    }
  }
};

const list = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project } = await fetchIssue(c, ref);
  const relations = await c.client.get<Relations>(`${base(c, project)}/work-items/${issue.id}/relations/`);
  const rows = Object.entries(relations).flatMap(([type, items]) =>
    (items ?? []).map((relation) => [type, relation.issue_id, relation.project_id])
  );
  if (getOutput().json) print("", relations);
  else print(rows.length ? table(["TYPE", "ISSUE", "PROJECT"], rows) : "No dependencies match");
};

const add = async (ref: string, o: DependencyOpts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const type = checkType(o.type ?? "blocked_by");
  const { issue, project } = await fetchIssue(c, ref);
  const ident = identifierOf(project, issue);
  const { issue: target, project: targetProject } = await targetOf(c, o);
  const targetIdent = identifierOf(targetProject, target);
  if (issue.id === target.id) throw usageError("an issue cannot depend on itself");

  const path = `${base(c, project)}/work-items/${issue.id}/relations/`;
  const relations = await c.client.get<Relations>(path);
  if ((relations[type] ?? []).some((relation) => relation.issue_id === target.id)) {
    noop(`${ident} already has a ${type} relation with ${targetIdent}`, relations);
    return;
  }
  if (type === "blocking") await checkCycle(c, issue.id, { id: target.id, project: targetProject.id });
  if (type === "blocked_by") await checkCycle(c, target.id, { id: issue.id, project: project.id });

  await c.client.post(path, { relation_type: type, issues: [target.id] });
  const stored = await c.client.get<Relations>(path);
  if (!(stored[type] ?? []).some((relation) => relation.issue_id === target.id)) {
    throw new CliError(
      "relation write returned but the requested relation was not found on read-back",
      EXIT.general,
      "not_applied"
    );
  }
  success(`Added ${type} relation ${ident} -> ${targetIdent}`, "added", {
    issue: ident,
    target: targetIdent,
    relation_type: type,
    relations: stored,
  });
};

const remove = async (ref: string, o: DependencyOpts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  checkType(o.type ?? "blocked_by");
  await fetchIssue(c, ref);
  throw new CliError(
    "the API exposes no public dependency deletion route; remove this relation in the Plane UI",
    EXIT.general,
    "unsupported"
  );
};

export const registerDependency = (program: Command) => {
  const issue = findIssueGroup(program);
  const g = issue.command("dependency").description("List and add work item dependencies");

  common(g.command("list <issue>").description("List dependencies grouped by relation type")).action(run(list));
  common(g.command("add <issue>").description("Add a dependency"))
    .requiredOption("--target <id>", "related issue (PROJECT-123, or UUID with --target-project)")
    .option("--target-project <project>", "project of the target issue")
    .option("--type <type>", RELATIONS.join("|"), "blocked_by")
    .action(run(add));
  common(g.command("remove <issue>").description("Remove a dependency (not supported by the v1 API)"))
    .requiredOption("--target <id>", "related issue (PROJECT-123, or UUID with --target-project)")
    .option("--target-project <project>", "project of the target issue")
    .option("--type <type>", RELATIONS.join("|"), "blocked_by")
    .action(run(remove));
};
