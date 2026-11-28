// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Checkpoint, KnownItem, ReadInput, ReadResult } from "../src/core/source.js";
import { GitHubApi } from "../src/sources/github/api.js";
import { GitHubPullRequestSource, parsePullRequestUrl, type PullRequestLocator } from "../src/sources/github/pullRequest.js";

interface Route {
  status?: number;
  body?: unknown;
  etag?: string;
  headers?: Record<string, string>;
}

let server: Server;
let base = "";
let routes = new Map<string, Route | ((query: URLSearchParams, req: { etag?: string }) => Route)>();
const requests: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${url.pathname}${url.search}`);
    const entry = routes.get(url.pathname);
    const route = typeof entry === "function" ? entry(url.searchParams, { etag: String(req.headers["if-none-match"] ?? "") }) : entry;
    if (!route) {
      res.writeHead(404).end("{}");
      return;
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      ...route.headers,
    };
    if (route.etag) {
      headers["etag"] = route.etag;
      if (req.headers["if-none-match"] === route.etag) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    res.writeHead(route.status ?? 200, headers).end(JSON.stringify(route.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(() => server.close());

const repo = "/repos/octo/app";
const sha = "a".repeat(40);

function pr(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    merged: false,
    draft: false,
    title: "Fix cache",
    updated_at: "2027-01-04T09:00:00Z",
    html_url: "https://github.com/octo/app/pull/7",
    head: { sha, ref: "fix-cache" },
    base: { ref: "main" },
    ...overrides,
  };
}

function source(): GitHubPullRequestSource {
  return new GitHubPullRequestSource(new GitHubApi({ token: async () => "t", apiBase: { "github.com": base } }));
}

function input(overrides: Partial<ReadInput<PullRequestLocator>> = {}): ReadInput<PullRequestLocator> {
  return {
    locator: parsePullRequestUrl("https://github.com/octo/app/pull/7"),
    account: "me",
    dueUnits: ["state", "reviews", "comments.issue", "comments.review", "checks", "statuses"],
    categories: ["state", "commits", "reviews", "comments", "checks"],
    items: new Map<string, KnownItem>(),
    checkpoints: new Map<string, Checkpoint>(),
    cache: {},
    final: false,
    cadenceS: 120,
    now: Date.UTC(2027, 0, 4, 10),
    signal: AbortSignal.timeout(5000),
    ...overrides,
  };
}

function itemsOf(result: ReadResult, unit: string) {
  const outcome = result.units[unit];
  return outcome && "items" in outcome ? outcome.items : [];
}

beforeEach(() => {
  requests.length = 0;
  routes = new Map();
  routes.set(`${repo}/pulls/7`, { body: pr(), etag: '"pr1"' });
  routes.set(`${repo}/pulls/7/reviews`, { body: [{ id: 11, state: "CHANGES_REQUESTED", body: "Locale missing", submitted_at: "2027-01-04T09:30:00Z", user: { login: "rev" }, html_url: "https://github.com/octo/app/pull/7#pullrequestreview-11" }] });
  routes.set(`${repo}/issues/7/comments`, { body: [{ id: 21, body: "LGTM", updated_at: "2027-01-04T09:40:00Z", user: { login: "rev" }, html_url: "https://github.com/octo/app/pull/7#issuecomment-21" }] });
  routes.set(`${repo}/pulls/7/comments`, { body: [] });
  routes.set(`${repo}/commits/${sha}/check-runs`, {
    body: {
      check_runs: [
        { id: 1, name: "unit", app: { id: 15 }, status: "completed", conclusion: "success", started_at: "2027-01-04T09:00:00Z", html_url: "https://github.com/octo/app/runs/1" },
        { id: 2, name: "unit", app: { id: 15 }, status: "completed", conclusion: "failure", started_at: "2027-01-04T09:10:00Z", html_url: "https://github.com/octo/app/runs/2" },
      ],
    },
  });
  routes.set(`${repo}/commits/${sha}/status`, { body: { statuses: [{ context: "ci/legacy", state: "pending" }] } });
});

describe("GitHub pull-request source", () => {
  it("canonicalizes pull request URLs", () => {
    const s = source();
    assert.equal(s.canonicalize("https://github.com/Octo/App/pull/7").key, "github.com/octo/app#7");
    assert.throws(() => s.canonicalize("https://github.com/octo/app/issues/7"), /Not a pull request URL/);
    assert.throws(() => s.canonicalize("http://github.com/octo/app/pull/7"), /Not a pull request URL/);
  });

  it("reads every unit and keys checks by head SHA and app", async () => {
    const result = await source().read(input());
    assert.equal(result.error, undefined);
    assert.deepEqual(itemsOf(result, "state").map((i) => i.key), ["pr", "head"]);
    assert.equal(itemsOf(result, "reviews")[0]?.summary["detail"], "changes requested");
    const checks = itemsOf(result, "checks");
    assert.equal(checks.length, 1, "latest run per app and name");
    assert.equal(checks[0]?.key, `check:${sha}:15:unit`);
    assert.equal(checks[0]?.summary["failing"], 1);
    assert.equal(result.units["checks"]?.outcome === "full" && result.units["checks"].scope, `check:${sha}:`);
    assert.equal(itemsOf(result, "statuses")[0]?.summary["intermediate"], 1);
    assert.equal(result.rateLimit?.limit, 5000);
  });

  it("uses ETags and reads reviews only when hinted or due", async () => {
    const s = source();
    const first = await s.read(input());
    requests.length = 0;
    const second = await s.read(input({ cache: first.cache, dueUnits: ["state"] }));
    assert.equal(second.units["state"]?.outcome, "unchanged");
    assert.ok(!requests.some((path) => path.includes("/reviews")), "no review read without a hint");

    routes.set(`${repo}/pulls/7`, { body: pr({ updated_at: "2027-01-04T10:00:00Z" }), etag: '"pr2"' });
    requests.length = 0;
    await s.read(input({ cache: first.cache, dueUnits: ["state"] }));
    assert.ok(requests.some((path) => path.includes("/reviews")), "updated_at moved: reviews read");
  });

  it("reads comments incrementally with an overlapping watermark", async () => {
    const s = source();
    const checkpoints = new Map<string, Checkpoint>([
      ["comments.issue", { unit: "comments.issue", coverage: "complete", cursor: "2027-01-04T09:40:00Z", lastFullAt: Date.UTC(2027, 0, 4, 9, 50), nextDueAt: 0 }],
    ]);
    const result = await s.read(input({ checkpoints, dueUnits: ["state", "comments.issue"] }));
    assert.equal(result.units["comments.issue"]?.outcome, "delta");
    assert.ok(requests.some((path) => path.includes("since=2027-01-04T09%3A39%3A00.000Z") || path.includes("since=2027-01-04T09:39:00.000Z")));
  });

  it("sets a watermark on full comment reads so later reads are incremental", async () => {
    const s = source();
    const result = await s.read(input({ dueUnits: ["state", "comments.issue"] }));
    const outcome = result.units["comments.issue"];
    assert.equal(outcome?.outcome, "full");
    assert.equal(outcome?.outcome === "full" && outcome.cursor, "2027-01-04T09:40:00Z");
  });

  it("marks a unit partial when it has more pages than one tick reads", async () => {
    routes.set(`${repo}/pulls/7/reviews`, (query) => ({
      body: [{ id: Number(query.get("page") ?? 1), state: "COMMENTED", user: { login: "r" } }],
      headers: { link: `<${base}${repo}/pulls/7/reviews?per_page=100&page=${Number(query.get("page") ?? 1) + 1}>; rel="next"` },
    }));
    const result = await source().read(input());
    assert.equal(result.units["reviews"]?.outcome, "partial");
    assert.equal(itemsOf(result, "reviews").length, 10);
  });

  it("reports the terminal state and stops on rate limits", async () => {
    routes.set(`${repo}/pulls/7`, { body: pr({ state: "closed", merged: true, merged_by: { login: "lead" } }) });
    routes.set(`${repo}/pulls/7/reviews`, { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "30" } });
    const result = await source().read(input());
    assert.equal(result.terminal, "merged");
    assert.equal(result.units["reviews"]?.outcome, "failed");
    assert.equal(result.error?.kind, "rate-limit");
    assert.equal(result.error?.retryAfterS, 30);
    assert.equal(result.units["checks"], undefined, "no further reads after a rate limit");
  });

  it("maps authentication failures", async () => {
    routes.set(`${repo}/pulls/7`, { status: 401 });
    const result = await source().read(input());
    assert.equal(result.error?.kind, "auth");
    assert.equal(result.units["state"]?.outcome, "failed");
  });
});
