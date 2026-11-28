// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ReadErrorKind } from "../../core/source.js";

export class GitHubError extends Error {
  constructor(readonly kind: ReadErrorKind, message: string, readonly retryAfterS?: number) {
    super(message);
  }
}

export interface RateLimit {
  remaining: number;
  limit: number;
  resetAt: number;
}

export interface GitHubResponse<T> {
  status: 200 | 304;
  body?: T;
  etag?: string;
  next?: string;
}

export type TokenProvider = (host: string) => Promise<string>;

export interface GitHubApiOptions {
  fetch?: typeof fetch;
  token?: TokenProvider;
  /** Override API base URLs by host, for tests and proxies. */
  apiBase?: Record<string, string>;
}

/** Token from the GitHub CLI's credential store; never persisted by the watcher. */
export function ghCliToken(host: string): Promise<string> {
  const override = process.env["SSW_GITHUB_TOKEN"];
  if (override) return Promise.resolve(override);
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token", "--hostname", host], { timeout: 10_000 }, (error, stdout) => {
      const token = stdout.trim();
      if (error || !token) reject(new GitHubError("auth", `No GitHub CLI credentials for ${host}. Run "gh auth login --hostname ${host}".`));
      else resolve(token);
    });
  });
}

export function apiBaseFor(host: string, overrides: Record<string, string> = {}): string {
  const env = process.env["SSW_GITHUB_API_BASE"];
  if (overrides[host]) return overrides[host]!;
  if (env) return env;
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

export class GitHubApi {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenFor: TokenProvider;
  private readonly logins = new Map<string, string>();
  rateLimit: RateLimit | undefined;

  constructor(private readonly options: GitHubApiOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.tokenFor = options.token ?? ghCliToken;
  }

  async login(host: string): Promise<string> {
    const token = await this.tokenFor(host);
    const key = `${host}:${createHash("sha256").update(token).digest("hex")}`;
    const cached = this.logins.get(key);
    if (cached) return cached;
    const response = await this.get<{ login: string }>(host, "/user", { signal: AbortSignal.timeout(15_000) });
    const login = response.body?.login;
    if (!login) throw new GitHubError("auth", "GitHub did not return the account for the token");
    this.logins.set(key, login);
    return login;
  }

  async get<T>(
    host: string,
    path: string,
    options: { etag?: string | undefined; signal: AbortSignal },
  ): Promise<GitHubResponse<T>> {
    const url = path.startsWith("http") ? path : `${apiBaseFor(host, this.options.apiBase)}${path}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "session-source-watcher",
      authorization: `Bearer ${await this.tokenFor(host)}`,
    };
    if (options.etag) headers["if-none-match"] = options.etag;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal: options.signal });
    } catch (error) {
      throw new GitHubError("network", error instanceof Error ? error.message : String(error));
    }
    this.recordRateLimit(response.headers);
    if (response.status === 304) return { status: 304 };
    if (response.ok) {
      const body = (await response.json()) as T;
      const result: GitHubResponse<T> = { status: 200, body };
      const etag = response.headers.get("etag");
      if (etag) result.etag = etag;
      const next = nextLink(response.headers.get("link"));
      if (next) result.next = next;
      return result;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 429 || (response.status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && retryAfter > 0))) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number.isFinite(reset) ? Math.max(1, reset - Date.now() / 1000) : 60;
      throw new GitHubError("rate-limit", `GitHub rate limit reached (${response.status})`, Math.ceil(wait));
    }
    if (response.status === 401) throw new GitHubError("auth", "GitHub rejected the credentials (401)");
    if (response.status === 403) throw new GitHubError("auth", "GitHub denied access (403)");
    if (response.status === 404) throw new GitHubError("not-found", "GitHub resource not found (404)");
    throw new GitHubError("server", `GitHub returned ${response.status}`);
  }

  private recordRateLimit(headers: Headers): void {
    const remaining = Number(headers.get("x-ratelimit-remaining"));
    const limit = Number(headers.get("x-ratelimit-limit"));
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && headers.get("x-ratelimit-limit") !== null) {
      this.rateLimit = { remaining, limit, resetAt: Number.isFinite(reset) ? reset * 1000 : Date.now() + 3_600_000 };
    }
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}
