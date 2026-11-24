/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { fetchAll, isUuid, printView, type Project } from "../resolve";
import { CliError, EXIT, usageError } from "../errors";
import { printList } from "../format";
import { run, success } from "../output";
import { common, ctxOf, fetchIssue, findIssueGroup, identifierOf, base, type Ctx, type Opts } from "./issue";

interface Link {
  id: string;
  title?: string | null;
  url: string;
  created_at?: string;
  [k: string]: unknown;
}
interface LinkOpts extends Opts {
  url?: string;
  title?: string;
}

const pathOf = (c: Ctx, p: Project, issue: string) => `${base(c, p)}/work-items/${issue}/links`;
const checkId = (id: string) => {
  if (!isUuid(id)) throw usageError("link id must be a UUID");
  return id;
};
const checkUrl = (value: string) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError("link URL must use HTTP or HTTPS");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError("link URL must use HTTP or HTTPS");
  }
  return value;
};
const readBack = (c: Ctx, path: string, id: string) => c.client.get<Link>(`${path}/${id}/`, { expect: ["id", "url"] });

const list = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project } = await fetchIssue(c, ref);
  const items = await fetchAll<Link>(c.client, `${pathOf(c, project, issue.id)}/`);
  printList(
    "links",
    ["TITLE", "URL", "ID"],
    items.map((link) => [link.title ?? "", link.url, link.id]),
    items
  );
};

const view = async (ref: string, linkId: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  checkId(linkId);
  const { issue, project } = await fetchIssue(c, ref);
  const link = await readBack(c, pathOf(c, project, issue.id), linkId);
  printView(link.title || link.url, link, [
    ["id", link.id],
    ["title", link.title],
    ["url", link.url],
    ["created", link.created_at],
  ]);
};

const add = async (ref: string, o: LinkOpts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  if (!o.url) throw usageError("--url is required");
  const url = checkUrl(o.url);
  const { issue, project } = await fetchIssue(c, ref);
  const ident = identifierOf(project, issue);
  const path = `${pathOf(c, project, issue.id)}/`;
  const created = await c.client.post<Link>(
    path,
    { url, ...(o.title === undefined ? {} : { title: o.title }) },
    {
      expect: ["id"],
    }
  );
  const stored = await readBack(c, pathOf(c, project, issue.id), created.id);
  if (stored.url !== url) throw new CliError("server did not apply the link URL", EXIT.general, "not_applied");
  success(`Added link ${stored.title ? `"${stored.title}" ` : ""}to ${ident}`, "added", stored);
};

const edit = async (ref: string, linkId: string, o: LinkOpts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  checkId(linkId);
  const patch: Record<string, unknown> = {};
  if (o.url !== undefined) patch.url = checkUrl(o.url);
  if (o.title !== undefined) patch.title = o.title;
  if (!Object.keys(patch).length) throw usageError("no fields given; pass --url or --title");
  const { issue, project } = await fetchIssue(c, ref);
  const ident = identifierOf(project, issue);
  const path = pathOf(c, project, issue.id);
  await c.client.patch<Link>(`${path}/${linkId}/`, patch, { expect: ["id"] });
  const stored = await readBack(c, path, linkId);
  if (patch.url !== undefined && stored.url !== patch.url) {
    throw new CliError("server did not apply the link URL", EXIT.general, "not_applied");
  }
  success(`Updated link ${linkId} on ${ident}`, "updated", stored);
};

const remove = async (ref: string, linkId: string, o: Opts, cmd: Command) => {
  if (!o.yes) throw usageError("deletion requires --yes");
  const c = ctxOf(cmd, o);
  checkId(linkId);
  const { issue, project } = await fetchIssue(c, ref);
  const ident = identifierOf(project, issue);
  await c.client.delete(`${pathOf(c, project, issue.id)}/${linkId}/`);
  success(`Deleted link ${linkId} from ${ident}`, "deleted", { id: linkId, issue: ident, deleted: true });
};

export const registerLink = (program: Command) => {
  const issue = findIssueGroup(program);
  const g = issue.command("link").description("Manage external links on work items");

  common(g.command("list <issue>").description("List links on a work item")).action(run(list));
  common(g.command("view <issue> <link>").description("Show a link")).action(run(view));
  common(g.command("add <issue>").description("Add a link"))
    .requiredOption("--url <url>", "HTTP or HTTPS URL")
    .option("--title <title>", "link title")
    .action(run(add));
  common(g.command("edit <issue> <link>").description("Update a link"))
    .option("--url <url>", "new HTTP or HTTPS URL")
    .option("--title <title>", "new title")
    .action(run(edit));
  common(g.command("delete <issue> <link>").description("Delete a link"))
    .option("--yes", "confirm deletion")
    .action(run(remove));
};
