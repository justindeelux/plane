/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { Client } from "./client";
import { requireAuth, resolve, type Resolved } from "./config";
import { getOutput } from "./output";

export interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
  debug?: boolean;
  host?: string;
}

export const debugLog = (msg: string) => process.stderr.write(`[debug] ${msg}\n`);

/** Authenticated client + resolved settings for any command that talks to the server. */
export const getClient = (cmd: Command): { client: Client; resolved: Resolved & { url: string; token: string } } => {
  const resolved = requireAuth(resolve(cmd.optsWithGlobals<GlobalOptions>().host));
  const client = new Client({
    url: resolved.url,
    token: resolved.token,
    ...(getOutput().debug ? { debug: debugLog } : {}),
  });
  return { client, resolved };
};
