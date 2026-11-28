// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Connection } from "../src/protocol/connection.js";
import type { PendingView, WatchView } from "../src/protocol/methods.js";
import { FakeAdapter, flush, startHarness, user, type Harness } from "./helpers.js";

let h: Harness;
let adapter: FakeAdapter;

async function addWatch(source = "test://pr", extra: Record<string, unknown> = {}): Promise<WatchView> {
  return adapter.request<WatchView>("watch.add", { source, reason: "waiting for review", ...extra });
}

async function cycle(): Promise<void> {
  await h.daemon.collect();
  await h.daemon.deliver();
  await flush();
}

beforeEach(async () => {
  h = await startHarness();
  adapter = await FakeAdapter.connect(h.paths);
});

afterEach(async () => {
  adapter.close();
  await h.cleanup();
});

describe("daemon", () => {
  it("rejects a client without the secret", async () => {
    const connection = await new Promise<Connection>((resolve) => {
      const socket = connect(h.paths.socket, () => resolve(new Connection(socket)));
    });
    await flush();
    await assert.rejects(
      connection.request("hello", { protocol: 1, role: "cli", client: "x", proof: "0".repeat(64) }),
      /Authentication failed/,
    );
    connection.close();
  });

  it("baselines, then delivers a change and closes the packet on acknowledgement", async () => {
    h.source.items = [h.source.comment("1", "old comment")];
    const watch = await addWatch();
    assert.equal(watch.origin, "agent");
    assert.ok(watch.expiresAt, "agent watches always expire");
    await cycle();
    assert.equal(adapter.delivered.length, 0, "existing content is the baseline");

    h.source.items.push(h.source.comment("2", "Please fix the cache key"));
    h.clock.advance(61_000);
    await cycle();
    assert.equal(adapter.delivered.length, 1);
    const packet = adapter.last();
    assert.match(packet.text, /Please fix the cache key/);
    assert.match(packet.text, new RegExp(watch.label));
    assert.equal(packet.urgency, "immediate");

    const ack = await adapter.request<{ assessed: number; packetClosed: boolean }>("watch.ack", { packet: packet.packet, outcome: "handled" });
    assert.deepEqual(ack, { assessed: 1, packetClosed: true });
    const pending = await adapter.request<PendingView>("watch.pending");
    assert.equal(pending.events.length, 0);
  });

  it("keeps one outstanding packet per session", async () => {
    await addWatch();
    await cycle();
    h.source.items = [h.source.comment("1", "first")];
    h.clock.advance(61_000);
    await cycle();
    h.source.items.push(h.source.comment("2", "second"));
    h.clock.advance(61_000);
    await cycle();
    assert.equal(adapter.delivered.length, 1, "second change waits for the first packet");
    await adapter.request("packet.progress", { packet: adapter.last().packet, epoch: adapter.epoch, status: "completed" });
    await h.daemon.deliver();
    await flush();
    assert.equal(adapter.delivered.length, 2);
    assert.match(adapter.last().text, /second/);
    const pending = await adapter.request<PendingView>("watch.pending");
    assert.ok(pending.events.some((event) => event.state === "unacknowledged"), "completion without assessment is visible");
  });

  it("suppresses the session's own write, reported before or after the poll", async () => {
    await addWatch();
    await cycle();
    await adapter.request("writes.report", { writes: [{ source: "test://pr", item: "comment:10", change: "create" }] });
    h.source.items = [h.source.comment("10", "my own reply")];
    h.clock.advance(61_000);
    await h.daemon.collect();
    // Late report: the poll already recorded the change.
    h.source.items.push(h.source.comment("11", "another own reply"));
    h.clock.advance(61_000);
    await h.daemon.collect();
    await adapter.request("writes.report", { writes: [{ source: "test://pr", item: "comment:11", change: "create" }] });
    await h.daemon.deliver();
    await flush();
    assert.equal(adapter.delivered.length, 0);

    h.source.items.push(h.source.comment("12", "someone else"));
    h.clock.advance(61_000);
    await cycle();
    assert.equal(adapter.delivered.length, 1);
    assert.match(adapter.last().text, /someone else/);
    assert.doesNotMatch(adapter.last().text, /own reply/);
  });

  it("does not suppress the same write for another session", async () => {
    const other = await FakeAdapter.connect(h.paths, "session-2");
    try {
      await addWatch();
      await other.request("watch.add", { source: "test://pr", reason: "also waiting" });
      await cycle();
      await adapter.request("writes.report", { writes: [{ source: "test://pr", item: "comment:5", change: "create" }] });
      h.source.items = [h.source.comment("5", "reply from session one")];
      h.clock.advance(61_000);
      await cycle();
      assert.equal(adapter.delivered.length, 0);
      assert.equal(other.delivered.length, 1);
    } finally {
      other.close();
    }
  });

  it("reconciles an unknown admission instead of resending", async () => {
    adapter.answer = () => ({ status: "unknown", reason: "connection reset" });
    await addWatch();
    await cycle();
    h.source.items = [h.source.comment("1", "change")];
    h.clock.advance(61_000);
    await cycle();
    assert.equal(adapter.delivered.length, 1);
    h.clock.advance(5_000);
    await cycle();
    assert.equal(adapter.delivered.length, 1, "no blind resend");

    adapter.reconcileAnswer = () => ({ status: "consumed" });
    h.clock.advance(61_000);
    await cycle();
    const pending = await adapter.request<PendingView>("watch.pending");
    assert.equal(pending.packets[0]?.state, "consumed");
    assert.equal(adapter.delivered.length, 1);
  });

  it("closes a packet that stays unconfirmed, leaving its events visible", async () => {
    adapter.answer = () => ({ status: "unknown" });
    await addWatch();
    await cycle();
    h.source.items = [h.source.comment("1", "change")];
    h.clock.advance(61_000);
    await cycle();
    h.clock.advance(11 * 60_000);
    await h.daemon.deliver();
    const pending = await adapter.request<PendingView>("watch.pending");
    assert.equal(pending.packets[0]?.closeReason, "unconfirmed");
    assert.equal(pending.events[0]?.state, "unacknowledged");
  });

  it("retries a packet that was not admitted, with the same ID", async () => {
    let calls = 0;
    adapter.answer = () => (++calls === 1 ? { status: "not-admitted", reason: "busy" } : { status: "admitted", receipt: "m" });
    await addWatch();
    await cycle();
    h.source.items = [h.source.comment("1", "change")];
    h.clock.advance(61_000);
    await cycle();
    h.clock.advance(31_000);
    await h.daemon.deliver();
    await flush();
    assert.equal(adapter.delivered.length, 2);
    assert.equal(adapter.delivered[0]!.packet, adapter.delivered[1]!.packet);
  });

  it("refuses an agent re-adding a watch the user removed", async () => {
    const watch = await addWatch();
    const cli = await user(h.paths);
    try {
      await cli.request("watch.remove", { session: adapter.bindingId, watch: watch.label });
      await assert.rejects(addWatch(), /user removed/);
      const again = await cli.request<WatchView>("watch.add", { session: adapter.bindingId, source: "test://pr" });
      assert.equal(again.origin, "user");
    } finally {
      cli.close();
    }
  });

  it("refuses an adapter acting with user authority", async () => {
    await assert.rejects(adapter.request("escalation.resolve", { event: "x" }), /user authority/);
    await assert.rejects(adapter.request("watch.list", { session: "someone-else" }), /own watches/);
  });

  it("invalidates pending events when a watch is paused", async () => {
    const watch = await addWatch(undefined, { policy: { urgency: { comments: "batched" } } });
    await cycle();
    h.source.items = [h.source.comment("1", "change")];
    h.clock.advance(61_000);
    await h.daemon.collect();
    await adapter.request("watch.pause", { watch: watch.label });
    h.clock.advance(120_000);
    await cycle();
    assert.equal(adapter.delivered.length, 0);
    const conflict = adapter.request("watch.resume", { watch: watch.label, expectedRevision: 1 });
    await assert.rejects(conflict, /changed since revision 1/);
  });

  it("batches non-urgent changes", async () => {
    await addWatch(undefined, { policy: { urgency: { comments: "batched" } } });
    await cycle();
    h.source.items = [h.source.comment("1", "a")];
    h.clock.advance(61_000);
    await cycle();
    assert.equal(adapter.delivered.length, 0, "waits for the batch window");
    h.clock.advance(61_000);
    await cycle();
    assert.equal(adapter.delivered.length, 1);
  });

  it("completes the watch after a final sweep on a terminal state", async () => {
    const watch = await addWatch();
    h.source.items = [{ key: "state", category: "state", projection: { state: "open" }, transitionFields: ["state"], summary: { what: "resource", detail: "open" } }];
    await cycle();
    h.source.items = [{ key: "state", category: "state", projection: { state: "closed" }, transitionFields: ["state"], summary: { what: "resource", detail: "closed" } }];
    h.source.terminal = "closed";
    h.clock.advance(61_000);
    await h.daemon.collect();
    await h.daemon.collect();
    await h.daemon.deliver();
    await flush();
    assert.match(adapter.last().text, /open -&gt; closed|open -> closed/);
    const { watches } = await adapter.request<{ watches: WatchView[] }>("watch.list");
    assert.equal(watches.find((w) => w.id === watch.id)?.state, "completed");
    const readsBefore = h.source.reads;
    h.clock.advance(10 * 60_000);
    await h.daemon.collect();
    assert.equal(h.source.reads, readsBefore, "collection stopped");
  });

  it("blocks a collector on authentication failure", async () => {
    await addWatch();
    h.source.fail = { kind: "auth", message: "bad token" };
    await h.daemon.collect();
    const status = await adapter.request<{ collectors: Array<{ health: string }> }>("status");
    assert.equal(status.collectors[0]?.health, "blocked");
  });

  it("reports existing content once with baseline assess", async () => {
    h.source.items = [h.source.comment("1", "open question")];
    const other = await FakeAdapter.connect(h.paths, "session-2");
    try {
      await other.request("watch.add", { source: "test://pr", reason: "first" });
      await h.daemon.collect();
      await addWatch(undefined, { baseline: "assess" });
      await h.daemon.deliver();
      await flush();
      assert.equal(adapter.delivered.length, 1);
      assert.match(adapter.last().text, /open question/);
      assert.equal(other.delivered.length, 0);
    } finally {
      other.close();
    }
  });
});

