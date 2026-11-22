/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { registerApi } from "./api";
import { registerAuth } from "./auth";
import { registerConfig } from "./config";

/** Add a command by importing its `register*` function and listing it here; no other file changes. */
export const commands: Array<(program: Command) => void> = [registerAuth, registerConfig, registerApi];
