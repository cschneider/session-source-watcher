// SPDX-License-Identifier: Apache-2.0
import type { Clock } from "../core/clock.js";
import { diffRead, type KnownItemState } from "../core/diff.js";
import { ulid } from "../core/ids.js";
import type { SubscriptionPolicy } from "../core/model.js";
import type { Checkpoint, ReadResult, SourceAdapter } from "../core/source.js";
import { json, type Store } from "../store/store.js";
import { writeMatches, type App } from "./app.js";
import type { Logger } from "./log.js";
import type { CheckpointRow, GroupRow, ItemRow, SubscriptionRow } from "./rows.js";

const READ_DEADLINE_MS = 30_000;
const LEASE_MS = 2 * READ_DEADLINE_MS;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_READS_PER_ACCOUNT = 4;
const AUTH_RETRY_MS = 24 * 3_600_000;

interface Captured {
  id: string;
  generation: number;
}

export class Collector {
  private readonly inFlight = new Map<string, number>();
  readonly owner = ulid();

  constructor(
    private readonly app: App,
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** Run every due collection group once; resolves when their reads committed. */
  async tick(): Promise<number> {
    const now = this.clock.now();
    this.expireSubscriptions(now);
    const groups = this.store.all<GroupRow>(
      `SELECT g.* FROM collection_groups g
       WHERE g.state <> 'completed' AND g.next_run_at <= ? AND (g.lease_until IS NULL OR g.lease_until < ?)
         AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.group_id = g.id AND s.state = 'active')
       ORDER BY g.next_run_at`,
      now,
      now,
    );
    const reads: Promise<void>[] = [];
    for (const group of groups) {
      const running = this.inFlight.get(group.account) ?? 0;
      if (running >= MAX_READS_PER_ACCOUNT) continue;
      const leased = this.store.run(
        "UPDATE collection_groups SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)",
        this.owner,
        now + LEASE_MS,
        group.id,
        now,
      );
      if (!leased) continue;
      this.inFlight.set(group.account, running + 1);
      reads.push(
        this.read(group).finally(() => {
          this.inFlight.set(group.account, (this.inFlight.get(group.account) ?? 1) - 1);
        }),
      );
    }
    await Promise.all(reads);
    return reads.length;
  }

  private expireSubscriptions(now: number): void {
    const expired = this.store.all<SubscriptionRow>(
      "SELECT * FROM subscriptions WHERE state IN ('active', 'paused') AND expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
    if (!expired.length) return;
    this.store.tx(() => {
      for (const subscription of expired) {
        this.store.run("UPDATE subscriptions SET state = 'expired', generation = generation + 1, revision = revision + 1 WHERE id = ?", subscription.id);
        this.store.run(
          "UPDATE events SET state = 'invalidated' WHERE subscription_id = ? AND state IN ('pending', 'deferred') AND packet_id IS NULL",
          subscription.id,
        );
        this.app.refreshCadence(subscription.group_id);
      }
    });
    for (const subscription of expired) this.app.emit("watches", subscription.binding_id);
  }

  private budgetFactor(group: GroupRow): number {
    const budget = this.store.get<{ remaining: number | null; rate_limit: number | null; reset_at: number | null }>(
      "SELECT remaining, rate_limit, reset_at FROM budgets WHERE provider = ? AND account = ?",
      group.source_type.split(".")[0] ?? group.source_type,
      group.account,
    );
    if (!budget || budget.remaining === null || !budget.rate_limit || (budget.reset_at !== null && budget.reset_at < this.clock.now())) return 1;
    const share = budget.remaining / budget.rate_limit;
    if (group.state === "final-sweep") return 1;
    if (share < 0.05) return 4;
    if (share < 0.2) return 2;
    return 1;
  }

  private async read(group: GroupRow): Promise<void> {
    const adapter = this.app.sources.get(group.source_type);
    const now = this.clock.now();
    const subscriptions = this.store.all<SubscriptionRow>("SELECT * FROM subscriptions WHERE group_id = ? AND state = 'active'", group.id);
    const captured: Captured[] = subscriptions.map((s) => ({ id: s.id, generation: s.generation }));
    const categories = [...new Set(subscriptions.flatMap((s) => json<string[]>(s.changes_json, [])))];
    const checkpointRows = this.store.all<CheckpointRow>("SELECT * FROM checkpoints WHERE group_id = ?", group.id);
    const checkpoints = new Map<string, Checkpoint>(
      checkpointRows.map((row) => [
        row.unit,
        { unit: row.unit, coverage: row.coverage as Checkpoint["coverage"], cursor: row.cursor ?? undefined, lastFullAt: row.last_full_at ?? undefined, nextDueAt: row.next_due_at },
      ]),
    );
    const dueUnits = adapter.units
      .map((unit) => unit.name)
      .filter((unit) => unit === "state" || (checkpoints.get(unit)?.nextDueAt ?? 0) <= now);
    const items = this.loadItems(group.id);
    let cadenceS = group.cadence_s * this.budgetFactor(group);
    if (group.terminal && group.state === "active") cadenceS *= 10;

    let result: ReadResult;
    try {
      result = await adapter.read({
        locator: json(group.locator_json, {}),
        account: group.account,
        dueUnits,
        categories,
        items,
        checkpoints,
        cache: json<Record<string, string>>(group.cache_json, {}),
        final: group.state === "final-sweep",
        cadenceS,
        now,
        signal: AbortSignal.timeout(READ_DEADLINE_MS),
      });
    } catch (error) {
      result = { units: {}, cache: json(group.cache_json, {}), error: { kind: "server", message: error instanceof Error ? error.message : String(error) } };
    }
    try {
      const affected = this.commit(group, adapter, captured, result, cadenceS);
      for (const bindingId of affected) this.app.emit("events", bindingId);
    } catch (error) {
      this.log.error(`commit failed for ${group.source_key}: ${error instanceof Error ? error.message : String(error)}`);
      this.store.run("UPDATE collection_groups SET lease_owner = NULL, lease_until = NULL WHERE id = ?", group.id);
    }
  }

  loadItems(groupId: string): Map<string, KnownItemState> {
    return new Map(
      this.store.all<ItemRow>("SELECT * FROM items WHERE group_id = ?", groupId).map((row) => [
        row.item_key,
        {
          key: row.item_key,
          unit: row.unit,
          revision: row.revision,
          fingerprint: row.fingerprint,
          projection: json<Record<string, unknown>>(row.projection_json, {}),
          summary: json<Record<string, string | number>>(row.summary_json, {}),
          missingCount: row.missing_count,
          removed: row.removed === 1,
        },
      ]),
    );
  }

  /** Apply one read atomically. Returns the bindings that received events. */
  commit(group: GroupRow, adapter: SourceAdapter, captured: Captured[], result: ReadResult, cadenceS: number): Set<string> {
    const now = this.clock.now();
    const affected = new Set<string>();
    this.store.tx(() => {
      const current = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", group.id)!;
      const known = this.loadItems(group.id);
      // A unit stays a baseline until one of its reads has completed.
      const completedUnits = new Set(
        this.store
          .all<{ unit: string }>("SELECT unit FROM checkpoints WHERE group_id = ? AND complete_through IS NOT NULL", group.id)
          .map((r) => r.unit),
      );
      const baselineUnits = new Set(Object.keys(result.units).filter((unit) => !completedUnits.has(unit)));
      const diff = diffRead(result.units, known, baselineUnits);

      for (const item of diff.items) {
        this.store.run(
          `INSERT INTO items (group_id, item_key, unit, revision, fingerprint, projection_json, summary_json, missing_count, removed, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (group_id, item_key) DO UPDATE SET unit = excluded.unit, revision = excluded.revision,
             fingerprint = excluded.fingerprint, projection_json = excluded.projection_json, summary_json = excluded.summary_json,
             missing_count = excluded.missing_count, removed = excluded.removed, last_seen_at = excluded.last_seen_at`,
          group.id,
          item.key,
          item.unit,
          item.revision,
          item.fingerprint,
          JSON.stringify(item.projection),
          JSON.stringify(item.summary),
          item.missingCount,
          item.removed ? 1 : 0,
          now,
        );
      }

      for (const [unit, outcome] of Object.entries(result.units)) {
        const complete = outcome.outcome === "unchanged" || outcome.outcome === "full" || outcome.outcome === "delta";
        const nextDue = now + (result.nextDueS?.[unit] ?? cadenceS) * 1000;
        this.store.run(
          `INSERT INTO checkpoints (group_id, unit, coverage, cursor, last_full_at, complete_through, gap_from, last_error, next_due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (group_id, unit) DO UPDATE SET
             coverage = excluded.coverage,
             cursor = CASE WHEN excluded.coverage = 'partial' THEN COALESCE(checkpoints.cursor, excluded.cursor)
                           ELSE COALESCE(excluded.cursor, checkpoints.cursor) END,
             last_full_at = COALESCE(excluded.last_full_at, checkpoints.last_full_at),
             complete_through = COALESCE(excluded.complete_through, checkpoints.complete_through),
             gap_from = CASE WHEN excluded.coverage = 'complete' THEN NULL ELSE COALESCE(checkpoints.gap_from, excluded.gap_from) END,
             last_error = excluded.last_error,
             next_due_at = excluded.next_due_at`,
          group.id,
          unit,
          complete ? "complete" : outcome.outcome === "partial" ? "partial" : "failed",
          "cursor" in outcome && outcome.cursor !== undefined ? outcome.cursor : null,
          outcome.outcome === "full" ? now : null,
          complete ? now : null,
          complete ? null : now,
          outcome.outcome === "failed" ? outcome.error.slice(0, 500) : null,
          outcome.outcome === "failed" || outcome.outcome === "partial" ? Math.min(nextDue, now + cadenceS * 1000) : nextDue,
        );
      }

      const subscriptions = captured
        .map((c) => ({ captured: c, row: this.store.get<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = ?", c.id) }))
        .filter((entry): entry is { captured: Captured; row: SubscriptionRow } => !!entry.row && entry.row.state === "active" && entry.row.generation === entry.captured.generation);

      for (const observation of diff.observations) {
        const observationId = ulid(now);
        this.store.run(
          `INSERT INTO observations (id, group_id, item_key, revision, kind, category, version, actor, occurred_at, observed_at, summary_json, previous_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          observationId,
          group.id,
          observation.itemKey,
          observation.revision,
          observation.kind,
          observation.category,
          observation.version,
          observation.actor,
          observation.occurredAt,
          now,
          JSON.stringify(observation.summary),
          observation.previous ? JSON.stringify(observation.previous) : null,
        );
        for (const { row } of subscriptions) {
          const changes = json<string[]>(row.changes_json, []);
          if (!changes.includes(observation.category)) continue;
          const policy = json<SubscriptionPolicy>(row.policy_json, {});
          const urgency = policy.urgency?.[observation.category] ?? adapter.urgency(observation.category, observation.summary, observation.kind);
          // A newer change supersedes passive events of the same item that were never sent.
          this.store.run(
            `UPDATE events SET state = 'superseded'
             WHERE subscription_id = ? AND urgency = 'passive' AND state = 'pending' AND packet_id IS NULL
               AND observation_id IN (SELECT id FROM observations WHERE group_id = ? AND item_key = ?)`,
            row.id,
            group.id,
            observation.itemKey,
          );
          const echo = this.matchExpectedWrite(row.binding_id, group.id, observation.itemKey, observation.kind, observation.version, now);
          if (echo) this.store.run("UPDATE expected_writes SET consumed_by = ? WHERE id = ?", observationId, echo);
          this.store.run(
            `INSERT INTO events (id, subscription_id, generation, observation_id, urgency, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ulid(now),
            row.id,
            row.generation,
            observationId,
            urgency,
            echo ? "suppressed" : "pending",
            now,
          );
          if (!echo) affected.add(row.binding_id);
        }
      }

      for (const { row } of subscriptions) {
        if (row.baselined_at === null) {
          this.app.completeBaseline(row.id);
          affected.add(row.binding_id);
        }
      }

      this.applyTerminal(current, result, subscriptions.map((s) => s.row), affected);

      const failures = result.error ? current.failures + 1 : 0;
      const anyGap = Object.values(result.units).some((u) => u.outcome === "partial" || u.outcome === "failed");
      let health = anyGap || result.error ? "degraded" : "fresh";
      let nextRun = now + jitter(cadenceS * 1000);
      if (result.error) {
        if (result.error.kind === "auth") {
          health = "blocked";
          nextRun = now + AUTH_RETRY_MS;
        } else if (result.error.retryAfterS) {
          nextRun = now + result.error.retryAfterS * 1000;
        } else {
          nextRun = now + Math.min(MAX_BACKOFF_MS, cadenceS * 1000 * 2 ** failures);
        }
      }
      const dueTimes = this.store
        .all<{ next_due_at: number }>("SELECT next_due_at FROM checkpoints WHERE group_id = ? AND unit <> 'state'", group.id)
        .map((r) => r.next_due_at);
      if (!result.error && dueTimes.length) nextRun = Math.min(nextRun, Math.max(now + adapter.defaults.minCadenceS * 1000, Math.min(...dueTimes)));
      const after = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", group.id)!;
      if (after.state === "final-sweep") nextRun = now;
      this.store.run(
        `UPDATE collection_groups SET cache_json = ?, failures = ?, health = ?, last_error = ?, next_run_at = ?, lease_owner = NULL, lease_until = NULL
         WHERE id = ?`,
        JSON.stringify(result.cache),
        failures,
        health,
        result.error ? `${result.error.kind}: ${result.error.message}`.slice(0, 500) : null,
        nextRun,
        group.id,
      );
      if (result.rateLimit) {
        this.store.run(
          `INSERT INTO budgets (provider, account, remaining, rate_limit, reset_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (provider, account) DO UPDATE SET remaining = excluded.remaining, rate_limit = excluded.rate_limit, reset_at = excluded.reset_at`,
          group.source_type.split(".")[0] ?? group.source_type,
          group.account,
          result.rateLimit.remaining,
          result.rateLimit.limit,
          result.rateLimit.resetAt,
        );
      }
    });
    if (result.error) this.log.warn(`read ${group.source_key}: ${result.error.kind} ${result.error.message}`);
    return affected;
  }

  private matchExpectedWrite(bindingId: string, groupId: string, itemKey: string, kind: string, version: string | undefined, now: number): string | undefined {
    const candidates = this.store.all<{ id: string; change: string; version: string | null }>(
      `SELECT id, change, version FROM expected_writes
       WHERE binding_id = ? AND group_id = ? AND item_key = ? AND consumed_by IS NULL AND expires_at > ?
       ORDER BY reported_at`,
      bindingId,
      groupId,
      itemKey,
      now,
    );
    return candidates.find((write) => writeMatches(write.change, write.version, kind, version))?.id;
  }

  private applyTerminal(group: GroupRow, result: ReadResult, subscriptions: SubscriptionRow[], affected: Set<string>): void {
    if (result.error && !Object.keys(result.units).length) return;
    const terminal = result.terminal ?? null;
    if (!terminal) {
      if (group.terminal) this.store.run("UPDATE collection_groups SET terminal = NULL, state = 'active' WHERE id = ?", group.id);
      return;
    }
    if (group.state === "active" && group.terminal !== terminal) {
      this.store.run("UPDATE collection_groups SET terminal = ?, state = 'final-sweep' WHERE id = ?", terminal, group.id);
      return;
    }
    // After the final sweep, or in an active group whose terminal state is already
    // known (a member with a different condition keeps it read), matching
    // subscriptions complete, including ones added later.
    for (const subscription of subscriptions) {
      const until = json<SubscriptionPolicy>(subscription.policy_json, {}).until ?? [];
      if (until.includes(terminal)) {
        this.store.run("UPDATE subscriptions SET state = 'completed', revision = revision + 1 WHERE id = ?", subscription.id);
        affected.add(subscription.binding_id);
      }
    }
    const remaining = this.store.get<{ n: number }>(
      "SELECT count(*) AS n FROM subscriptions WHERE group_id = ? AND state IN ('active', 'paused', 'suspended')",
      group.id,
    )!.n;
    this.store.run("UPDATE collection_groups SET state = ? WHERE id = ?", remaining ? "active" : "completed", group.id);
    this.app.refreshCadence(group.id);
  }
}

function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}