describe("daemon restart", () => {
  it("reconciles a packet that was being sent when the daemon stopped", async () => {
    let release: (() => void) | undefined;
    adapter.answer = () => {
      return new Promise<never>((resolve) => {
        release = () => resolve({ status: "admitted", receipt: "late" } as never);
      }) as never;
    };
    await addWatch();
    await cycle();
    h.source.items = [h.source.comment("1", "change")];
    h.clock.advance(61_000);
    await h.daemon.collect();
    void h.daemon.deliver();
    await flush();
    assert.equal(adapter.delivered.length, 1);
    adapter.close();
    release?.();
    const { dir, clock, source } = h;
    await h.daemon.stop();

    h = await startHarness({ dir, clock, source });
    adapter = await FakeAdapter.connect(h.paths);
    adapter.reconcileAnswer = () => ({ status: "completed" });
    await h.daemon.deliver();
    await flush();
    assert.equal(adapter.delivered.length, 0, "reconciled, not resent");
    const pending = await adapter.request<PendingView>("watch.pending");
    assert.equal(pending.events[0]?.state, "unacknowledged");
  });
});

describe("daemon regressions", () => {
  it("keeps the baseline when the first read of a unit fails", async () => {
    h.source.items = [h.source.comment("1", "existing"), h.source.comment("2", "existing too")];
    h.source.fail = { kind: "server", message: "502" };
    await addWatch();
    await h.daemon.collect();
    h.source.fail = undefined;
    h.clock.advance(5 * 60_000);
    await cycle();
    assert.equal(adapter.delivered.length, 0, "existing content is not reported after a failed first read");
  });

  it("keeps only the latest passive event per item", async () => {
    await addWatch(undefined, { policy: { urgency: { comments: "passive" } } });
    await cycle();
    for (const body of ["v1", "v2", "v3"]) {
      h.source.items = [h.source.comment("1", body)];
      h.clock.advance(61_000);
      await cycle();
    }
    const pending = await adapter.request<PendingView>("watch.pending");
    assert.equal(pending.events.length, 1);
    assert.equal(pending.events[0]?.summary["quote"], "v3");
    assert.equal(adapter.delivered.length, 0, "passive events never wake the session");
  });

  it("completes a watch added after the source reached its terminal state", async () => {
    h.source.items = [{ key: "state", category: "state", projection: { state: "closed" }, summary: { what: "resource", detail: "closed" } }];
    h.source.terminal = "closed";
    const first = await addWatch();
    await h.daemon.collect();
    await h.daemon.collect();
    const other = await FakeAdapter.connect(h.paths, "session-2");
    try {
      const second = await other.request<WatchView>("watch.add", { source: "test://pr", reason: "late" });
      h.clock.advance(61_000);
      await h.daemon.collect();
      await h.daemon.collect();
      const { watches } = await other.request<{ watches: WatchView[] }>("watch.list");
      assert.equal(watches.find((w) => w.id === second.id)?.state, "completed");
      const mine = await adapter.request<{ watches: WatchView[] }>("watch.list");
      assert.equal(mine.watches.find((w) => w.id === first.id)?.state, "completed");
    } finally {
      other.close();
    }
  });
});
