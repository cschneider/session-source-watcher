// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { ObservationKind } from "./model.js";
import type { KnownItem, ObservedItem, UnitResult } from "./source.js";

export interface KnownItemState extends KnownItem {
  summary: Record<string, string | number>;
  removed: boolean;
}

export interface DiffObservation {
  itemKey: string;
  unit: string;
  revision: number;
  kind: ObservationKind;
  category: string;
  version?: string | undefined;
  actor?: string | undefined;
  occurredAt?: number | undefined;
  summary: Record<string, string | number>;
  previous?: Record<string, string | number> | undefined;
}

export interface ItemWrite {
  key: string;
  unit: string;
  revision: number;
  fingerprint: string;
  projection: Record<string, unknown>;
  summary: Record<string, string | number>;
  missingCount: number;
  removed: boolean;
}

export interface DiffResult {
  observations: DiffObservation[];
  items: ItemWrite[];
}

/** Stable JSON: object keys sorted, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function fingerprint(projection: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(projection)).digest("hex").slice(0, 32);
}

/**
 * Compare unit results with the latest known items.
 *
 * Deletion is only inferred from two consecutive complete full reads; unchanged,
 * delta, partial and failed results never make a known item look missing.
 * Units listed in `baselineUnits` record their items without observations.
 */
export function diffRead(
  units: Record<string, UnitResult>,
  known: ReadonlyMap<string, KnownItemState>,
  baselineUnits: ReadonlySet<string>,
): DiffResult {
  const observations: DiffObservation[] = [];
  const items = new Map<string, ItemWrite>();

  for (const [unit, result] of Object.entries(units)) {
    if (result.outcome === "unchanged" || result.outcome === "failed") continue;
    const baseline = baselineUnits.has(unit);
    const seen = new Set<string>();

    for (const observed of result.items) {
      const item = { ...observed, summary: { ...observed.summary, category: observed.category } };
      seen.add(item.key);
      const print = fingerprint(item.projection);
      const prior = items.get(item.key) ?? known.get(item.key);
      if (prior && !prior.removed && prior.fingerprint === print) {
        if (prior.missingCount > 0) items.set(item.key, { ...toWrite(prior), missingCount: 0 });
        continue;
      }
      const revision = (prior?.revision ?? 0) + 1;
      items.set(item.key, {
        key: item.key,
        unit,
        revision,
        fingerprint: print,
        projection: item.projection,
        summary: item.summary,
        missingCount: 0,
        removed: false,
      });
      if (baseline) continue;
      observations.push({
        itemKey: item.key,
        unit,
        revision,
        kind: classify(prior, item),
        category: item.category,
        version: item.version,
        actor: item.actor,
        occurredAt: item.occurredAt,
        summary: item.summary,
        previous: prior && !prior.removed ? prior.summary : undefined,
      });
    }

    if (result.outcome !== "full") continue;
    for (const prior of known.values()) {
      if (prior.unit !== unit || prior.removed || seen.has(prior.key)) continue;
      if (result.scope !== undefined && !prior.key.startsWith(result.scope)) continue;
      const missingCount = prior.missingCount + 1;
      if (missingCount < 2 || baseline) {
        items.set(prior.key, { ...toWrite(prior), missingCount });
        continue;
      }
      const revision = prior.revision + 1;
      items.set(prior.key, { ...toWrite(prior), revision, missingCount, removed: true });
      observations.push({
        itemKey: prior.key,
        unit,
        revision,
        kind: "removed",
        category: String(prior.summary["category"] ?? unit),
        summary: prior.summary,
      });
    }
  }
  return { observations, items: [...items.values()] };
}

function classify(prior: KnownItemState | undefined, item: ObservedItem): ObservationKind {
  if (!prior || prior.removed) return "created";
  for (const field of item.transitionFields ?? []) {
    if (stableStringify(prior.projection[field]) !== stableStringify(item.projection[field])) return "transition";
  }
  return "updated";
}

function toWrite(item: KnownItemState): ItemWrite {
  return {
    key: item.key,
    unit: item.unit,
    revision: item.revision,
    fingerprint: item.fingerprint,
    projection: item.projection,
    summary: item.summary,
    missingCount: item.missingCount,
    removed: item.removed,
  };
}
