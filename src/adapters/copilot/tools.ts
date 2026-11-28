// SPDX-License-Identifier: Apache-2.0
import type { PendingView, WatchView } from "../../protocol/methods.js";

export interface ToolSpec {
  name: string;
  description: string;
  method: string;
  parameters: Record<string, unknown>;
  format: (result: unknown) => string;
}

const watchArg = { type: "string", description: "Watch label such as w-1a2b3c, or its ID" };
const revisionArg = { type: "integer", description: "Revision from watch_list; a stale revision is refused" };
const changesArg = {
  type: "array",
  items: { type: "string", enum: ["state", "commits", "reviews", "comments", "checks"] },
  description: "Change categories to report; defaults to all",
};

function describe(watch: WatchView): string {
  const until = watch.until.length ? ` until ${watch.until.join(" or ")}` : "";
  return `${watch.label}: ${watch.source.key} (${watch.changes.join(", ")}) ${watch.state}${until}`;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "watch_add",
    method: "watch.add",
    description:
      "Watch an external resource this session is now waiting on, such as a pull request you opened. The watcher polls it outside the model and sends this session a message when something meaningful changes.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "URL of the resource, e.g. https://github.com/owner/repo/pull/42" },
        changes: changesArg,
        reason: { type: "string", description: "Why you are watching, shown to the user" },
        baseline: { type: "string", enum: ["current", "assess"], description: "assess: also report existing content once" },
        policy: {
          type: "object",
          properties: {
            until: { type: "array", items: { type: "string" }, description: "Terminal states that end the watch; default merged, closed" },
            expiresAt: { type: "string", description: "ISO time when the watch ends; default and maximum apply" },
          },
        },
      },
      required: ["source", "reason"],
    },
    format: (result) => {
      const watch = result as WatchView & { created: boolean };
      return `${watch.created ? "Watching" : "Already watching"} ${describe(watch)}.`;
    },
  },
  {
    name: "watch_list",
    method: "watch.list",
    description: "List this session's watches with their state, coverage and pending changes.",
    parameters: { type: "object", properties: {} },
    format: (result) => {
      const { watches, removed } = result as { watches: WatchView[]; removed: Array<{ source: string; removedBy: string }> };
      const lines = watches.map((watch) => `${describe(watch)} · revision ${watch.revision} · coverage ${watch.coverage}${watch.pending ? ` · ${watch.pending} pending` : ""}`);
      for (const entry of removed) lines.push(`removed by ${entry.removedBy}: ${entry.source}`);
      return lines.length ? lines.join("\n") : "No watches in this session.";
    },
  },
  {
    name: "watch_update",
    method: "watch.update",
    description: "Change a watch's categories, reason or policy.",
    parameters: {
      type: "object",
      properties: { watch: watchArg, expectedRevision: revisionArg, changes: changesArg, reason: { type: "string" }, policy: { type: "object" } },
      required: ["watch"],
    },
    format: (result) => `Updated ${describe(result as WatchView)}.`,
  },
  {
    name: "watch_pause",
    method: "watch.pause",
    description: "Pause a watch without removing it.",
    parameters: { type: "object", properties: { watch: watchArg, expectedRevision: revisionArg }, required: ["watch"] },
    format: (result) => `Paused ${describe(result as WatchView)}.`,
  },
  {
    name: "watch_resume",
    method: "watch.resume",
    description: "Resume a paused watch.",
    parameters: { type: "object", properties: { watch: watchArg, expectedRevision: revisionArg }, required: ["watch"] },
    format: (result) => `Resumed ${describe(result as WatchView)}.`,
  },
  {
    name: "watch_remove",
    method: "watch.remove",
    description: "Remove a watch this session no longer needs.",
    parameters: { type: "object", properties: { watch: watchArg, expectedRevision: revisionArg }, required: ["watch"] },
    format: (result) => `Removed ${(result as { removed: string }).removed}.`,
  },
  {
    name: "watch_pending",
    method: "watch.pending",
    description: "List changes that are pending, unacknowledged or escalated, including ones not shown in a watcher message.",
    parameters: { type: "object", properties: {} },
    format: (result) => {
      const view = result as PendingView;
      const lines = view.events.map((event) => {
        const s = event.summary;
        const text = [s["what"], s["detail"], s["actor"] ? `@${String(s["actor"])}` : "", s["url"]].filter(Boolean).join(" · ");
        return `[${event.id}] ${event.watch} ${event.state}${event.packet ? ` in ${event.packet}` : ""}: ${text}`;
      });
      for (const packet of view.packets) lines.push(`message ${packet.id} ${packet.state}${packet.closeReason ? ` (${packet.closeReason})` : ""}`);
      return lines.length ? lines.join("\n") : "Nothing pending.";
    },
  },
  {
    name: "watch_ack",
    method: "watch.ack",
    description:
      "Acknowledge a watcher message after assessing it. Omit events to acknowledge every event of the message. Use deferred with deferUntil to see events again later, or escalated when the user must decide.",
    parameters: {
      type: "object",
      properties: {
        packet: { type: "string", description: "The packet ID from the <watch-update> block" },
        events: { type: "array", items: { type: "string" }, description: "Event IDs in brackets; default all" },
        outcome: { type: "string", enum: ["handled", "dismissed", "deferred", "escalated"] },
        deferUntil: { type: "string", description: "ISO time, required for deferred, at most seven days ahead" },
        note: { type: "string" },
      },
      required: ["packet", "outcome"],
    },
    format: (result) => {
      const ack = result as { assessed: number; packetClosed: boolean };
      return `Recorded ${ack.assessed} assessment(s)${ack.packetClosed ? "; message closed" : ""}.`;
    },
  },
  {
    name: "watch_expect",
    method: "watch.expect",
    description:
      "Declare a change you made to a watched resource that the watcher cannot recognize itself, so it is not reported back to you. item is e.g. comment:123, review:456 or head.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { item: { type: "string" }, change: { type: "string", enum: ["create", "update", "push"] }, version: { type: "string" } },
            required: ["item", "change"],
          },
        },
      },
      required: ["source", "items"],
    },
    format: (result) => {
      const expected = result as { recorded: number; suppressed: number };
      return `Recorded ${expected.recorded} expected write(s).`;
    },
  },
];
