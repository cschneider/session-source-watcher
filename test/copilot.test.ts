// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionContext } from "../src/adapters/copilot/guide.js";
import { PacketTracker } from "../src/adapters/copilot/tracker.js";
import { extractWrites, type WatchedSource } from "../src/adapters/copilot/writes.js";
import { ulid } from "../src/core/ids.js";

const watched: WatchedSource[] = [{ key: "github.com/octo/app#7", url: "https://github.com/octo/app/pull/7", headRef: "fix-cache" }];

describe("extractWrites", () => {
  it("recognizes a comment created with gh pr comment", () => {
    const writes = extractWrites("bash", { command: "gh pr comment 7 --body done" }, "https://github.com/octo/app/pull/7#issuecomment-123\n", watched);
    assert.deepEqual(writes, [{ source: "https://github.com/octo/app/pull/7", item: "comment:123", change: "create" }]);
  });

  it("recognizes a review and a pushed head commit", () => {
    const review = extractWrites("bash", { command: "gh pr review 7 --approve" }, "https://github.com/octo/app/pull/7#pullrequestreview-9", watched);
    assert.equal(review[0]?.item, "review:9");
    const push = extractWrites("bash", { command: "git push origin fix-cache" }, "To github.com:octo/app.git\n   1a2b3c4..5d6e7f8  fix-cache -> fix-cache\n", watched);
    assert.deepEqual(push, [{ source: "https://github.com/octo/app/pull/7", item: "head", change: "push", version: "5d6e7f8" }]);
  });

  it("ignores read-only commands and unwatched pull requests", () => {
    assert.deepEqual(extractWrites("bash", { command: "gh pr view 7 --comments" }, "https://github.com/octo/app/pull/7#issuecomment-123", watched), []);
    assert.deepEqual(extractWrites("bash", { command: "gh pr comment 8 -b x" }, "https://github.com/octo/app/pull/8#issuecomment-5", watched), []);
    assert.deepEqual(extractWrites("view", { path: "x" }, "https://github.com/octo/app/pull/7#issuecomment-1", watched), []);
  });

  it("records edits with their resulting version", () => {
    const body = '{"id":123,"html_url":"https://github.com/octo/app/pull/7#issuecomment-123","updated_at":"2027-01-04T10:00:00Z"}';
    const writes = extractWrites("bash", { command: "gh api -X PATCH repos/octo/app/issues/comments/123 -f body=x" }, body, watched);
    assert.ok(writes.some((w) => w.change === "update" && w.version === "2027-01-04T10:00:00Z"));
  });

  it("recognizes GitHub MCP tools that create comments", () => {
    const writes = extractWrites("github-mcp-server-add_issue_comment", {}, '{"html_url":"https://github.com/octo/app/pull/7#issuecomment-77"}', watched);
    assert.equal(writes[0]?.item, "comment:77");
  });
});

describe("PacketTracker", () => {
  it("reports consumption and completion of a sent packet", () => {
    const tracker = new PacketTracker();
    const reports: string[] = [];
    tracker.report = (packet, status) => reports.push(`${packet}:${status}`);
    const packet = ulid();
    tracker.recordSend(packet, "m1", false);
    tracker.observe({ type: "user.message", data: { clientTurnId: packet } });
    tracker.observe({ type: "abort", agentId: "sub-1", data: {} });
    assert.deepEqual(reports, [`${packet}:consumed`], "a sub-agent abort is not a stop");
    tracker.stopped();
    assert.deepEqual(reports, [`${packet}:consumed`, `${packet}:completed`]);
  });

  it("reconciles from history and never claims non-admission", () => {
    const tracker = new PacketTracker();
    const sent = ulid();
    const failed = ulid();
    const earlier = ulid();
    tracker.recordSend(sent, "m1", false);
    tracker.recordSend(failed, undefined, true);
    assert.deepEqual(tracker.reconcile(sent, []), { status: "admitted", receipt: "m1" });
    assert.equal(tracker.reconcile(failed, []).status, "unknown");
    assert.equal(tracker.reconcile(earlier, [{ type: "user.message", data: { clientTurnId: earlier } }]).status, "completed");
    assert.equal(tracker.reconcile(sent, [{ type: "user.message", data: { clientTurnId: sent } }]).status, "consumed");
  });
});

describe("sessionContext", () => {
  it("lists the session's active watches after the guide", () => {
    const text = sessionContext([
      {
        id: "x",
        label: "w-abc123",
        source: { type: "github.pull_request", key: "github.com/octo/app#7", url: "https://github.com/octo/app/pull/7" },
        changes: ["reviews"],
        origin: "agent",
        reason: "waiting for review",
        state: "active",
        health: "fresh",
        revision: 1,
        expiresAt: null,
        until: ["merged"],
        checkedAt: null,
        coverage: "complete",
        pending: 0,
      },
    ]);
    assert.match(text, /watch_add/);
    assert.match(text, /w-abc123 github.com\/octo\/app#7 \(reviews\) active: waiting for review/);
  });
});
