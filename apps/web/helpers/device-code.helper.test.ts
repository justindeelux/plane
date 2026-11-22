/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { normalizeUserCode } from "./device-code.helper";

describe("normalizeUserCode", () => {
  it("accepts the canonical form", () => expect(normalizeUserCode("ABCD-EFGH")).toBe("ABCD-EFGH"));
  it("uppercases and adds the dash", () => expect(normalizeUserCode("abcdefgh")).toBe("ABCD-EFGH"));
  it("strips whitespace and stray separators", () => expect(normalizeUserCode("  ab cd - ef gh ")).toBe("ABCD-EFGH"));
  it("rejects wrong lengths", () => {
    expect(normalizeUserCode("ABCD-EFG")).toBeNull();
    expect(normalizeUserCode("ABCD-EFGHJ")).toBeNull();
  });
  it("rejects ambiguous characters the backend never issues", () => {
    expect(normalizeUserCode("ABCD-EF0H")).toBeNull();
    expect(normalizeUserCode("ABCD-EF1H")).toBeNull();
    expect(normalizeUserCode("ABCD-EFIH")).toBeNull();
    expect(normalizeUserCode("ABCD-EFOH")).toBeNull();
  });
  it("rejects empty and missing input", () => {
    expect(normalizeUserCode("")).toBeNull();
    expect(normalizeUserCode(null)).toBeNull();
    expect(normalizeUserCode(undefined)).toBeNull();
  });
});
