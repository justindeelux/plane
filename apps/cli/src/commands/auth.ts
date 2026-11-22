/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { Client } from "../client";
import { debugLog, getClient, type GlobalOptions } from "../context";
import { CliError, EXIT, usageError } from "../errors";
import { findProfile, hostOf, loadConfig, normalizeUrl, resolve, saveConfig } from "../config";
import { getOutput, noop, print, run, success } from "../output";

interface User {
  id: string;
  display_name?: string;
  email?: string;
}
const who = (u: User) => u.display_name || u.email || u.id;

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY)
    throw usageError("--with-token reads the token from stdin, e.g. `echo $TOKEN | plane auth login --with-token`");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
};

export const registerAuth = (program: Command) => {
  const auth = program.command("auth").description("Log in and out of a Plane server");

  auth
    .command("login")
    .description("Log in to a Plane server")
    .option("--with-token", "read an API token from stdin")
    .option("--url <url>", "Plane web URL, e.g. https://plane.example.com")
    .option("--workspace <slug>", "workspace slug")
    .action(
      run(async (o: { withToken?: boolean; url?: string; workspace?: string }, cmd: Command) => {
        if (!o.withToken) {
          throw new CliError(
            "browser login is not available yet; use `plane auth login --with-token --url <url> --workspace <slug>` and pipe an API token on stdin",
            EXIT.general,
            "not_available"
          );
        }
        const token = await readStdin();
        if (!token) throw usageError("no token received on stdin");
        const cfg = loadConfig();
        const existing = findProfile(cfg, cmd.optsWithGlobals<GlobalOptions>().host)?.profile;
        const rawUrl = o.url ?? process.env.PLANE_URL ?? existing?.url;
        if (!rawUrl) throw usageError("--url is required (or set PLANE_URL)");
        const url = normalizeUrl(rawUrl);
        const workspace =
          o.workspace ?? process.env.PLANE_WORKSPACE ?? (existing?.url === url ? existing.workspace : undefined);
        if (!workspace) throw usageError("--workspace is required (or set PLANE_WORKSPACE)");

        const client = new Client({ url, token, ...(getOutput().debug ? { debug: debugLog } : {}) });
        const user = await client.get<User>("users/me/", { expect: ["id"] });
        try {
          await client.get(`workspaces/${encodeURIComponent(workspace)}/projects/`, { query: { per_page: 1 } });
        } catch (e) {
          if (e instanceof CliError && e.status === 404) {
            throw new CliError(
              `workspace "${workspace}" not found on ${hostOf(url)}`,
              EXIT.notFound,
              "workspace_not_found",
              404
            );
          }
          throw e;
        }
        const key = hostOf(url);
        cfg.profiles[key] = { ...(existing && existing.url === url ? existing : {}), url, token, workspace };
        cfg.current = key;
        saveConfig(cfg);
        success(`Logged in to ${key} as ${who(user)} (workspace: ${workspace})`, "login", {
          host: key,
          url,
          workspace,
          user,
        });
      })
    );

  auth
    .command("status")
    .description("Show the current login")
    .action(
      run(async (_o: unknown, cmd: Command) => {
        const r = resolve(cmd.optsWithGlobals<GlobalOptions>().host);
        const { client, resolved } = getClient(cmd);
        const user = await client.get<User>("users/me/", { expect: ["id"] });
        const source = process.env.PLANE_API_TOKEN ? "PLANE_API_TOKEN" : "config file";
        print(
          `Logged in to ${hostOf(resolved.url)} as ${who(user)} (workspace: ${resolved.workspace ?? "not set"}; token from ${source})`,
          {
            host: hostOf(resolved.url),
            url: resolved.url,
            workspace: resolved.workspace ?? null,
            user,
            profile: r.profile ?? null,
          }
        );
      })
    );

  auth
    .command("logout")
    .description("Remove the stored login")
    .action(
      run(async (_o: unknown, cmd: Command) => {
        const cfg = loadConfig();
        const found = findProfile(cfg, cmd.optsWithGlobals<GlobalOptions>().host);
        if (!found) return noop("Not logged in, nothing to do");
        delete cfg.profiles[found.key];
        if (cfg.current === found.key) {
          const rest = Object.keys(cfg.profiles);
          if (rest.length) cfg.current = rest[rest.length - 1]!;
          else delete cfg.current;
        }
        saveConfig(cfg);
        success(`Logged out of ${found.key}`, "logout", { host: found.key });
      })
    );

  auth
    .command("token")
    .description("Print the API token in use")
    .action(
      run(async (_o: unknown, cmd: Command) => {
        const { resolved } = getClient(cmd);
        print(resolved.token, { token: resolved.token });
      })
    );
};
