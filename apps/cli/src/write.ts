/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Client } from "./client";
import { CliError, EXIT } from "./errors";

/** POST/PATCH, then read the record back so output shows what the server stored. */
export const writeAndRead = async <T extends { id: string }>(
  client: Client,
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>
) => {
  const written =
    method === "POST" ? await client.post<T>(path, body, { expect: ["id"] }) : await client.patch<T>(path, body);
  try {
    return await client.get<T>(method === "POST" ? `${path}${written.id}/` : path, { expect: ["id"] });
  } catch (e) {
    throw new CliError(
      `write succeeded but read-back failed: ${(e as Error).message}`,
      EXIT.general,
      "read_back_failed"
    );
  }
};
