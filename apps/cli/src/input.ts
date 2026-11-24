/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";
import { usageError } from "./errors";

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Text from `--flag` / `--flag-file` / `-` (stdin); undefined when neither is given. */
export const readText = async (value: string | undefined, file: string | undefined, flag: string) => {
  if (value !== undefined && file !== undefined) throw usageError(`use only one of ${flag} and ${flag}-file`);
  if (value === "-" || file === "-") return readStdin();
  if (value !== undefined) return value;
  if (file === undefined) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw usageError(`cannot read ${file}: ${(e as Error).message}`);
  }
};

/** `true`/`false` flag value, or undefined when the flag is absent. */
export const readBool = (flag: string, value?: string) => {
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw usageError(`${flag} must be true or false`);
  return value === "true";
};
