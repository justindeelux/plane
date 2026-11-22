/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { WRITE } from "../client";
import { getClient } from "../context";
import { usageError } from "../errors";
import { print, run, success } from "../output";

const parseField = (f: string): [string, string] => {
  const i = f.indexOf("=");
  if (i < 1) throw usageError(`invalid field "${f}"; expected key=value`);
  return [f.slice(0, i), f.slice(i + 1)];
};

export const registerApi = (program: Command) => {
  program
    .command("api <path>")
    .description("Make a raw API request under /api/v1 (no Markdown conversion)")
    .option("-X, --method <method>", "HTTP method (default GET, or POST when -f is given)")
    .option(
      "-f, --field <key=value...>",
      "request field; JSON body, or query string for GET",
      (v, a: string[] = []) => [...a, v]
    )
    .action(
      run(async (path: string, o: { method?: string; field?: string[] }, cmd: Command) => {
        const { client } = getClient(cmd);
        const fields = Object.fromEntries((o.field ?? []).map(parseField));
        const hasFields = Object.keys(fields).length > 0;
        const method = (o.method ?? (hasFields ? "POST" : "GET")).toUpperCase();
        const p = path.replace(/^\/+/, "").replace(/^api\/v1\//, "");
        const res = await client.raw(
          method,
          p,
          method === "GET" ? { query: fields } : hasFields ? { body: fields } : {}
        );
        // POST/PATCH/PUT must return a well-formed body (same rule as Client.request); GET/DELETE may be empty.
        if (WRITE.has(method)) client.parseBody(method, p, res);
        if (!res.text.trim())
          return success(`${method} /${p}: ${res.status} ${res.statusText}`.trim(), "request", { status: res.status });
        let out = res.text;
        try {
          out = JSON.stringify(JSON.parse(res.text), null, 2);
        } catch {
          /* print as-is */
        }
        print(out, undefined);
      })
    );
};
