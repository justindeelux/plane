#!/usr/bin/env node
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import { commands } from "./commands";
import { EXIT, usageError } from "./errors";
import { fail, setOutput } from "./output";

const buildProgram = (): Command => {
  const program = new Command("plane")
    .description("Command line interface for self-hosted Plane")
    .version(pkg.version)
    .option("--json", "machine-readable JSON output")
    .option("-q, --quiet", "suppress the success line (failures are always printed)")
    .option("--debug", "print stack traces and HTTP debug logs to stderr")
    .option("--host <host>", "use the stored login for this server")
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({ outputError: () => undefined })
    .hook("preAction", (cmd) => {
      const g = cmd.optsWithGlobals<{ json?: boolean; quiet?: boolean; debug?: boolean }>();
      setOutput({ json: !!g.json, quiet: !!g.quiet, debug: !!g.debug });
    });
  for (const register of commands) register(program);
  return program;
};

// exitOverride/outputError must apply to nested subcommands too.
const walk = (c: Command) => {
  c.exitOverride().configureOutput({ outputError: () => undefined });
  c.commands.forEach(walk);
};

const main = async () => {
  const program = buildProgram();
  program.commands.forEach(walk);

  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (!(e instanceof CommanderError)) return fail(e);
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return;
    const flags = new Set(process.argv.slice(2));
    setOutput({ json: flags.has("--json"), debug: flags.has("--debug") });
    // "commander.help" = a command group with no subcommand; help is already on stderr.
    if (e.code === "commander.help") process.exitCode = EXIT.usage;
    else fail(usageError(e.message.replace(/^error: /, "")));
  }
};

await main();
