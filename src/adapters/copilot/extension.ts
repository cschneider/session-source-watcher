// SPDX-License-Identifier: Apache-2.0
import { createCanvas, joinSession, type Canvas, type JoinedSession, type ToolResultObject } from "@github/copilot-sdk/extension";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDaemon } from "../../protocol/client.js";
import { RemoteError, type Connection } from "../../protocol/connection.js";
import type { DeliverParams, PendingView, ProgressReply, ProgressStatus, ReconcileParams, WatchView } from "../../protocol/methods.js";
import { resolvePaths } from "../../protocol/paths.js";
import { CanvasServer } from "./canvas.js";
import { sessionContext } from "./guide.js";
import { TOOLS } from "./tools.js";
import { PacketTracker } from "./tracker.js";
import { extractWrites, type WatchedSource } from "./writes.js";

const paths = resolvePaths();
const here = dirname(fileURLToPath(import.meta.url));
const tracker = new PacketTracker();
const MUTATING = new Set(["watch.add", "watch.update", "watch.pause", "watch.resume", "watch.remove"]);

let session: JoinedSession | undefined;
let agent: Connection | undefined;
let epoch = 0;
let bindingId = "";
let watched: WatchedSource[] = [];
let connecting: Promise<Connection> | undefined;
let stopping = false;

function hostId(): string {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.hostId)) writeFileSync(paths.hostId, randomUUID(), { mode: 0o600, flag: "wx" });
  return readFileSync(paths.hostId, "utf8").trim();
}

function daemonCommand(): string[] {
  const configured = process.env["SSW_DAEMON_COMMAND"];
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as unknown;
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) return parsed;
    } catch {
      return configured.split(" ").filter(Boolean);
    }
  }
  const bundled = join(here, "ssw.mjs");
  // The extension may run under a runtime that is not a plain `node` binary.
  const node = /^node(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node";
  return existsSync(bundled) ? [node, bundled, "daemon"] : ["ssw", "daemon"];
}

async function log(message: string, level: "info" | "warning" | "error" = "info"): Promise<void> {
  try {
    await session?.log(`Watcher: ${message}`, { level, ephemeral: level === "info" });
  } catch {
    // The timeline is best effort.
  }
}

