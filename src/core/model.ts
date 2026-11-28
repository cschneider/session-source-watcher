// SPDX-License-Identifier: Apache-2.0

export type Urgency = "immediate" | "batched" | "passive";
export type Tier = "message" | "next-turn" | "pull";
export type Origin = "user" | "agent";

export type SubscriptionState = "active" | "paused" | "suspended" | "completed" | "expired" | "removed";

export type EventState =
  | "pending"
  | "suppressed"
  | "superseded"
  | "queued"
  | "delivered"
  | "deferred"
  | "acknowledged"
  | "escalated"
  | "unacknowledged"
  | "invalidated";

export type PacketState = "sending" | "retry" | "unconfirmed" | "admitted" | "consumed" | "closed";
export type CloseReason = "assessed" | "completed" | "invalidated" | "undeliverable" | "unconfirmed";

export type Outcome = "handled" | "dismissed" | "deferred" | "escalated";

export type ObservationKind = "created" | "updated" | "removed" | "transition" | "existing";

export interface SubscriptionPolicy {
  cadenceS?: number;
  until?: string[];
  urgency?: Record<string, Urgency>;
}

/** Terminal event states: the event needs nothing more from the session. */
export const CLOSED_EVENT_STATES: readonly EventState[] = [
  "acknowledged",
  "suppressed",
  "superseded",
  "invalidated",
];
