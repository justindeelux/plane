/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { getOutput, print } from "./output";

/** Colour only on a TTY, honouring NO_COLOR. */
export const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
export const dim = (s: string) => (useColor() ? `\u001b[2m${s}\u001b[0m` : s);
export const bold = (s: string) => (useColor() ? `\u001b[1m${s}\u001b[0m` : s);

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Aligned table; tab-separated when not a TTY so it pipes into cut/awk. */
export const table = (headers: string[], rows: unknown[][]): string => {
  const body = rows.map((r) => r.map(cell));
  if (!process.stdout.isTTY) return [headers, ...body].map((r) => r.join("\t")).join("\n");
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [bold(line(headers)), ...body.map(line)].join("\n");
};

/** List output: `--json` → array (`[]` when empty); human → table or "No <noun> match". */
export const printList = (noun: string, headers: string[], rows: unknown[][], items: unknown[]) => {
  if (getOutput().json) print("", items);
  else print(rows.length ? table(headers, rows) : `No ${noun} match`);
};
