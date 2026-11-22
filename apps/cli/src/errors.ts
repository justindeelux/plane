/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Exit codes from the output contract (PLAN.md Part 4b). */
export const EXIT = { ok: 0, general: 1, usage: 2, auth: 3, notFound: 4, rateLimit: 5 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.general,
    readonly code: string = "error",
    readonly status?: number
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage, "usage");