async function deliver(params: DeliverParams): Promise<ProgressReply> {
  if (!session) return { status: "not-admitted", reason: "session not joined" };
  if (params.epoch !== epoch) return { status: "unknown", reason: "stale epoch" };
  try {
    const messageId = await session.send({
      prompt: params.text,
      displayPrompt: params.title,
      mode: params.urgency === "immediate" ? "immediate" : "enqueue",
      source: "automation-session-source-watcher",
      clientTurnId: params.packet,
    });
    tracker.recordSend(params.packet, messageId || undefined, !messageId);
    return messageId ? { status: "admitted", receipt: messageId } : { status: "unknown", reason: "no message ID returned" };
  } catch (error) {
    tracker.recordSend(params.packet, undefined, true);
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function reconcile(params: ReconcileParams): Promise<ProgressReply> {
  if (!session) return { status: "unknown", reason: "session not joined" };
  try {
    const history = await session.getEvents();
    return tracker.reconcile(params.packet, history as never);
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function refreshWatched(connection: Connection): Promise<void> {
  try {
    const { watches } = await connection.request<{ watches: WatchView[] }>("watch.list", {});
    watched = watches
      .filter((watch) => watch.state !== "removed")
      .map((watch) => ({ key: watch.source.key, url: watch.source.url, headRef: watch.headRef }));
  } catch {
    // Keep the previous list.
  }
}

async function connect(): Promise<Connection> {
  if (agent && !agent.isClosed) return agent;
  connecting ??= (async () => {
    try {
      const { connection } = await connectDaemon({ role: "adapter", client: "copilot", daemonCommand: daemonCommand() });
      connection.onRequest = (method, params) => {
        if (method === "packet.deliver") return deliver(params as DeliverParams);
        if (method === "packet.reconcile") return reconcile(params as ReconcileParams);
        throw new RemoteError(-32601, `Unknown method ${method}`);
      };
      const bound = await connection.request<{ bindingId: string; epoch: number }>("session.bind", {
        harness: "copilot",
        hostId: hostId(),
        nativeSessionId: session!.sessionId,
        tier: "message",
      });
      bindingId = bound.bindingId;
      epoch = bound.epoch;
      agent = connection;
      connection.onClose(() => {
        agent = undefined;
        if (!stopping) setTimeout(() => void connect().catch(() => {}), 2000).unref?.();
      });
      await refreshWatched(connection);
      return connection;
    } finally {
      connecting = undefined;
    }
  })();
  return connecting;
}

tracker.report = (packet: string, status: ProgressStatus, receipt?: string) => {
  void connect()
    .then((connection) => connection.request("packet.progress", { packet, epoch, status, ...(receipt ? { receipt } : {}) }))
    .catch(() => {
      // Reconciliation after reconnecting covers lost reports.
    });
};

function failure(message: string): ToolResultObject {
  return { textResultForLlm: message, resultType: "failure" };
}

const tools = TOOLS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  // Watch tools only start read-only polling and manage this session's own list.
  skipPermission: true,
  handler: async (args: unknown, invocation: { sessionId: string }): Promise<ToolResultObject> => {
    if (session && invocation.sessionId !== session.sessionId) return failure("This tool belongs to a different session.");
    try {
      const connection = await connect();
      const result = await connection.request(spec.method, args ?? {});
      if (MUTATING.has(spec.method)) await refreshWatched(connection);
      return { textResultForLlm: spec.format(result), resultType: "success" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`Watcher: ${message}`);
    }
  },
}));

// The watch list for the user, served locally; actions here carry user authority.
let ui: Connection | undefined;
async function uiConnection(): Promise<Connection> {
  if (ui && !ui.isClosed) return ui;
  await connect();
  ui = (await connectDaemon({ role: "ui", client: "copilot-canvas", daemonCommand: daemonCommand() })).connection;
  return ui;
}
const canvasServer = new CanvasServer({
  async state() {
    const connection = await uiConnection();
    const list = await connection.request<{ watches: WatchView[]; removed: unknown[] }>("watch.list", { session: bindingId });
    const pending = await connection.request<PendingView>("watch.pending", { session: bindingId });
    return { ...list, pending };
  },
  async action(action, target) {
    const connection = await uiConnection();
    const result =
      action === "resolve"
        ? await connection.request("escalation.resolve", { session: bindingId, event: target })
        : await connection.request(`watch.${action}`, { session: bindingId, watch: target });
    if (agent) await refreshWatched(agent);
    return result;
  },
});

let canvases: Canvas[] = [];
try {
  canvases = [
    createCanvas({
      id: "watch-list",
      displayName: "Watches",
      description: "Watches of this session: what the watcher follows, why, coverage and pending changes.",
      open: async () => ({ url: await canvasServer.start(), title: "Watches" }),
      onClose: () => canvasServer.stop(),
      actions: [
        {
          name: "get_state",
          description: "Read this session's watches and pending changes.",
          handler: async () => (await connect()).request("watch.list", {}),
        },
      ],
    }),
  ];
} catch {
  canvases = [];
}

session = await joinSession({
  tools: { definitions: tools },
  ...(canvases.length ? { canvases: { definitions: canvases } } : {}),
  hooks: {
    onSessionStart: async (input) => {
      try {
        const connection = await Promise.race([
          connect(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000).unref?.()),
        ]);
        if (input.source === "resume") await connection.request("session.lifecycle", { state: "resumed" });
        const { watches } = await connection.request<{ watches: WatchView[] }>("watch.list", {});
        return { additionalContext: sessionContext(watches) };
      } catch (error) {
        void log(`not available (${error instanceof Error ? error.message : String(error)}). Run "ssw doctor".`, "warning");
        return { additionalContext: sessionContext([]) };
      }
    },
    onPostToolUse: (input) => {
      const writes = extractWrites(input.toolName, input.toolArgs, input.toolResult?.textResultForLlm ?? "", watched);
      if (writes.length) void connect().then((connection) => connection.request("writes.report", { writes })).catch(() => {});
    },
    onAgentStop: () => {
      tracker.stopped();
      void agent?.request("session.lifecycle", { state: "idle" }).catch(() => {});
    },
  },
});

session.on((event) => tracker.observe(event as never));
void connect().catch((error: unknown) => void log(`could not reach the daemon: ${error instanceof Error ? error.message : String(error)}`, "warning"));

const shutdown = () => {
  stopping = true;
  canvasServer.stop();
  agent?.close();
  ui?.close();
};
process.once("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.once("beforeExit", shutdown);
