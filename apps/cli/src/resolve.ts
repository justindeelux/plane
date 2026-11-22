/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { htmlToMarkdown } from "@plane/markdown";
import type { Client, Page } from "./client";
import { getClient } from "./context";
import { CliError, EXIT, usageError } from "./errors";
import { bold, dim } from "./format";
import { getOutput, print } from "./output";

/** Options every read command shares. */
export interface ScopeOptions {
  workspace?: string;
  project?: string;
}

export const withScope = (c: Command, project = true): Command => {
  c.option("--workspace <slug>", "workspace slug (default: configured workspace)");
  return project
    ? c.option("--project <project>", "project identifier, name or uuid (default: configured project)")
    : c;
};

export interface Project {
  id: string;
  name: string;
  identifier: string;
  [k: string]: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

export interface Scope {
  client: Client;
  workspace: string;
  project?: Project;
}

export const getWorkspace = (cmd: Command, o: ScopeOptions) => {
  const { client, resolved } = getClient(cmd);
  const workspace = o.workspace ?? resolved.workspace;
  if (!workspace) throw usageError("no workspace set; pass --workspace or run `plane config set workspace <slug>`");
  return { client, workspace, configProject: resolved.project };
};

/** Fetch every item, following cursors; tolerates the bare array some endpoints (current cycle) return. */
export const fetchAll = async <T>(
  client: Client,
  path: string,
  query: Record<string, string> = {},
  limit = Infinity
) => {
  const first = await client.get<Page<T> | T[]>(path, { query: { per_page: 100, ...query } });
  if (Array.isArray(first)) return first.slice(0, limit);
  return client.paginate<T>(path, query, limit);
};

const notFound = (what: string, ref: string, names: string[]) =>
  new CliError(
    `${what} "${ref}" not found${names.length ? `; available: ${names.slice(0, 20).join(", ")}` : ""}`,
    EXIT.notFound,
    "not_found",
    404
  );

/** Resolve a project by uuid, identifier (case-insensitive) or exact name. */
export const resolveProject = async (client: Client, workspace: string, ref: string): Promise<Project> => {
  if (isUuid(ref)) return client.get<Project>(`workspaces/${workspace}/projects/${ref}/`);
  const all = await fetchAll<Project>(client, `workspaces/${workspace}/projects/`);
  const low = ref.toLowerCase();
  const hit = all.find((p) => p.identifier?.toLowerCase() === low) ?? all.find((p) => p.name?.toLowerCase() === low);
  if (!hit)
    throw notFound(
      "project",
      ref,
      all.map((p) => `${p.identifier} (${p.name})`)
    );
  return hit;
};

export const requireProject = async (cmd: Command, o: ScopeOptions): Promise<Scope & { project: Project }> => {
  const { client, workspace, configProject } = getWorkspace(cmd, o);
  const ref = o.project ?? configProject;
  if (!ref) throw usageError("no project set; pass --project or run `plane config set project <identifier>`");
  return { client, workspace, project: await resolveProject(client, workspace, ref) };
};

/** Resolve a cycle/module by uuid or exact name within a project. */
export const resolveNamed = async <T extends { id: string; name: string }>(
  client: Client,
  base: string,
  what: string,
  ref: string
): Promise<T> => {
  if (isUuid(ref)) return client.get<T>(`${base}/${ref}/`);
  const all = await fetchAll<T>(client, `${base}/`);
  const low = ref.toLowerCase();
  const hit = all.find((x) => x.name?.toLowerCase() === low);
  if (!hit)
    throw notFound(
      what,
      ref,
      all.map((x) => x.name)
    );
  return hit;
};

/** Description as Markdown: prefer description_html (string), else plain description. */
export const descriptionMarkdown = (item: Record<string, unknown>): string | undefined => {
  const html = item.description_html;
  if (typeof html === "string" && html.trim()) return htmlToMarkdown(html).trim();
  return typeof item.description === "string" && item.description.trim() ? item.description.trim() : undefined;
};

export const withMarkdown = <T extends Record<string, unknown>>(item: T) => {
  const md = descriptionMarkdown(item);
  return md === undefined ? item : { ...item, description_markdown: md };
};

export interface IssueRow {
  id: string;
  sequence_id: number;
  name: string;
  state?: { name?: string } | string | null;
  [k: string]: unknown;
}
export const stateName = (s: IssueRow["state"]) => (s && typeof s === "object" ? (s.name ?? "") : (s ?? ""));

/** Human `key: value` block; skips empty values. */
export const fields = (rows: Array<[string, unknown]>) =>
  rows
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${dim(`${k}:`.padEnd(11))} ${String(v)}`)
    .join("\n");

export const heading = (s: string) => bold(s);

/** Print a view: JSON = raw object (+ description_markdown, + issues when given); human = fields + description + issues. */
export const printView = (
  title: string,
  item: Record<string, unknown>,
  rows: Array<[string, unknown]>,
  issues?: { rows: string; items: unknown[] }
) => {
  if (getOutput().json) {
    print("", { ...withMarkdown(item), ...(issues ? { issues: issues.items } : {}) });
    return;
  }
  const md = descriptionMarkdown(item);
  print(
    [heading(title), fields(rows), md ? `\n${md}` : "", issues ? `\n${issues.rows}` : ""].filter(Boolean).join("\n")
  );
};
