// SPDX-License-Identifier: Apache-2.0
import type { Clock } from "../core/clock.js";
import { shortId, ulid } from "../core/ids.js";
import type { SubscriptionPolicy, Urgency } from "../core/model.js";
import type { ItemWrite } from "../core/diff.js";
import { ERR, RemoteError } from "../protocol/connection.js";
import type {
  AckParams,
  BindParams,
  ExpectParams,
  PendingView,
  WatchAddParams,
  WatchRef,
  WatchUpdateParams,
  WatchView,
  WritesReportParams,
} from "../protocol/methods.js";
import { json, type Store } from "../store/store.js";
import type { SourceRegistry } from "./registry.js";
import type { BindingRow, CheckpointRow, EventRow, GroupRow, ItemRow, PacketRow, SubscriptionRow } from "./rows.js";

export type Actor = { role: "user" } | { role: "agent"; bindingId: string };

export const AGENT_QUOTA = 20;
export const AGENT_DEFAULT_EXPIRY_MS = 7 * 24 * 3_600_000;
export const AGENT_MAX_EXPIRY_MS = 30 * 24 * 3_600_000;
export const MAX_DEFER_MS = 7 * 24 * 3_600_000;
export const EXPECTED_WRITE_TTL_MS = 10 * 60_000;

export function watchLabel(id: string): string {
  return `w-${shortId(id)}`;
}

export function sourceLabel(key: string): string {
  return key.startsWith("github.com/") ? key.slice("github.com/".length) : key;
}

function toMs(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : Date.parse(value);
}

function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function refuse(message: string, code: number = ERR.refused): RemoteError {
  return new RemoteError(code, message);
}

/** Changes to bindings and watches; listeners wake the collector and delivery. */
export type ChangeListener = (kind: "watches" | "events" | "binding", bindingId?: string) => void;

export class App {
  private readonly listeners: ChangeListener[] = [];

  constructor(
    readonly store: Store,
    readonly sources: SourceRegistry,
    readonly clock: Clock,
  ) {}

  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  emit(kind: "watches" | "events" | "binding", bindingId?: string): void {
    for (const listener of this.listeners) listener(kind, bindingId);
  }

  private audit(actor: Actor | "system", action: string, subscriptionId: string | null, detail: unknown): void {
    const name = actor === "system" ? "system" : actor.role === "user" ? "user" : `agent:${actor.bindingId}`;
    this.store.run(
      "INSERT INTO audit (id, at, actor, action, subscription_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
      ulid(),
      this.clock.now(),
      name,
      action,
      subscriptionId,
      JSON.stringify(detail ?? {}),
    );
  }

  // ---- bindings -------------------------------------------------------

  bind(params: BindParams): { bindingId: string; epoch: number } {
    const now = this.clock.now();
    return this.store.tx(() => {
      const existing = this.store.get<BindingRow>(
        "SELECT * FROM bindings WHERE harness = ? AND host_id = ? AND native_session_id = ?",
        params.harness,
        params.hostId,
        params.nativeSessionId,
      );
      if (existing) {
        this.store.run(
          `UPDATE bindings SET status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'connected' END,
             tier = ?, label = COALESCE(?, label), connection_epoch = connection_epoch + 1, last_seen_at = ?, revision = revision + 1
           WHERE id = ?`,
          params.tier,
          params.label,
          now,
          existing.id,
        );
        return { bindingId: existing.id, epoch: existing.connection_epoch + 1 };
      }
      const id = ulid(now);
      this.store.run(
        `INSERT INTO bindings (id, harness, host_id, native_session_id, label, tier, status, busy, connection_epoch, last_seen_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, 'connected', 0, 1, ?, 1)`,
        id,
        params.harness,
        params.hostId,
        params.nativeSessionId,
        params.label,
        params.tier,
        now,
      );
      return { bindingId: id, epoch: 1 };
    });
  }

