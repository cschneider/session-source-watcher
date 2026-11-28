// SPDX-License-Identifier: Apache-2.0
import type { Urgency } from "../../core/model.js";
import type { ObservedItem, ReadInput, ReadResult, ReadUnit, SourceAdapter, UnitResult } from "../../core/source.js";
import { GitHubApi, GitHubError } from "./api.js";

export interface PullRequestLocator {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

const MAX_PAGES = 10;
const OVERLAP_MS = 60_000;
const FULL_COMMENTS_EVERY_MS = 3_600_000;
const TEXT_LIMIT = 2000;
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);

const UNITS: readonly ReadUnit[] = [
  { name: "state", category: "state", model: "snapshot" },
  { name: "reviews", category: "reviews", model: "snapshot" },
  { name: "comments.issue", category: "comments", model: "delta" },
  { name: "comments.review", category: "comments", model: "delta" },
  { name: "checks", category: "checks", model: "snapshot" },
  { name: "statuses", category: "checks", model: "snapshot" },
];

const REVIEW_STATES: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function time(value: unknown): number | undefined {
  const ms = Date.parse(str(value));
  return Number.isFinite(ms) ? ms : undefined;
}

function login(value: unknown): string {
  return str((value as Json | null)?.["login"]);
}

function text(value: unknown): string {
  return str(value).slice(0, TEXT_LIMIT);
}

