/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- retries and cursor pages are inherently sequential */
import { CliError, EXIT } from "./errors";

export interface ClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  debug?: (msg: string) => void;
}
export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Keys the returned object must contain (writes always require a non-empty JSON object). */
  expect?: string[];
}
export interface RawResponse {
  status: number;
  statusText: string;
  text: string;
}
export interface Page<T> {
  results: T[];
  next_cursor?: string;
  next_page_results?: boolean;
}

export const WRITE = new Set(["POST", "PATCH", "PUT"]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const retryDelay = (header: string | null, attempt: number): number => {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(secs, 60) * 1000;
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 60_000);
  }
  return Math.min(1000 * 2 ** attempt, 60_000);
};

const detailOf = (text: string): string => {
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      const d = o.error ?? o.detail ?? o.message;
      return typeof d === "string" ? d : JSON.stringify(j);
    }
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 200);
};

export class ApiError extends CliError {
  constructor(status: number, statusText: string, detail: string) {
    const exit =
      status === 401 || status === 403
        ? EXIT.auth
        : status === 404
          ? EXIT.notFound
          : status === 429
            ? EXIT.rateLimit
            : EXIT.general;
    const base = `${status} ${statusText}`.trim();
    const hint = status === 401 ? " (token invalid or expired; run `plane auth login`)" : "";
    super(`${base}${detail ? `: ${detail}` : ""}${hint}`, exit, `http_${status}`, status);
  }
}

export class Client {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly o: ClientOptions) {
    this.base = `${o.url.replace(/\/+$/, "")}/api/v1`;
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? defaultSleep;
    this.maxRetries = o.maxRetries ?? 3;
  }

  private urlFor(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(`${this.base}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** One HTTP exchange with 429 retry. Non-2xx throws ApiError; network failure throws exit 5. */
  async raw(method: string, path: string, opts: Pick<RequestOptions, "query" | "body"> = {}): Promise<RawResponse> {
    const url = this.urlFor(path, opts.query);
    const init: RequestInit = {
      method,
      headers: {
        "X-Api-Key": this.o.token,
        Accept: "application/json",
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    };
    for (let attempt = 0; ; attempt++) {
      this.o.debug?.(`${method} ${url}`);
      let res: Response;
      try {
        res = await this.f(url, init);
      } catch (e) {
        throw new CliError(`cannot reach ${this.o.url}: ${(e as Error).message}`, EXIT.rateLimit, "network");
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        const wait = retryDelay(res.headers.get("Retry-After"), attempt);
        this.o.debug?.(`429, retrying in ${wait}ms`);
        await this.sleep(wait);
        continue;
      }
      const text = await res.text();
      this.o.debug?.(`-> ${res.status}`);
      if (!res.ok) throw new ApiError(res.status, res.statusText, detailOf(text));
      return { status: res.status, statusText: res.statusText, text };
    }
  }

  /** Empty (except DELETE 204) or non-JSON 2xx bodies are failures. Returns undefined for DELETE 204. */
  parseBody(method: string, path: string, res: RawResponse): unknown {
    if (!res.text.trim()) {
      if (method === "DELETE" && res.status === 204) return undefined;
      throw new CliError(
        `${method} ${path} returned an empty ${res.status} response`,
        EXIT.general,
        "empty_response",
        res.status
      );
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new CliError(
        `${method} ${path} returned a non-JSON ${res.status} response; is ${this.o.url} a Plane server? (check ${this.o.url}/api/instances/)`,
        EXIT.general,
        "malformed_response",
        res.status
      );
    }
  }

  /** Parsed JSON request. Writes (and any `expect`) must return a non-empty, well-formed object. */
  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    const isWrite = WRITE.has(method);
    const data = this.parseBody(method, path, res);
    if (data === undefined) return undefined as T;
    if (isWrite || opts.expect) {
      const obj = data as Record<string, unknown> | null;
      const missing =
        !obj || typeof obj !== "object" ? ["<object>"] : (opts.expect ?? []).filter((k) => obj[k] == null);
      if (missing.length || (obj && typeof obj === "object" && !Object.keys(obj).length)) {
        throw new CliError(
          `${method} ${path} returned a malformed ${res.status} response (missing ${missing.join(", ") || "body"})`,
          EXIT.general,
          "malformed_response",
          res.status
        );
      }
    }
    return data as T;
  }

  get = <T = unknown>(path: string, opts?: RequestOptions) => this.request<T>("GET", path, opts);
  post = <T = unknown>(path: string, body: unknown, opts?: RequestOptions) =>
    this.request<T>("POST", path, { ...opts, body });
  patch = <T = unknown>(path: string, body: unknown, opts?: RequestOptions) =>
    this.request<T>("PATCH", path, { ...opts, body });
  delete = (path: string) => this.request<void>("DELETE", path);

  /** Follow Plane's cursor pagination, collecting every result (stops at `limit` if given). */
  async paginate<T>(path: string, query: RequestOptions["query"] = {}, limit = Infinity): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.get<Page<T>>(path, { query: { per_page: 100, ...query, cursor } });
      if (!Array.isArray(page.results)) {
        throw new CliError(`GET ${path} returned an unexpected pagination shape`, EXIT.general, "malformed_response");
      }
      all.push(...page.results);
      cursor = page.next_page_results ? page.next_cursor : undefined;
    } while (cursor && all.length < limit);
    return all.slice(0, limit);
  }
}
