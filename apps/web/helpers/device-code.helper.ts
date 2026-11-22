/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Alphabet the backend generates user codes from (no 0/O/1/I), see plane/db/models/device_authorization.py
const USER_CODE_REGEX = /^[A-HJ-NP-Z2-9]{8}$/;

/**
 * Normalises what a person typed into the XXXX-XXXX form the API expects.
 * Strips separators/whitespace and uppercases. Returns null if it is not a valid code.
 */
export const normalizeUserCode = (input: string | null | undefined): string | null => {
  const compact = (input ?? "").replace(/[\s-]/g, "").toUpperCase();
  return USER_CODE_REGEX.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null;
};