export function parsePullRequestUrl(input: string): PullRequestLocator {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error(`Not a pull request URL: ${input}`);
  }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || !match) throw new Error(`Not a pull request URL: ${input}`);
  return { host: url.host.toLowerCase(), owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export class GitHubPullRequestSource implements SourceAdapter<PullRequestLocator> {
  readonly type = "github.pull_request";
  readonly categories = ["state", "commits", "reviews", "comments", "checks"] as const;
  readonly units = UNITS;
  readonly defaults = { cadenceS: 120, minCadenceS: 30, until: ["merged", "closed"] } as const;

  constructor(private readonly api: GitHubApi = new GitHubApi()) {}

  canonicalize(input: unknown): { key: string; locator: PullRequestLocator; url: string } {
    const raw = typeof input === "string" ? input : str((input as Json | null)?.["url"]);
    const locator = parsePullRequestUrl(raw);
    return {
      key: `${locator.host}/${locator.owner}/${locator.repo}#${locator.number}`.toLowerCase(),
      locator,
      url: `https://${locator.host}/${locator.owner}/${locator.repo}/pull/${locator.number}`,
    };
  }

  resolveAccount(locator: PullRequestLocator): Promise<string> {
    return this.api.login(locator.host);
  }

  urgency(category: string, summary: Record<string, string | number>, kind: string): Urgency {
    if (kind === "transition" || kind === "removed" && category === "reviews") return "immediate";
    switch (category) {
      case "reviews":
        return "immediate";
      case "checks":
        if (summary["failing"] === 1) return "immediate";
        return "passive";
      case "state":
        return "batched";
      default:
        return "batched";
    }
  }

  async read(input: ReadInput<PullRequestLocator>): Promise<ReadResult> {
    const { locator } = input;
    const base = `/repos/${locator.owner}/${locator.repo}`;
    const units: Record<string, UnitResult> = {};
    const cache = { ...input.cache };
    const nextDueS: Record<string, number> = {};
    const wanted = (unit: string) => {
      const category = UNITS.find((u) => u.name === unit)?.category;
      return unit === "state" || (category !== undefined && input.categories.includes(category));
    };
    const due = (unit: string) => wanted(unit) && (input.final || input.dueUnits.includes(unit));
    const result: ReadResult = { units, cache, nextDueS };
    const signal = input.signal;
    let stop: GitHubError | undefined;

    // 1. Pull request state, every tick, conditional.
    let pr: Json | undefined;
    let updatedHint = false;
    let headSha = str(input.items.get("head")?.projection["sha"]);
    try {
      const response = await this.api.get<Json>(locator.host, `${base}/pulls/${locator.number}`, { etag: cache["state"], signal });
      if (response.status === 304) {
        units["state"] = { outcome: "unchanged" };
      } else {
        pr = response.body!;
        if (response.etag) cache["state"] = response.etag;
        const updatedAt = str(pr["updated_at"]);
        updatedHint = cache["state.updatedAt"] !== updatedAt;
        cache["state.updatedAt"] = updatedAt;
        headSha = str((pr["head"] as Json)?.["sha"]);
        units["state"] = { outcome: "full", items: this.stateItems(pr) };
      }
      nextDueS["state"] = input.cadenceS;
    } catch (error) {
      return this.fail(result, error, "state");
    }

    const prState = (pr ?? input.items.get("pr")?.projection) as Json | undefined;
    const merged = pr ? pr["merged"] === true : prState?.["state"] === "merged";
    const state = pr ? str(pr["state"]) : str(prState?.["state"]);
    result.terminal = merged ? "merged" : state === "closed" ? "closed" : undefined;

    // 2. Reviews and comments when hinted, due, or on the final sweep.
    const hinted = (unit: string) => wanted(unit) && (updatedHint || due(unit));
    const run = async (unit: string, fn: () => Promise<UnitResult>, nextS: number) => {
      if (stop) return;
      try {
        units[unit] = await fn();
      } catch (error) {
        const gh = error instanceof GitHubError ? error : new GitHubError("server", String(error));
        units[unit] = { outcome: "failed", error: gh.message };
        if (gh.kind === "rate-limit" || gh.kind === "auth") stop = gh;
      }
      nextDueS[unit] = nextS;
    };

    if (hinted("reviews")) await run("reviews", () => this.reviews(input, base, cache), input.cadenceS * 10);
    if (hinted("comments.issue")) {
      await run("comments.issue", () => this.comments(input, `${base}/issues/${locator.number}/comments`, "comment", "comments.issue"), input.cadenceS * 10);
    }
    if (hinted("comments.review")) {
      await run(
        "comments.review",
        () => this.comments(input, `${base}/pulls/${locator.number}/comments`, "review-comment", "comments.review", "&sort=updated&direction=asc"),
        input.cadenceS * 10,
      );
    }

    // 3. Checks and statuses for the current head.
    if (headSha && (due("checks") || due("statuses"))) {
      let pendingChecks = false;
      if (wanted("checks")) {
        await run("checks", async () => {
          const items = await this.checks(input, base, headSha, cache);
          if (items === "unchanged") return { outcome: "unchanged" };
          pendingChecks ||= items.length === 0 || items.some((item) => item.projection["status"] !== "completed");
          return { outcome: "full", items, scope: `check:${headSha}:` };
        }, input.cadenceS);
        await run("statuses", async () => {
          const items = await this.statuses(input, base, headSha, cache);
          if (items === "unchanged") return { outcome: "unchanged" };
          pendingChecks ||= items.some((item) => item.projection["state"] === "pending");
          return { outcome: "full", items, scope: `status:${headSha}:` };
        }, input.cadenceS);
        const known = [...input.items.values()].filter((item) => item.key.startsWith(`check:${headSha}:`));
        const settled = !pendingChecks && known.length > 0 && known.every((item) => item.projection["status"] === "completed");
        nextDueS["checks"] = nextDueS["statuses"] = settled ? input.cadenceS * 3 : input.cadenceS;
      }
    }

    if (this.api.rateLimit) result.rateLimit = this.api.rateLimit;
    if (stop) result.error = { kind: stop.kind, message: stop.message, ...(stop.retryAfterS ? { retryAfterS: stop.retryAfterS } : {}) };
    return result;
  }

  private fail(result: ReadResult, error: unknown, unit: string): ReadResult {
    const gh = error instanceof GitHubError ? error : new GitHubError("server", String(error));
    result.units[unit] = { outcome: "failed", error: gh.message };
    result.error = { kind: gh.kind, message: gh.message, ...(gh.retryAfterS ? { retryAfterS: gh.retryAfterS } : {}) };
    if (this.api.rateLimit) result.rateLimit = this.api.rateLimit;
    return result;
  }

  private stateItems(pr: Json): ObservedItem[] {
    const head = pr["head"] as Json;
    const base = pr["base"] as Json;
    const merged = pr["merged"] === true;
    const state = merged ? "merged" : str(pr["state"]);
    const htmlUrl = str(pr["html_url"]);
    const sha = str(head?.["sha"]);
    return [
      {
        key: "pr",
        category: "state",
        version: str(pr["updated_at"]),
        projection: {
          state,
          draft: pr["draft"] === true,
          title: text(pr["title"]).slice(0, 200),
          baseRef: str(base?.["ref"]),
          headRef: str(head?.["ref"]),
        },
        transitionFields: ["state", "draft"],
        actor: merged ? login(pr["merged_by"]) : undefined,
        occurredAt: time(pr["merged_at"] ?? pr["closed_at"] ?? pr["updated_at"]),
        summary: {
          what: "pull request",
          detail: pr["draft"] === true && state === "open" ? "draft" : state,
          actor: merged ? login(pr["merged_by"]) : "",
          url: htmlUrl,
          settled: 1,
        },
      },
      {
        key: "head",
        category: "commits",
        version: sha,
        projection: { sha },
        summary: { what: "new commit", detail: sha.slice(0, 7), url: `${htmlUrl}/commits/${sha}` },
      },
    ];
  }

  private async pages<T>(
    input: ReadInput<PullRequestLocator>,
    path: string,
    etag?: string,
  ): Promise<{ items: T[]; complete: boolean; etag?: string | undefined; unchanged: boolean }> {
    const items: T[] = [];
    let next: string | undefined = path;
    let firstEtag: string | undefined;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const response: Awaited<ReturnType<GitHubApi["get"]>> = await this.api.get<T[]>(input.locator.host, next, {
        etag: page === 0 ? etag : undefined,
        signal: input.signal,
      });
      if (response.status === 304) return { items, complete: true, unchanged: true };
      if (page === 0) firstEtag = response.etag;
      items.push(...((response.body as T[]) ?? []));
      next = response.next;
    }
    return { items, complete: next === undefined, etag: firstEtag, unchanged: false };
  }

  private async reviews(input: ReadInput<PullRequestLocator>, base: string, cache: Record<string, string>): Promise<UnitResult> {
    const read = await this.pages<Json>(input, `${base}/pulls/${input.locator.number}/reviews?per_page=100`, cache["reviews"]);
    if (read.unchanged) return { outcome: "unchanged" };
    const items = read.items.map((review): ObservedItem => {
      const state = str(review["state"]);
      return {
        key: `review:${str(review["id"])}`,
        category: "reviews",
        version: str(review["id"]),
        projection: { state, submittedAt: str(review["submitted_at"]), body: text(review["body"]) },
        actor: login(review["user"]),
        occurredAt: time(review["submitted_at"]),
        summary: {
          what: "review",
          detail: REVIEW_STATES[state] ?? state.toLowerCase(),
          actor: login(review["user"]),
          quote: str(review["body"]),
          url: str(review["html_url"]),
          settled: 1,
        },
      };
    });
    if (!read.complete) return { outcome: "partial", items };
    if (read.etag) cache["reviews"] = read.etag;
    return { outcome: "full", items };
  }

  private async comments(
    input: ReadInput<PullRequestLocator>,
    path: string,
    prefix: string,
    unit: string,
    extra = "",
  ): Promise<UnitResult> {
    const checkpoint = input.checkpoints.get(unit);
    const full = input.final || !checkpoint?.cursor || !checkpoint.lastFullAt || input.now - checkpoint.lastFullAt >= FULL_COMMENTS_EVERY_MS;
    const sinceMs = !full && checkpoint?.cursor ? Date.parse(checkpoint.cursor) - OVERLAP_MS : undefined;
    const since = sinceMs !== undefined && Number.isFinite(sinceMs) ? `&since=${new Date(sinceMs).toISOString()}` : "";
    const read = await this.pages<Json>(input, `${path}?per_page=100${extra}${since}`);
    let cursor = checkpoint?.cursor ?? "";
    const items = read.items.map((comment): ObservedItem => {
      const updatedAt = str(comment["updated_at"]);
      if (updatedAt > cursor) cursor = updatedAt;
      const line = comment["line"] ?? comment["original_line"];
      const filePath = str(comment["path"]);
      return {
        key: `${prefix}:${str(comment["id"])}`,
        category: "comments",
        version: updatedAt,
        projection: { body: text(comment["body"]), author: login(comment["user"]), path: filePath, line: line ?? null },
        actor: login(comment["user"]),
        occurredAt: time(updatedAt),
        summary: {
          what: prefix === "comment" ? "comment" : "review comment",
          actor: login(comment["user"]),
          path: filePath ? `${filePath}${line ? `:${String(line)}` : ""}` : "",
          quote: str(comment["body"]),
          url: str(comment["html_url"]),
        },
      };
    });
    const watermark = cursor || new Date(input.now).toISOString();
    // Without a watermark, a partial first read starts delta reads from now.
    if (!read.complete) return checkpoint?.cursor ? { outcome: "partial", items } : { outcome: "partial", items, cursor: new Date(input.now).toISOString() };
    if (full) return { outcome: "full", items, cursor: watermark };
    return { outcome: "delta", items, cursor: watermark };
  }

  private async checks(
    input: ReadInput<PullRequestLocator>,
    base: string,
    sha: string,
    cache: Record<string, string>,
  ): Promise<ObservedItem[] | "unchanged"> {
    const key = `checks:${sha}`;
    const response = await this.api.get<{ check_runs?: Json[] }>(input.locator.host, `${base}/commits/${sha}/check-runs?per_page=100`, {
      etag: cache[key],
      signal: input.signal,
    });
    if (response.status === 304) return "unchanged";
    for (const k of Object.keys(cache)) if (k.startsWith("checks:") && k !== key) delete cache[k];
    if (response.etag) cache[key] = response.etag;
    const latest = new Map<string, Json>();
    for (const run of response.body?.check_runs ?? []) {
      const app = str((run["app"] as Json | null)?.["id"]) || "app";
      const id = `${app}:${str(run["name"])}`;
      const current = latest.get(id);
      if (!current || str(run["started_at"]) >= str(current["started_at"])) latest.set(id, run);
    }
    return [...latest.entries()].map(([id, run]): ObservedItem => {
      const status = str(run["status"]);
      const conclusion = str(run["conclusion"]);
      const detail = status === "completed" ? conclusion || "completed" : status;
      return {
        key: `check:${sha}:${id}`,
        category: "checks",
        projection: { id: str(run["id"]), status, conclusion },
        occurredAt: time(run["completed_at"] ?? run["started_at"]),
        summary: {
          what: `check ${str(run["name"])}`,
          detail,
          url: str(run["html_url"]),
          failing: FAILING.has(conclusion) ? 1 : 0,
          intermediate: status === "completed" ? 0 : 1,
        },
      };
    });
  }

  private async statuses(
    input: ReadInput<PullRequestLocator>,
    base: string,
    sha: string,
    cache: Record<string, string>,
  ): Promise<ObservedItem[] | "unchanged"> {
    const key = `statuses:${sha}`;
    const response = await this.api.get<{ statuses?: Json[] }>(input.locator.host, `${base}/commits/${sha}/status`, {
      etag: cache[key],
      signal: input.signal,
    });
    if (response.status === 304) return "unchanged";
    for (const k of Object.keys(cache)) if (k.startsWith("statuses:") && k !== key) delete cache[k];
    if (response.etag) cache[key] = response.etag;
    return (response.body?.statuses ?? []).map((status): ObservedItem => {
      const state = str(status["state"]);
      return {
        key: `status:${sha}:${str(status["context"])}`,
        category: "checks",
        projection: { state, description: text(status["description"]).slice(0, 200) },
        occurredAt: time(status["updated_at"]),
        summary: {
          what: `status ${str(status["context"])}`,
          detail: state,
          url: str(status["target_url"]),
          failing: FAILING.has(state) ? 1 : 0,
          intermediate: state === "pending" ? 1 : 0,
        },
      };
    });
  }
}
