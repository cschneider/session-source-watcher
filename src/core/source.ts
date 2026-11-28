// SPDX-License-Identifier: Apache-2.0
import type { Urgency } from "./model.js";

export interface ReadUnit {
  name: string;
  category: string;
  model: "snapshot" | "delta" | "query";
}

export interface KnownItem {
  key: string;
  unit: string;
  revision: number;
  fingerprint: string;
  projection: Record<string, unknown>;
  missingCount: number;
}

export interface Checkpoint {
  unit: string;
  coverage: "complete" | "partial" | "failed";
  cursor?: string | undefined;
  lastFullAt?: number | undefined;
  nextDueAt: number;
}

export interface ObservedItem {
  key: string;
  category: string;
  /** Provider version used for echo matching, such as an ID, timestamp or SHA. */
  version?: string | undefined;
  /** Normalized state without volatile fields; its hash detects changes. */
  projection: Record<string, unknown>;
  /** A change of one of these projection fields is a state transition. */
  transitionFields?: readonly string[];
  actor?: string | undefined;
  occurredAt?: number | undefined;
  /** Bounded fields used to render the change. */
  summary: Record<string, string | number>;
}

export type UnitResult =
  | { outcome: "unchanged" }
  | { outcome: "full"; items: ObservedItem[]; scope?: string; cursor?: string }
  | { outcome: "delta"; items: ObservedItem[]; cursor: string }
  /** `cursor` only sets a first watermark; a partial read never advances one. */
  | { outcome: "partial"; items: ObservedItem[]; cursor?: string }
  | { outcome: "failed"; error: string };

export interface ReadInput<L> {
  locator: L;
  account: string;
  dueUnits: readonly string[];
  categories: readonly string[];
  items: ReadonlyMap<string, KnownItem>;
  checkpoints: ReadonlyMap<string, Checkpoint>;
  cache: Record<string, string>;
  final: boolean;
  cadenceS: number;
  now: number;
  signal: AbortSignal;
}

export type ReadErrorKind = "auth" | "not-found" | "rate-limit" | "network" | "server";

export interface ReadResult {
  units: Record<string, UnitResult>;
  cache: Record<string, string>;
  terminal?: string | undefined;
  /** Seconds until each read unit is due again. */
  nextDueS?: Record<string, number>;
  rateLimit?: { remaining: number; limit: number; resetAt: number };
  error?: { kind: ReadErrorKind; message: string; retryAfterS?: number };
}

export interface SourceAdapter<L = unknown> {
  type: string;
  categories: readonly string[];
  units: readonly ReadUnit[];
  defaults: { cadenceS: number; minCadenceS: number; until: readonly string[] };
  canonicalize(input: unknown): { key: string; locator: L; url: string };
  resolveAccount(locator: L): Promise<string>;
  read(input: ReadInput<L>): Promise<ReadResult>;
  /** Default urgency of a change, before subscription policy. */
  urgency(category: string, summary: Record<string, string | number>, kind: string): Urgency;
}
