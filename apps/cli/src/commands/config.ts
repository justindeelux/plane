/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { CliError, EXIT, usageError } from "../errors";
import { findProfile, loadConfig, normalizeUrl, resolve, saveConfig, SETTABLE_KEYS, type SettableKey } from "../config";
import type { GlobalOptions } from "../context";
import { printList } from "../format";
import { noop, print, run, success } from "../output";

const checkKey = (k: string): SettableKey => {
  if (!(SETTABLE_KEYS as readonly string[]).includes(k))
    throw usageError(`unknown key "${k}"; valid keys: ${SETTABLE_KEYS.join(", ")}`);
  return k as SettableKey;
};

export const registerConfig = (program: Command) => {
  const config = program.command("config").description("Read and write CLI settings");

  config
    .command("get <key>")
    .description(`Print a setting (${SETTABLE_KEYS.join(", ")})`)
    .action(
      run(async (key: string, _o: unknown, cmd: Command) => {
        const k = checkKey(key);
        const v = resolve(cmd.optsWithGlobals<GlobalOptions>().host)[k];
        if (v === undefined) throw new CliError(`${k} is not set`, EXIT.notFound, "not_set");
        print(v, { [k]: v });
      })
    );

  config
    .command("set <key> <value>")
    .description("Change a setting of the current login")
    .action(
      run(async (key: string, value: string, _o: unknown, cmd: Command) => {
        const k = checkKey(key);
        const cfg = loadConfig();
        const found = findProfile(cfg, cmd.optsWithGlobals<GlobalOptions>().host);
        if (!found) throw new CliError("not logged in; run `plane auth login` first", EXIT.auth, "auth");
        const next = k === "url" ? normalizeUrl(value) : value;
        if (found.profile[k] === next) return noop(`${k} is already ${next}, nothing to change`, { [k]: next });
        found.profile[k] = next;
        saveConfig(cfg);
        success(`Set ${k} = ${next}`, "updated", { [k]: next });
      })
    );

  config
    .command("list")
    .description("Show all settings (the token is hidden)")
    .action(
      run(async (_o: unknown, cmd: Command) => {
        const { token: _t, profile, ...rest } = resolve(cmd.optsWithGlobals<GlobalOptions>().host);
        const entries = Object.entries({ ...(profile ? { profile } : {}), ...rest });
        printList("settings", ["KEY", "VALUE"], entries, Object.fromEntries(entries) as never);
      })
    );
};