  lifecycle(bindingId: string, state: "connected" | "busy" | "idle" | "disconnected" | "archived" | "resumed"): void {
    const now = this.clock.now();
    this.store.tx(() => {
      switch (state) {
        case "busy":
        case "idle":
          this.store.run("UPDATE bindings SET busy = ?, last_seen_at = ? WHERE id = ?", state === "busy" ? 1 : 0, now, bindingId);
          break;
        case "connected":
          this.store.run("UPDATE bindings SET status = 'connected', last_seen_at = ? WHERE id = ? AND status <> 'archived'", now, bindingId);
          break;
        case "disconnected":
          this.store.run(
            "UPDATE bindings SET status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'disconnected' END, busy = 0, last_seen_at = ? WHERE id = ?",
            now,
            bindingId,
          );
          break;
        case "archived":
          this.store.run("UPDATE bindings SET status = 'archived', busy = 0, last_seen_at = ? WHERE id = ?", now, bindingId);
          this.store.run("UPDATE subscriptions SET state = 'suspended', revision = revision + 1 WHERE binding_id = ? AND state = 'active'", bindingId);
          break;
        case "resumed":
          this.store.run("UPDATE bindings SET status = 'connected', last_seen_at = ? WHERE id = ?", now, bindingId);
          this.store.run("UPDATE subscriptions SET state = 'active', revision = revision + 1 WHERE binding_id = ? AND state = 'suspended'", bindingId);
          break;
      }
    });
    this.emit("binding", bindingId);
    if (state === "archived" || state === "resumed") this.emit("watches", bindingId);
  }

  resolveBinding(actor: Actor, session: string | undefined): BindingRow {
    if (actor.role === "agent") {
      const binding = this.store.get<BindingRow>("SELECT * FROM bindings WHERE id = ?", actor.bindingId);
      if (!binding) throw refuse("This session is not bound to the watcher.", ERR.unauthorized);
      if (session !== undefined && session !== binding.id && session !== binding.native_session_id) {
        throw refuse("A session can only manage its own watches.", ERR.unauthorized);
      }
      return binding;
    }
    if (!session) {
      const bindings = this.store.all<BindingRow>("SELECT * FROM bindings WHERE status <> 'ended' ORDER BY last_seen_at DESC");
      if (bindings.length === 1) return bindings[0]!;
      throw refuse("Name the session with --session; see `ssw sessions`.", ERR.params);
    }
    const matches = this.store.all<BindingRow>(
      "SELECT * FROM bindings WHERE id = ? OR native_session_id = ? OR (length(?) >= 8 AND (id LIKE ? || '%' OR native_session_id LIKE ? || '%'))",
      session,
      session,
      session,
      session,
      session,
    );
    if (matches.length !== 1) throw refuse(matches.length ? `Session "${session}" is ambiguous.` : `No session "${session}".`, ERR.notFound);
    return matches[0]!;
  }

  sessions(): Array<{ id: string; harness: string; session: string; label: string | null; status: string; lastSeen: string | null; watches: number }> {
    return this.store
      .all<BindingRow & { watches: number }>(
        `SELECT b.*, (SELECT count(*) FROM subscriptions s WHERE s.binding_id = b.id AND s.state <> 'removed') AS watches
         FROM bindings b ORDER BY last_seen_at DESC`,
      )
      .map((b) => ({
        id: b.id,
        harness: b.harness,
        session: b.native_session_id,
        label: b.label,
        status: b.status,
        lastSeen: iso(b.last_seen_at),
        watches: b.watches,
      }));
  }

  // ---- watches --------------------------------------------------------

  private findSubscription(binding: BindingRow, watch: string): SubscriptionRow {
    const suffix = watch.startsWith("w-") ? watch.slice(2).toUpperCase() : watch.toUpperCase();
    const rows = this.store.all<SubscriptionRow>(
      "SELECT * FROM subscriptions WHERE binding_id = ? AND state <> 'removed' AND (id = ? OR id LIKE '%' || ?)",
      binding.id,
      watch,
      suffix,
    );
    if (rows.length !== 1) throw refuse(rows.length ? `Watch "${watch}" is ambiguous.` : `No watch "${watch}" in this session.`, ERR.notFound);
    return rows[0]!;
  }

  private checkRevision(subscription: SubscriptionRow, expected: number | undefined): void {
    if (expected !== undefined && expected !== subscription.revision) {
      throw new RemoteError(ERR.conflict, `Watch changed since revision ${expected}; current revision is ${subscription.revision}.`, this.view(subscription));
    }
  }

