/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { htmlToMarkdown, markdownToHtml } from "@plane/markdown";
import { fetchAll, isUuid, fields, type Project } from "../resolve";
import { CliError, EXIT, usageError } from "../errors";
import { printList } from "../format";
import { getOutput, print, run, success } from "../output";
import {
  body as bodyOptions,
  common,
  ctxOf,
  fetchIssue,
  identifierOf,
  members,
  personName,
  readBody,
  base,
  type Ctx,
  type Named,
  type Opts,
} from "./issue";

interface Comment {
  id: string;
  comment_html?: string;
  actor?: string | null;
  created_at?: string;
  edited_at?: string | null;
}

const pathOf = (c: Ctx, p: Project, issue: string) => `${base(c, p)}/work-items/${issue}/comments`;
const markdown = (comment: Comment) => (comment.comment_html ? htmlToMarkdown(comment.comment_html).trim() : "");
const firstLine = (text: string) => text.split("\n")[0] ?? "";
const when = (value?: string | null) => (value ? value.slice(0, 10) : "");
const checkId = (id: string, what: string) => {
  if (!isUuid(id)) throw usageError(`${what} must be a UUID`);
  return id;
};
const authorOf = (comment: Comment, mem: Named[]) => {
  const found = comment.actor ? mem.find((m) => m.id === comment.actor) : undefined;
  return found ? personName(found) : (comment.actor ?? "-");
};

const list = async (ref: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  const { issue, project } = await fetchIssue(c, ref);
  const [items, mem] = await Promise.all([
    fetchAll<Comment>(c.client, `${pathOf(c, project, issue.id)}/`),
    members(c, project),
  ]);
  const rows = items.map((item) => [item.id, authorOf(item, mem), when(item.created_at), firstLine(markdown(item))]);
  printList(
    "comments",
    ["ID", "AUTHOR", "CREATED", "BODY"],
    rows,
    items.map((item) => Object.assign({}, item, { body_markdown: markdown(item) }))
  );
};

const view = async (ref: string, commentId: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  checkId(commentId, "comment id");
  const { issue, project } = await fetchIssue(c, ref);
  const [comment, mem] = await Promise.all([
    c.client.get<Comment>(`${pathOf(c, project, issue.id)}/${commentId}/`, { expect: ["id"] }),
    members(c, project),
  ]);
  const ident = identifierOf(project, issue);
  const text = markdown(comment);
  if (getOutput().json) {
    print("", { ...comment, body_markdown: text });
    return;
  }
  print(
    [
      `Comment ${comment.id} on ${ident} ${authorOf(comment, mem)}`,
      fields([
        ["author", authorOf(comment, mem)],
        ["created", comment.created_at],
        ["edited", comment.edited_at],
      ]),
      "",
      text || "(empty comment)",
    ]
      .filter((line) => line !== "")
      .join("\n")
  );
};

const edit = async (ref: string, commentId: string, o: Opts, cmd: Command) => {
  const c = ctxOf(cmd, o);
  checkId(commentId, "comment id");
  const md = await readBody(o, { editor: false });
  if (md === undefined) throw usageError("no comment body given; pass --body or --body-file");
  const { issue, project } = await fetchIssue(c, ref);
  const ident = identifierOf(project, issue);
  const path = `${pathOf(c, project, issue.id)}/${commentId}/`;
  const html = markdownToHtml(md);
  await c.client.patch<Comment>(path, { comment_html: html }, { expect: ["id"] });
  const stored = await c.client.get<Comment>(path, { expect: ["id"] });
  if ((stored.comment_html ?? "").trim() !== html.trim()) {
    throw new CliError(`server did not apply the comment body on ${ident}`, EXIT.general, "not_applied");
  }
  success(`Updated comment ${commentId} on ${ident}`, "updated", { ...stored, body_markdown: md });
};

const remove = async (ref: string, commentId: string, o: Opts, cmd: Command) => {
  if (!o.yes) throw usageError("deletion requires --yes");
  const c = ctxOf(cmd, o);
  checkId(commentId, "comment id");
  const { issue, project } = await fetchIssue(c, ref);
  const ident = identifierOf(project, issue);
  await c.client.delete(`${pathOf(c, project, issue.id)}/${commentId}/`);
  success(`Deleted comment ${commentId} on ${ident}`, "deleted", { id: commentId, issue: ident, deleted: true });
};

export const registerComment = (program: Command) => {
  const g = program.command("comment").description("List, view, edit and delete work item comments");

  common(g.command("list <issue>").description("List comments on a work item")).action(run(list));
  common(g.command("view <issue> <comment>").description("Show a comment")).action(run(view));
  bodyOptions(common(g.command("edit <issue> <comment>").description("Replace a comment body (Markdown)"))).action(
    run(edit)
  );
  common(g.command("delete <issue> <comment>").description("Delete a comment"))
    .option("--yes", "confirm deletion")
    .action(run(remove));
};
