// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core/clock.js";
import type { Urgency } from "../src/core/model.js";
import type { ObservedItem, ReadInput, ReadResult, SourceAdapter, UnitResult } from "../src/core/source.js";
import { Daemon } from "../src/daemon/daemon.js";
import { silentLogger } from "../src/daemon/log.js";
import { SourceRegistry } from "../src/daemon/registry.js";
import { connectDaemon } from "../src/protocol/client.js";
import type { Connection } from "../src/protocol/connection.js";
import type { DeliverParams, ProgressReply, ReconcileParams } from "../src/protocol/methods.js";
import { resolvePaths, type Paths } from "../src/protocol/paths.js";

/** A scripted source: tests set the current items and terminal state. */
export class FakeSource implements SourceAdapter<{ name: string }> {
  readonly type = "test.resource";
  readonly categories = ["state", "comments", "checks"] as const;
  readonly units = [
    { name: "state", category: "state", model: "snapshot" as const },
    { name: "comments", category: "comments", model: "snapshot" as const },
  ];
  readonly defaults = { cadenceS: 60, minCadenceS: 10, until: ["closed"] };
  items: ObservedItem[] = [];
  terminal: string | undefined;
  fail: ReadResult["error"] | undefined;
  reads = 0;
  lastInput: ReadInput<{ name: string }> | undefined;

  canonicalize(input: unknown) {
    const raw = typeof input === "string" ? input : String((input as { url?: string }).url);
    const match = /^test:\/\/([\w-]+)$/.exec(raw);
    if (!match) throw new Error(`Not a test resource: ${raw}`);
    return { key: `test/${match[1]}`, locator: { name: match[1]! }, url: `https://test.example/${match[1]}` };
  }

  async resolveAccount(): Promise<string> {
    return "tester";
  }

  urgency(_category: string, summary: Record<string, string | number>): Urgency {
    return (summary["urgency"] as Urgency | undefined) ?? "immediate";
  }

  async read(input: ReadInput<{ name: string }>): Promise<ReadResult> {
    this.reads++;
    this.lastInput = input;
    if (this.fail) return { units: { state: { outcome: "failed", error: this.fail.message } }, cache: input.cache, error: this.fail };
    const units: Record<string, UnitResult> = {
      state: { outcome: "full", items: this.items.filter((i) => i.category === "state") },
      comments: { outcome: "full", items: this.items.filter((i) => i.category === "comments") },
    };
    return { units, cache: input.cache, terminal: this.terminal };
  }

  comment(id: string, body: string, extra: Partial<ObservedItem> = {}): ObservedItem {
    return {
      key: `comment:${id}`,
      category: "comments",
      version: id,
      projection: { body },
      summary: { what: "comment", actor: "reviewer", quote: body, url: `https://test.example/c/${id}` },
      ...extra,
    };
  }
}

export interface Harness {
  daemon: Daemon;
  clock: FakeClock;
  source: FakeSource;
  paths: Paths;
  dir: string;
  cleanup(): Promise<void>;
}

export async function startHarness(existing?: { dir: string; clock: FakeClock; source: FakeSource }): Promise<Harness> {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), "ssw-"));
  const paths = resolvePaths({ SSW_STATE_DIR: dir });
  const clock = existing?.clock ?? new FakeClock();
  const source = existing?.source ?? new FakeSource();
  const registry = new SourceRegistry();
  registry.register(source);
  const daemon = new Daemon({ paths, sources: registry, clock, logger: silentLogger, manual: true, idleExitMs: 0 });
  await daemon.start();
  return {
    daemon,
    clock,
    source,
    paths,
    dir,
    async cleanup() {
      await daemon.stop();
      if (!existing) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fake harness adapter that records deliveries and answers as told. */
export class FakeAdapter {
  delivered: DeliverParams[] = [];
  answer: (params: DeliverParams) => ProgressReply = () => ({ status: "admitted", receipt: "msg-1" });
  reconcileAnswer: (params: ReconcileParams) => ProgressReply = () => ({ status: "unknown" });
  bindingId = "";
  epoch = 0;

  constructor(readonly connection: Connection) {
    connection.onRequest = (method, params) => {
      if (method === "packet.deliver") {
        this.delivered.push(params as DeliverParams);
        return this.answer(params as DeliverParams);
      }
      if (method === "packet.reconcile") return this.reconcileAnswer(params as ReconcileParams);
      throw new Error(`unexpected ${method}`);
    };
  }

  static async connect(paths: Paths, session = "session-1"): Promise<FakeAdapter> {
    const { connection } = await connectDaemon({ role: "adapter", client: "fake", paths });
    const adapter = new FakeAdapter(connection);
    const bound = await connection.request<{ bindingId: string; epoch: number }>("session.bind", {
      harness: "fake",
      hostId: "host-1",
      nativeSessionId: session,
      tier: "message",
    });
    adapter.bindingId = bound.bindingId;
    adapter.epoch = bound.epoch;
    return adapter;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.connection.request<T>(method, params);
  }

  last(): DeliverParams {
    const packet = this.delivered.at(-1);
    if (!packet) throw new Error("nothing delivered");
    return packet;
  }

  close(): void {
    this.connection.close();
  }
}

export async function user(paths: Paths): Promise<Connection> {
  return (await connectDaemon({ role: "cli", client: "test-user", paths })).connection;
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
