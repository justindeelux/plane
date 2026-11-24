/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { registerActivity } from "./activity";
import { registerApi } from "./api";
import { registerAuth } from "./auth";
import { registerComment } from "./comment";
import { registerConfig } from "./config";
import { registerConvert } from "./convert";
import { registerCycle } from "./cycle";
import { registerDependency } from "./dependency";
import { registerIssue } from "./issue";
import { registerLabel } from "./label";
import { registerMember } from "./member";
import { registerLink } from "./link";
import { registerModule } from "./module";
import { registerProject } from "./project";
import { registerState } from "./state";

/** Add a command by importing its `register*` function and listing it here; no other file changes. */
export const commands: Array<(program: Command) => void> = [
  registerAuth,
  registerConfig,
  registerConvert,
  registerApi,
  registerProject,
  registerCycle,
  registerModule,
  registerIssue,
  registerState,
  registerLabel,
  registerMember,
  registerComment,
  registerDependency,
  registerLink,
  registerActivity,
];