  async add(actor: Actor, params: WatchAddParams): Promise<WatchView & { created: boolean }> {
    const binding = this.resolveBinding(actor, params.session);
    const raw = typeof params.source === "string" ? params.source : params.source.url;
    const type = typeof params.source === "string" ? undefined : params.source.type;
    let resolved: ReturnType<SourceRegistry["resolve"]>;
    try {
      resolved = this.sources.resolve(raw, type);
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error), ERR.params);
    }
    const { adapter, key, locator, url } = resolved;
    let account: string;
    try {
      account = await adapter.resolveAccount(locator);
    } catch (error) {
      throw refuse(`Cannot read ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const changes = params.changes ?? [...adapter.categories];
    const unknown = changes.filter((change) => !adapter.categories.includes(change));
    if (unknown.length) throw refuse(`Unknown change categories: ${unknown.join(", ")}. Use ${adapter.categories.join(", ")}.`, ERR.params);

    const policy: SubscriptionPolicy = {};
    if (params.policy?.cadenceS !== undefined) policy.cadenceS = Math.max(adapter.defaults.minCadenceS, params.policy.cadenceS);
    policy.until = params.policy?.until ?? [...adapter.defaults.until];
    if (params.policy?.urgency) policy.urgency = params.policy.urgency as Record<string, Urgency>;

    const now = this.clock.now();
    let expiresAt = toMs(params.policy?.expiresAt);
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now)) throw refuse("expiresAt must be in the future.", ERR.params);
    if (actor.role === "agent") {
      expiresAt = Math.min(expiresAt ?? now + AGENT_DEFAULT_EXPIRY_MS, now + AGENT_MAX_EXPIRY_MS);
    }

    const result = this.store.tx(() => {
      let group = this.store.get<GroupRow>(
        "SELECT * FROM collection_groups WHERE source_type = ? AND source_key = ? AND account = ?",
        adapter.type,
        key,
        account,
      );
      if (!group) {
        const id = ulid(now);
        this.store.run(
          `INSERT INTO collection_groups (id, source_type, source_key, source_url, locator_json, account, state, cadence_s, next_run_at, health)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 'stale')`,
          id,
          adapter.type,
          key,
          url,
          JSON.stringify(locator),
          account,
          adapter.defaults.cadenceS,
          now,
        );
        group = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", id)!;
      } else if (group.state === "completed" || group.health === "blocked") {
        this.store.run(
          "UPDATE collection_groups SET state = 'active', terminal = NULL, health = 'stale', failures = 0, next_run_at = ? WHERE id = ?",
          now,
          group.id,
        );
      }

      const existing = this.store.get<SubscriptionRow>(
        "SELECT * FROM subscriptions WHERE binding_id = ? AND group_id = ? AND state <> 'removed'",
        binding.id,
        group.id,
      );
      if (existing && !["completed", "expired"].includes(existing.state)) return { subscription: existing, created: false };
      if (existing) this.store.run("UPDATE subscriptions SET state = 'removed', generation = generation + 1 WHERE id = ?", existing.id);

      const tombstone = this.store.get<{ removed_by: string }>(
        "SELECT removed_by FROM tombstones WHERE binding_id = ? AND group_id = ?",
        binding.id,
        group.id,
      );
      if (actor.role === "agent" && tombstone?.removed_by === "user") {
        throw refuse(`The user removed the watch on ${sourceLabel(key)}. Ask the user before watching it again.`);
      }
      if (actor.role === "agent") {
        const count = this.store.get<{ n: number }>(
          "SELECT count(*) AS n FROM subscriptions WHERE binding_id = ? AND origin = 'agent' AND state IN ('active', 'paused', 'suspended')",
          binding.id,
        )!.n;
        if (count >= AGENT_QUOTA) throw refuse(`This session already has ${AGENT_QUOTA} agent-created watches. Remove some first.`);
      }
      this.store.run("DELETE FROM tombstones WHERE binding_id = ? AND group_id = ?", binding.id, group.id);

      const id = ulid(now);
      const hasRead = this.store.get<{ n: number }>("SELECT count(*) AS n FROM checkpoints WHERE group_id = ?", group.id)!.n > 0;
      this.store.run(
        `INSERT INTO subscriptions (id, binding_id, group_id, changes_json, policy_json, origin, reason, baseline, state, generation, revision, baselined_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, NULL, ?, ?)`,
        id,
        binding.id,
        group.id,
        JSON.stringify(changes),
        JSON.stringify(policy),
        actor.role,
        params.reason,
        params.baseline ?? "current",
        expiresAt,
        now,
      );
      if (hasRead) this.completeBaseline(id);
      this.refreshCadence(group.id);
      if (policy.cadenceS !== undefined) this.store.run("UPDATE collection_groups SET next_run_at = MIN(next_run_at, ?) WHERE id = ?", now, group.id);
      this.audit(actor, "watch.add", id, { source: key, changes, reason: params.reason });
      return { subscription: this.store.get<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = ?", id)!, created: true };
    });
    this.emit("watches", binding.id);
    if (result.created) this.emit("events", binding.id);
    return { ...this.view(result.subscription), created: result.created };
  }

  /** Record the baseline of a subscription; with `assess`, existing items become events once. */
  completeBaseline(subscriptionId: string): void {
    const now = this.clock.now();
    const subscription = this.store.get<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = ?", subscriptionId);
    if (!subscription || subscription.baselined_at !== null) return;
    if (subscription.baseline === "assess") {
      const group = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", subscription.group_id)!;
      const adapter = this.sources.get(group.source_type);
      const changes = json<string[]>(subscription.changes_json, []);
      const policy = json<SubscriptionPolicy>(subscription.policy_json, {});
      const items = this.store.all<ItemRow>("SELECT * FROM items WHERE group_id = ? AND removed = 0", group.id);
      for (const item of items) {
        const summary = json<Record<string, string | number>>(item.summary_json, {});
        const category = String(summary["category"] ?? "");
        if (!category || !changes.includes(category)) continue;
        let observation = this.store.get<{ id: string }>(
          "SELECT id FROM observations WHERE group_id = ? AND item_key = ? AND revision = ? AND kind = 'existing'",
          group.id,
          item.item_key,
          item.revision,
        );
        if (!observation) {
          const id = ulid(now);
          this.store.run(
            `INSERT INTO observations (id, group_id, item_key, revision, kind, category, observed_at, summary_json)
             VALUES (?, ?, ?, ?, 'existing', ?, ?, ?)`,
            id,
            group.id,
            item.item_key,
            item.revision,
            category,
            now,
            item.summary_json,
          );
          observation = { id };
        }
        const urgency = policy.urgency?.[category] ?? adapter.urgency(category, summary, "existing");
        this.store.run(
          `INSERT OR IGNORE INTO events (id, subscription_id, generation, observation_id, urgency, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          ulid(now),
          subscription.id,
          subscription.generation,
          observation.id,
          urgency === "passive" ? "batched" : urgency,
          now,
        );
      }
    }
    this.store.run("UPDATE subscriptions SET baselined_at = ? WHERE id = ?", now, subscription.id);
  }

  refreshCadence(groupId: string): void {
    const group = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", groupId);
    if (!group) return;
    const adapter = this.sources.get(group.source_type);
    const policies = this.store
      .all<{ policy_json: string }>("SELECT policy_json FROM subscriptions WHERE group_id = ? AND state = 'active'", groupId)
      .map((row) => json<SubscriptionPolicy>(row.policy_json, {}));
    const cadence = Math.max(
      adapter.defaults.minCadenceS,
      Math.min(adapter.defaults.cadenceS, ...policies.map((policy) => policy.cadenceS ?? adapter.defaults.cadenceS)),
    );
    this.store.run("UPDATE collection_groups SET cadence_s = ? WHERE id = ?", cadence, groupId);
  }

  update(actor: Actor, params: WatchUpdateParams): WatchView {
    const binding = this.resolveBinding(actor, params.session);
    const view = this.store.tx(() => {
      const subscription = this.findSubscription(binding, params.watch);
      this.checkRevision(subscription, params.expectedRevision);
      const group = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", subscription.group_id)!;
      const adapter = this.sources.get(group.source_type);
      const changes = params.changes ?? json<string[]>(subscription.changes_json, []);
      const unknown = changes.filter((change) => !adapter.categories.includes(change));
      if (unknown.length) throw refuse(`Unknown change categories: ${unknown.join(", ")}.`, ERR.params);
      const policy = json<SubscriptionPolicy>(subscription.policy_json, {});
      let expiresAt = subscription.expires_at;
      if (params.policy) {
        if (params.policy.cadenceS !== undefined) policy.cadenceS = Math.max(adapter.defaults.minCadenceS, params.policy.cadenceS);
        if (params.policy.until) policy.until = params.policy.until;
        if (params.policy.urgency) policy.urgency = params.policy.urgency as Record<string, Urgency>;
        const requested = toMs(params.policy.expiresAt);
        if (requested !== undefined) {
          const now = this.clock.now();
          if (!Number.isFinite(requested) || requested <= now) throw refuse("expiresAt must be in the future.", ERR.params);
          expiresAt = actor.role === "agent" ? Math.min(requested, now + AGENT_MAX_EXPIRY_MS) : requested;
        }
      }
      this.store.run(
        `UPDATE subscriptions SET changes_json = ?, policy_json = ?, reason = COALESCE(?, reason), expires_at = ?,
           state = CASE WHEN state = 'expired' THEN 'active' ELSE state END, revision = revision + 1 WHERE id = ?`,
        JSON.stringify(changes),
        JSON.stringify(policy),
        params.reason,
        expiresAt,
        subscription.id,
      );
      this.refreshCadence(group.id);
      this.audit(actor, "watch.update", subscription.id, { changes, policy });
      return this.view(this.store.get<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = ?", subscription.id)!);
    });
    this.emit("watches", binding.id);
    return view;
  }

  private invalidateUnsent(subscriptionId: string): void {
    this.store.run(
      "UPDATE events SET state = 'invalidated' WHERE subscription_id = ? AND state IN ('pending', 'deferred') AND packet_id IS NULL",
      subscriptionId,
    );
  }

  setPaused(actor: Actor, params: WatchRef, paused: boolean): WatchView {
    const binding = this.resolveBinding(actor, params.session);
    const view = this.store.tx(() => {
      const subscription = this.findSubscription(binding, params.watch);
      this.checkRevision(subscription, params.expectedRevision);
      if (paused && subscription.state === "active") {
        this.store.run("UPDATE subscriptions SET state = 'paused', generation = generation + 1, revision = revision + 1 WHERE id = ?", subscription.id);
        this.invalidateUnsent(subscription.id);
      } else if (!paused && subscription.state === "paused") {
        this.store.run("UPDATE subscriptions SET state = 'active', revision = revision + 1 WHERE id = ?", subscription.id);
      } else {
        throw refuse(`Watch ${watchLabel(subscription.id)} is ${subscription.state}.`);
      }
      this.refreshCadence(subscription.group_id);
      this.audit(actor, paused ? "watch.pause" : "watch.resume", subscription.id, {});
      return this.view(this.store.get<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = ?", subscription.id)!);
    });
    this.emit("watches", binding.id);
    return view;
  }

  remove(actor: Actor, params: WatchRef): { removed: string } {
    const binding = this.resolveBinding(actor, params.session);
    const label = this.store.tx(() => {
      const subscription = this.findSubscription(binding, params.watch);
      this.checkRevision(subscription, params.expectedRevision);
      this.store.run("UPDATE subscriptions SET state = 'removed', generation = generation + 1, revision = revision + 1 WHERE id = ?", subscription.id);
      this.invalidateUnsent(subscription.id);
      this.store.run(
        `INSERT INTO tombstones (binding_id, group_id, removed_by, removed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (binding_id, group_id) DO UPDATE SET removed_by = excluded.removed_by, removed_at = excluded.removed_at`,
        binding.id,
        subscription.group_id,
        actor.role,
        this.clock.now(),
      );
      this.refreshCadence(subscription.group_id);
      this.audit(actor, "watch.remove", subscription.id, {});
      return watchLabel(subscription.id);
    });
    this.emit("watches", binding.id);
    return { removed: label };
  }

  view(subscription: SubscriptionRow): WatchView {
    const group = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", subscription.group_id)!;
    const checkpoints = this.store.all<CheckpointRow>("SELECT * FROM checkpoints WHERE group_id = ?", group.id);
    const pending = this.store.get<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE subscription_id = ? AND urgency <> 'passive' AND state IN ('pending', 'deferred', 'queued', 'delivered', 'escalated')",
      subscription.id,
    )!.n;
    const pr = this.store.get<ItemRow>("SELECT * FROM items WHERE group_id = ? AND item_key = 'pr'", group.id);
    const headRef = pr ? String(json<Record<string, unknown>>(pr.projection_json, {})["headRef"] ?? "") || undefined : undefined;
    const lastRead = checkpoints.reduce<number | null>((max, row) => (row.complete_through !== null && (max === null || row.complete_through > max) ? row.complete_through : max), null);
    const policy = json<SubscriptionPolicy>(subscription.policy_json, {});
    return {
      id: subscription.id,
      label: watchLabel(subscription.id),
      source: { type: group.source_type, key: group.source_key, url: group.source_url },
      changes: json<string[]>(subscription.changes_json, []),
      origin: subscription.origin as "user" | "agent",
      reason: subscription.reason,
      state: subscription.state,
      health: group.health,
      revision: subscription.revision,
      expiresAt: iso(subscription.expires_at),
      until: policy.until ?? [],
      checkedAt: iso(lastRead),
      coverage: coverageText(checkpoints),
      pending,
      headRef,
    };
  }

  list(actor: Actor, session?: string): { watches: WatchView[]; removed: Array<{ source: string; removedBy: string; removedAt: string | null }> } {
    const binding = this.resolveBinding(actor, session);
    const watches = this.store
      .all<SubscriptionRow>("SELECT * FROM subscriptions WHERE binding_id = ? AND state <> 'removed' ORDER BY created_at", binding.id)
      .map((row) => this.view(row));
    const removed = this.store
      .all<{ source_key: string; removed_by: string; removed_at: number }>(
        `SELECT g.source_key, t.removed_by, t.removed_at FROM tombstones t JOIN collection_groups g ON g.id = t.group_id
         WHERE t.binding_id = ? ORDER BY t.removed_at DESC LIMIT 20`,
        binding.id,
      )
      .map((row) => ({ source: sourceLabel(row.source_key), removedBy: row.removed_by, removedAt: iso(row.removed_at) }));
    return { watches, removed };
  }

  pending(actor: Actor, session?: string): PendingView {
    const binding = this.resolveBinding(actor, session);
    const events = this.store
      .all<EventRow & { kind: string; category: string; summary_json: string; occurred_at: number | null }>(
        `SELECT e.*, o.kind, o.category, o.summary_json, o.occurred_at FROM events e
           JOIN subscriptions s ON s.id = e.subscription_id
           JOIN observations o ON o.id = e.observation_id
         WHERE s.binding_id = ? AND e.state IN ('pending', 'deferred', 'queued', 'delivered', 'escalated', 'unacknowledged')
         ORDER BY CASE WHEN e.state IN ('escalated', 'unacknowledged') THEN 0 WHEN e.urgency <> 'passive' THEN 1 ELSE 2 END,
                  e.created_at DESC
         LIMIT 200`,
        binding.id,
      )
      .map((row) => ({
        id: row.id,
        watch: watchLabel(row.subscription_id),
        state: row.state,
        urgency: row.urgency,
        kind: row.kind,
        category: row.category,
        summary: json<Record<string, string | number>>(row.summary_json, {}),
        packet: row.packet_id,
        deferUntil: iso(row.defer_until),
      }));
    const packets = this.store
      .all<PacketRow>(
        "SELECT * FROM packets WHERE binding_id = ? AND (state <> 'closed' OR close_reason IN ('unconfirmed', 'undeliverable')) ORDER BY created_at DESC LIMIT 20",
        binding.id,
      )
      .map((row) => ({ id: row.id, state: row.state, title: row.title, closeReason: row.close_reason }));
    return { events, packets };
  }

  // ---- assessments ----------------------------------------------------

  ack(actor: Actor & { role: "agent" }, params: AckParams): { assessed: number; packetClosed: boolean } {
    const now = this.clock.now();
    const packet = this.store.get<PacketRow>("SELECT * FROM packets WHERE id = ? AND binding_id = ?", params.packet, actor.bindingId);
    if (!packet) throw refuse(`No watcher message ${params.packet} in this session.`, ERR.notFound);
    let deferUntil: number | undefined;
    if (params.outcome === "deferred") {
      deferUntil = toMs(params.deferUntil);
      if (deferUntil === undefined || !Number.isFinite(deferUntil) || deferUntil <= now) throw refuse("deferred requires a future deferUntil.", ERR.params);
      if (deferUntil > now + MAX_DEFER_MS) throw refuse("deferUntil may be at most seven days ahead.", ERR.params);
    }
    const result = this.store.tx(() => {
      const candidates = this.store.all<EventRow>("SELECT * FROM events WHERE packet_id = ?", packet.id);
      const wanted = params.events ? new Set(params.events) : undefined;
      if (wanted) {
        const known = new Set(candidates.map((event) => event.id));
        const foreign = [...wanted].filter((id) => !known.has(id));
        if (foreign.length) throw refuse(`Events not in message ${packet.id}: ${foreign.join(", ")}`, ERR.params);
      }
      let assessed = 0;
      for (const event of candidates) {
        if (wanted && !wanted.has(event.id)) continue;
        if (!["queued", "delivered", "unacknowledged"].includes(event.state)) continue;
        const state = params.outcome === "handled" || params.outcome === "dismissed" ? "acknowledged" : params.outcome;
        this.store.run(
          "UPDATE events SET state = ?, defer_until = ?, packet_id = CASE WHEN ? = 'deferred' THEN NULL ELSE packet_id END WHERE id = ?",
          state,
          deferUntil,
          state,
          event.id,
        );
        this.store.run(
          "INSERT INTO assessments (id, event_id, packet_id, outcome, defer_until, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ulid(now),
          event.id,
          packet.id,
          params.outcome,
          deferUntil,
          `agent:${actor.bindingId}`,
          params.note,
          now,
        );
        assessed++;
      }
      const open = this.store.get<{ n: number }>(
        "SELECT count(*) AS n FROM events WHERE packet_id = ? AND state IN ('queued', 'delivered')",
        packet.id,
      )!.n;
      let packetClosed = false;
      if (open === 0 && packet.state !== "closed") {
        this.store.run("UPDATE packets SET state = 'closed', close_reason = 'assessed', closed_at = ? WHERE id = ?", now, packet.id);
        packetClosed = true;
      }
      return { assessed, packetClosed };
    });
    this.emit("events", actor.bindingId);
    return result;
  }

  resolveEscalation(actor: Actor, event: string, session: string | undefined, note?: string): { resolved: string } {
    const binding = this.resolveBinding(actor, session);
    this.store.tx(() => {
      const row = this.store.get<EventRow>(
        "SELECT e.* FROM events e JOIN subscriptions s ON s.id = e.subscription_id WHERE e.id = ? AND s.binding_id = ?",
        event,
        binding.id,
      );
      if (!row) throw refuse(`No event ${event} in this session.`, ERR.notFound);
      if (!["escalated", "unacknowledged"].includes(row.state)) throw refuse(`Event ${event} is ${row.state}.`);
      this.store.run("UPDATE events SET state = 'acknowledged' WHERE id = ?", event);
      this.store.run(
        "INSERT INTO assessments (id, event_id, packet_id, outcome, actor, note, at) VALUES (?, ?, ?, 'resolved', ?, ?, ?)",
        ulid(),
        event,
        row.packet_id,
        actor.role === "user" ? "user" : `agent:${actor.bindingId}`,
        note,
        this.clock.now(),
      );
    });
    this.emit("events", binding.id);
    return { resolved: event };
  }

  // ---- own writes -----------------------------------------------------

  expectWrites(actor: Actor & { role: "agent" }, writes: WritesReportParams["writes"]): { recorded: number; suppressed: number } {
    const now = this.clock.now();
    const result = this.store.tx(() => {
      let recorded = 0;
      let suppressed = 0;
      for (const write of writes) {
        let key: string;
        try {
          key = this.sources.resolve(write.source).key;
        } catch {
          continue;
        }
        const group = this.store.get<{ group_id: string }>(
          `SELECT s.group_id FROM subscriptions s JOIN collection_groups g ON g.id = s.group_id
           WHERE s.binding_id = ? AND g.source_key = ? AND s.state <> 'removed' LIMIT 1`,
          actor.bindingId,
          key,
        );
        if (!group) continue;
        const id = ulid(now);
        this.store.run(
          `INSERT INTO expected_writes (id, binding_id, group_id, item_key, change, version, reported_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          actor.bindingId,
          group.group_id,
          write.item,
          write.change,
          write.version,
          now,
          now + EXPECTED_WRITE_TTL_MS,
        );
        recorded++;
        // The poll may already have seen the write: suppress a matching event not yet sent.
        const candidates = this.store.all<EventRow & { kind: string; version: string | null; item_key: string }>(
          `SELECT e.*, o.kind, o.version, o.item_key FROM events e
             JOIN subscriptions s ON s.id = e.subscription_id
             JOIN observations o ON o.id = e.observation_id
           WHERE s.binding_id = ? AND s.group_id = ? AND o.item_key = ? AND e.state = 'pending' AND e.packet_id IS NULL
           ORDER BY e.created_at`,
          actor.bindingId,
          group.group_id,
          write.item,
        );
        const match = candidates.find((event) => writeMatches(write.change, write.version, event.kind, event.version));
        if (match) {
          this.store.run("UPDATE events SET state = 'suppressed' WHERE id = ?", match.id);
          this.store.run("UPDATE expected_writes SET consumed_by = ? WHERE id = ?", match.observation_id, id);
          suppressed++;
        }
      }
      return { recorded, suppressed };
    });
    return result;
  }

  expect(actor: Actor & { role: "agent" }, params: ExpectParams): { recorded: number; suppressed: number } {
    return this.expectWrites(
      actor,
      params.items.map((item) => ({ source: params.source, item: item.item, change: item.change, ...(item.version ? { version: item.version } : {}) })),
    );
  }

  status(): Record<string, unknown> {
    const count = (sql: string) => this.store.get<{ n: number }>(sql)!.n;
    return {
      sessions: count("SELECT count(*) AS n FROM bindings WHERE status = 'connected'"),
      watches: count("SELECT count(*) AS n FROM subscriptions WHERE state = 'active'"),
      collectors: this.store.all<{ source_key: string; health: string; state: string; next_run_at: number; last_error: string | null; account: string }>(
        "SELECT source_key, health, state, next_run_at, last_error, account FROM collection_groups WHERE state <> 'completed' ORDER BY source_key",
      ).map((row) => ({
        source: sourceLabel(row.source_key),
        account: row.account,
        state: row.state,
        health: row.health,
        nextRun: iso(row.next_run_at),
        error: row.last_error,
      })),
      budgets: this.store.all("SELECT provider, account, remaining, rate_limit AS limit_, reset_at FROM budgets"),
      openPackets: count("SELECT count(*) AS n FROM packets WHERE state <> 'closed'"),
    };
  }
}

/** Whether an expected write explains an observed change. */
export function writeMatches(change: string, version: string | null | undefined, kind: string, observed: string | null | undefined): boolean {
  switch (change) {
    case "create":
      return kind === "created";
    case "update":
      return (kind === "updated" || kind === "transition") && !!version && version === observed;
    case "push":
      return !!version && !!observed && version.length >= 7 && observed.startsWith(version);
    default:
      return false;
  }
}

export function coverageText(checkpoints: CheckpointRow[]): string {
  if (!checkpoints.length) return "not read yet";
  const hhmm = (ms: number | null) => (ms === null ? "?" : `${new Date(ms).toISOString().slice(11, 16)}Z`);
  const gaps = checkpoints.filter((row) => row.coverage !== "complete");
  const through = checkpoints.reduce<number | null>((min, row) => (row.complete_through !== null && (min === null || row.complete_through < min) ? row.complete_through : min), null);
  if (!gaps.length) return `complete through ${hhmm(through)}`;
  const units = gaps.map((row) => row.unit).join(", ");
  const since = gaps.reduce<number | null>((min, row) => (row.gap_from !== null && (min === null || row.gap_from < min) ? row.gap_from : min), null);
  return `partial, ${units} unavailable since ${hhmm(since)}`;
}

export type { ItemWrite };
