// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const id = z.string().min(1).max(200);
const urgency = z.enum(["immediate", "batched", "passive"]);
const timestamp = z.union([z.number().int().nonnegative(), z.string().datetime({ offset: true })]);

export const helloParams = z.object({
  protocol: z.number().int(),
  role: z.enum(["adapter", "cli", "ui"]),
  client: z.string().min(1).max(100),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
});

export const tier = z.enum(["message", "next-turn", "pull"]);

export const bindParams = z.object({
  harness: z.string().min(1).max(50),
  hostId: id,
  nativeSessionId: id,
  label: z.string().max(200).optional(),
  tier,
});

export const lifecycleParams = z.object({
  state: z.enum(["connected", "busy", "idle", "disconnected", "archived", "resumed"]),
});

export const sessionScope = z.object({
  /** User-authority clients name the session; adapters are bound to one. */
  session: id.optional(),
});

export const policyInput = z.object({
  cadenceS: z.number().int().positive().optional(),
  until: z.array(z.string().min(1).max(50)).max(10).optional(),
  urgency: z.record(z.string(), urgency).optional(),
  expiresAt: timestamp.optional(),
});

export const sourceInput = z.union([
  z.string().min(1).max(2000),
  z.object({ type: z.string().max(100).optional(), url: z.string().min(1).max(2000) }),
]);

export const watchAddParams = sessionScope.extend({
  source: sourceInput,
  changes: z.array(z.string().min(1).max(50)).max(20).optional(),
  policy: policyInput.optional(),
  reason: z.string().max(200).optional(),
  baseline: z.enum(["current", "assess"]).optional(),
});

export const watchRef = sessionScope.extend({
  watch: id,
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const watchUpdateParams = watchRef.extend({
  changes: z.array(z.string().min(1).max(50)).max(20).optional(),
  policy: policyInput.optional(),
  reason: z.string().max(200).optional(),
});

export const ackParams = z.object({
  packet: id,
  events: z.array(id).max(200).optional(),
  outcome: z.enum(["handled", "dismissed", "deferred", "escalated"]),
  deferUntil: timestamp.optional(),
  note: z.string().max(500).optional(),
});

export const writeChange = z.enum(["create", "update", "push"]);

export const expectParams = z.object({
  source: z.string().min(1).max(2000),
  items: z
    .array(z.object({ item: id, change: writeChange, version: z.string().max(200).optional() }))
    .min(1)
    .max(50),
});

export const writesReportParams = z.object({
  writes: z
    .array(
      z.object({
        source: z.string().min(1).max(2000),
        item: id,
        change: writeChange,
        version: z.string().max(200).optional(),
      }),
    )
    .max(50),
});

export const progressStatus = z.enum(["admitted", "not-admitted", "unknown", "consumed", "completed"]);

export const progressParams = z.object({
  packet: id,
  epoch: z.number().int().nonnegative(),
  status: progressStatus,
  receipt: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

export const resolveParams = sessionScope.extend({
  event: id,
  note: z.string().max(500).optional(),
});

export type HelloParams = z.infer<typeof helloParams>;
export type BindParams = z.infer<typeof bindParams>;
export type WatchAddParams = z.infer<typeof watchAddParams>;
export type WatchUpdateParams = z.infer<typeof watchUpdateParams>;
export type WatchRef = z.infer<typeof watchRef>;
export type AckParams = z.infer<typeof ackParams>;
export type ExpectParams = z.infer<typeof expectParams>;
export type WritesReportParams = z.infer<typeof writesReportParams>;
export type ProgressParams = z.infer<typeof progressParams>;
export type ProgressStatus = z.infer<typeof progressStatus>;

/** Daemon to adapter. */
export interface DeliverParams {
  packet: string;
  epoch: number;
  title: string;
  text: string;
  urgency: "immediate" | "batched" | "passive";
}

export interface ReconcileParams {
  packet: string;
  epoch: number;
}

export interface ProgressReply {
  status: ProgressStatus;
  receipt?: string;
  reason?: string;
}

export interface WatchView {
  id: string;
  label: string;
  source: { type: string; key: string; url: string };
  changes: string[];
  origin: "user" | "agent";
  reason: string | null;
  state: string;
  health: string;
  revision: number;
  expiresAt: string | null;
  until: string[];
  checkedAt: string | null;
  coverage: string;
  pending: number;
  headRef?: string | undefined;
}

export interface PendingView {
  events: Array<{
    id: string;
    watch: string;
    state: string;
    urgency: string;
    kind: string;
    category: string;
    summary: Record<string, string | number>;
    packet: string | null;
    deferUntil: string | null;
  }>;
  packets: Array<{ id: string; state: string; title: string; closeReason: string | null }>;
}
