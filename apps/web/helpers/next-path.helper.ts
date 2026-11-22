/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Sign-in page URL that returns to `pathname + search` after login (query string preserved). */
export const getSignInRedirectUrl = (pathname: string, search = ""): string =>
  pathname ? `/?next_path=${encodeURIComponent(pathname + search)}` : "/";
