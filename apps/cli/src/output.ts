/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CliError, EXIT } from "./errors";

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  debug: boolean;
}

let opts: OutputOptions = { json: false, quiet: false, debug: false };

export const setOutput = (o: Partial<OutputOptions>) => {
  opts = { ...opts, ...o };
};
export const getOutput = (): OutputOptions => opts;

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

/** Print a result on stdout: JSON when --json, else the given human text. */
export const print = (human: string, json?: unknown) => out(opts.json ? JSON.stringify(json ?? human, null, 2) : human);

/** Success: one line naming action/object/location; `--json` returns the item. `--quiet` hides only the line. */
export const success = (line: string, action: string, item?: unknown) => {
  if (opts.json) out(JSON.stringify({ ok: true, action, item: item ?? null }, null, 2));
  else if (!opts.quiet) out(`✓ ${line}`);
};

/** Nothing to change: always said out loud, exit 0. */
export const noop = (line: string, item?: unknown) => {
  if (opts.json) out(JSON.stringify({ ok: true, action: "noop", item: item ?? null }, null, 2));
  else out(line);
};

export const toCliError = (e: unknown): CliError =>
  e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), EXIT.general, "error");

/** Failure: `✗ ...` on stderr (JSON error object on stdout with --json). Sets the exit code. */
export const fail = (e: unknown, what?: string) => {
  const ce = toCliError(e);
  const message = what ? `${what}: ${ce.message}` : ce.message;
  if (opts.json) {
    out(JSON.stringify({ ok: false, error: { code: ce.code, message, status: ce.status ?? null } }, null, 2));
  } else {
    err(`✗ ${message}`);
  }
  if (opts.debug && ce.stack) err(ce.stack);
  process.exitCode = ce.exitCode;
};

/** Wrap a command action so any thrown error becomes a contract failure. */
export const run =
  <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  };
