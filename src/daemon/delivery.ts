// SPDX-License-Identifier: Apache-2.0
import type { Clock } from "../core/clock.js";
import { ulid } from "../core/ids.js";
import { renderPacket, type RenderEvent, type RenderGroup } from "../core/render.js";
import type { ObservationKind, Urgency } from "../core/model.js";
import type { DeliverParams, ProgressReply, ProgressStatus, ReconcileParams } from "../protocol/methods.js";
import { json, type Store } from "../store/store.js";
import { coverageText, sourceLabel, watchLabel, type App } from "./app.js";
import type { Logger } from "./log.js";
import type { BindingRow, CheckpointRow, EventRow, GroupRow, PacketRow } from "./rows.js";

export const BATCH_DELAY_MS = 60_000;
export const BATCH_MAX_WAIT_MS = 10 * 60_000;
export const BATCH_MAX_EVENTS = 20;
export const ADMISSION_TIMEOUT_MS = 30_000;
export const RECONCILE_EVERY_MS = 60_000;
export const UNCONFIRMED_CLOSE_MS = 10 * 60_000;
export const RETRY_BASE_MS = 30_000;
export const MAX_ATTEMPTS = 5;

/** The daemon side of a connected harness adapter. */
export interface AdapterLink {
  bindingId: string;
  epoch: number;
  deliver(params: DeliverParams): Promise<ProgressReply>;
  reconcile(params: ReconcileParams): Promise<ProgressReply>;
}

const RANK: Record<string, number> = { sending: 0, retry: 0, unconfirmed: 0, admitted: 1, consumed: 2, closed: 3 };

type DueEvent = EventRow & {
  item_key: string;
  kind: string;
  category: string;
  summary_json: string;
  previous_json: string | null;
  occurred_at: number | null;
  group_id: string;
  sub_state: string;
  sub_generation: number;
};

export class Delivery {
  private readonly links = new Map<string, AdapterLink>();
  private readonly reconciledAt = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  attach(link: AdapterLink): void {
    this.links.set(link.bindingId, link);
    this.reconciledAt.delete(link.bindingId);
  }

  detach(link: AdapterLink): void {
    if (this.links.get(link.bindingId) === link) this.links.delete(link.bindingId);
  }

  /** Run every binding's delivery loop once; resolves when sends settled. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    this.housekeeping(now);
    const bindings = this.store.all<BindingRow>("SELECT * FROM bindings WHERE status = 'connected' AND tier = 'message'");
    await Promise.all(bindings.map((binding) => this.run(binding.id)));
  }

  private housekeeping(now: number): void {
    this.store.tx(() => {
      this.store.run(
        "UPDATE events SET state = 'pending', defer_until = NULL WHERE state = 'deferred' AND defer_until IS NOT NULL AND defer_until <= ?",
        now,
      );
      const stale = this.store.all<PacketRow>(
        "SELECT * FROM packets WHERE state = 'unconfirmed' AND COALESCE(sent_at, created_at) <= ?",
        now - UNCONFIRMED_CLOSE_MS,
      );
      for (const packet of stale) this.close(packet.id, "unconfirmed", now);
    });
  }

  async run(bindingId: string): Promise<void> {
    if (this.running.has(bindingId)) return;
    this.running.add(bindingId);
    try {
      await this.step(bindingId);
    } catch (error) {
      this.log.error(`delivery ${bindingId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running.delete(bindingId);
    }
  }

  private async step(bindingId: string): Promise<void> {
    const link = this.links.get(bindingId);
    const binding = this.store.get<BindingRow>("SELECT * FROM bindings WHERE id = ?", bindingId);
    if (!link || !binding || binding.status !== "connected" || binding.tier !== "message" || link.epoch !== binding.connection_epoch) return;
    const now = this.clock.now();
    const open = this.store.get<PacketRow>("SELECT * FROM packets WHERE binding_id = ? AND state <> 'closed'", bindingId);

    if (open) {
      const last = this.reconciledAt.get(bindingId);
      const needsReconcile =
        last === undefined || (open.state === "unconfirmed" && now - last >= RECONCILE_EVERY_MS);
      if (needsReconcile && open.state !== "retry") {
        this.reconciledAt.set(bindingId, now);
        await this.reconcile(link, open);
        return;
      }
      if (open.state === "retry" && (open.next_attempt_at ?? 0) <= now) await this.retry(link, open);
      return;
    }
    this.reconciledAt.set(bindingId, now);
    const packet = this.assemble(bindingId, now);
    if (packet) await this.send(link, packet);
  }

  private dueEvents(bindingId: string): DueEvent[] {
    return this.store.all<DueEvent>(
      `SELECT e.*, o.item_key, o.kind, o.category, o.summary_json, o.previous_json, o.occurred_at, o.group_id,
              s.state AS sub_state, s.generation AS sub_generation
       FROM events e
         JOIN subscriptions s ON s.id = e.subscription_id
         JOIN observations o ON o.id = e.observation_id
       WHERE s.binding_id = ? AND e.state = 'pending' AND e.urgency <> 'passive' AND e.packet_id IS NULL
       ORDER BY e.created_at, e.id`,
      bindingId,
    );
  }

  /** Mark superseded intermediate snapshot states; returns the events still due. */
  private coalesce(events: DueEvent[]): DueEvent[] {
    const latest = new Map<string, DueEvent>();
    for (const event of events) latest.set(`${event.subscription_id}|${event.item_key}`, event);
    const kept: DueEvent[] = [];
    for (const event of events) {
      const last = latest.get(`${event.subscription_id}|${event.item_key}`)!;
      const summary = json<Record<string, string | number>>(event.summary_json, {});
      if (last !== event && summary["intermediate"] === 1) {
        this.store.run("UPDATE events SET state = 'superseded' WHERE id = ?", event.id);
        continue;
      }
      kept.push(event);
    }
    return kept;
  }

  private assemble(bindingId: string, now: number): PacketRow | undefined {
    return this.store.tx(() => {
      let events = this.dueEvents(bindingId).filter((event) => {
        const valid = (event.sub_state === "active" || event.sub_state === "completed") && event.sub_generation === event.generation;
        if (!valid) this.store.run("UPDATE events SET state = 'invalidated' WHERE id = ?", event.id);
        return valid;
      });
      events = this.coalesce(events);
      if (!events.length) return undefined;
      const first = Math.min(...events.map((event) => event.created_at));
      const due =
        events.some((event) => event.urgency === "immediate") ||
        events.length >= BATCH_MAX_EVENTS ||
        now - first >= BATCH_DELAY_MS ||
        now - first >= BATCH_MAX_WAIT_MS;
      if (!due) return undefined;

      const id = ulid(now);
      const rendered = this.render(id, events);
      if (!rendered.included.length) return undefined;
      const urgency: Urgency = rendered.included.some((event) => event.urgency === "immediate") ? "immediate" : "batched";
      this.store.run(
        `INSERT INTO packets (id, binding_id, state, title, text, urgency, attempts, created_at) VALUES (?, ?, 'sending', ?, ?, ?, 0, ?)`,
        id,
        bindingId,
        rendered.title,
        rendered.text,
        urgency,
        now,
      );
      for (const event of rendered.included) this.store.run("UPDATE events SET state = 'queued', packet_id = ? WHERE id = ?", id, event.id);
      return this.store.get<PacketRow>("SELECT * FROM packets WHERE id = ?", id);
    });
  }

  private render(packetId: string, events: DueEvent[]): { title: string; text: string; included: DueEvent[] } {
    const groups: RenderGroup[] = [];
    const seen = new Set<string>();
    const renderEvents: RenderEvent[] = [];
    for (const event of events) {
      const group = this.store.get<GroupRow>("SELECT * FROM collection_groups WHERE id = ?", event.group_id)!;
      const label = watchLabel(event.subscription_id);
      if (!seen.has(label)) {
        seen.add(label);
        const checkpoints = this.store.all<CheckpointRow>("SELECT * FROM checkpoints WHERE group_id = ?", group.id);
        groups.push({ watchLabel: label, sourceType: group.source_type, sourceLabel: sourceLabel(group.source_key), coverage: coverageText(checkpoints) });
      }
      renderEvents.push({
        eventId: event.id,
        watchLabel: label,
        sourceType: group.source_type,
        sourceLabel: sourceLabel(group.source_key),
        sourceHost: new URL(group.source_url).host,
        kind: event.kind as ObservationKind,
        urgency: event.urgency as Urgency,
        summary: json(event.summary_json, {}),
        previous: event.previous_json ? json(event.previous_json, {}) : undefined,
        occurredAt: event.occurred_at ?? undefined,
      });
    }
    const rendered = renderPacket(packetId, groups, renderEvents);
    const included = new Set(rendered.includedEventIds);
    return { title: rendered.title, text: rendered.text, included: events.filter((event) => included.has(event.id)) };
  }

  private async send(link: AdapterLink, packet: PacketRow): Promise<void> {
    const now = this.clock.now();
    this.store.run(
      "UPDATE packets SET state = 'sending', attempts = attempts + 1, connection_epoch = ?, sent_at = ? WHERE id = ?",
      link.epoch,
      now,
      packet.id,
    );
    let reply: ProgressReply;
    try {
      reply = await withTimeout(
        link.deliver({ packet: packet.id, epoch: link.epoch, title: packet.title, text: packet.text, urgency: packet.urgency as Urgency }),
        ADMISSION_TIMEOUT_MS,
      );
    } catch (error) {
      reply = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    this.progress(link.bindingId, link.epoch, packet.id, reply.status, reply.receipt);
  }

  private async reconcile(link: AdapterLink, packet: PacketRow): Promise<void> {
    if (packet.state === "sending") this.store.run("UPDATE packets SET state = 'unconfirmed' WHERE id = ? AND state = 'sending'", packet.id);
    let reply: ProgressReply;
    try {
      reply = await withTimeout(link.reconcile({ packet: packet.id, epoch: link.epoch, ...(packet.sent_at ? { sentAt: packet.sent_at } : {}) }), ADMISSION_TIMEOUT_MS);
    } catch (error) {
      reply = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    this.progress(link.bindingId, link.epoch, packet.id, reply.status, reply.receipt);
  }

  private async retry(link: AdapterLink, packet: PacketRow): Promise<void> {
    const now = this.clock.now();
    const rerendered = this.store.tx(() => {
      const events = this.store.all<DueEvent>(
        `SELECT e.*, o.item_key, o.kind, o.category, o.summary_json, o.previous_json, o.occurred_at, o.group_id,
                s.state AS sub_state, s.generation AS sub_generation
         FROM events e JOIN subscriptions s ON s.id = e.subscription_id JOIN observations o ON o.id = e.observation_id
         WHERE e.packet_id = ? AND e.state = 'queued' ORDER BY e.created_at, e.id`,
        packet.id,
      );
      const valid = events.filter((event) => {
        const ok = (event.sub_state === "active" || event.sub_state === "completed") && event.sub_generation === event.generation;
        if (!ok) this.store.run("UPDATE events SET state = 'invalidated', packet_id = NULL WHERE id = ?", event.id);
        return ok;
      });
      if (!valid.length) {
        this.close(packet.id, "invalidated", now);
        return undefined;
      }
      if (valid.length !== events.length) {
        const rendered = this.render(packet.id, valid);
        this.store.run("UPDATE packets SET title = ?, text = ? WHERE id = ?", rendered.title, rendered.text, packet.id);
      }
      return this.store.get<PacketRow>("SELECT * FROM packets WHERE id = ?", packet.id);
    });
    if (rerendered) await this.send(link, rerendered);
  }

  /** Apply an admission, consumption or completion report. Monotonic and idempotent. */
  progress(bindingId: string, epoch: number, packetId: string, status: ProgressStatus, receipt?: string): void {
    const now = this.clock.now();
    const changed = this.store.tx(() => {
      const binding = this.store.get<BindingRow>("SELECT * FROM bindings WHERE id = ?", bindingId);
      const packet = this.store.get<PacketRow>("SELECT * FROM packets WHERE id = ? AND binding_id = ?", packetId, bindingId);
      if (!binding || !packet || binding.connection_epoch !== epoch || packet.state === "closed") return false;
      // An admission by an earlier connection is no evidence for this one: a
      // restarted harness may have lost its queue, so it can be downgraded.
      const rank = packet.state === "admitted" && packet.connection_epoch !== epoch ? 0 : (RANK[packet.state] ?? 0);
      switch (status) {
        case "admitted":
          if (rank >= 1) return false;
          this.store.run("UPDATE packets SET state = 'admitted', receipt = COALESCE(?, receipt), admitted_at = ? WHERE id = ?", receipt, now, packetId);
          this.store.run("UPDATE events SET state = 'delivered' WHERE packet_id = ? AND state = 'queued'", packetId);
          return true;
        case "consumed":
          if (rank >= 2) return false;
          this.store.run(
            "UPDATE packets SET state = 'consumed', receipt = COALESCE(?, receipt), admitted_at = COALESCE(admitted_at, ?), consumed_at = ? WHERE id = ?",
            receipt,
            now,
            now,
            packetId,
          );
          this.store.run("UPDATE events SET state = 'delivered' WHERE packet_id = ? AND state = 'queued'", packetId);
          return true;
        case "completed":
          this.close(packetId, "completed", now);
          return true;
        case "not-admitted":
          if (rank >= 1) return false;
          this.store.run("UPDATE events SET state = 'queued' WHERE packet_id = ? AND state = 'delivered'", packetId);
          if (packet.attempts >= MAX_ATTEMPTS) {
            this.close(packetId, "undeliverable", now);
          } else {
            this.store.run(
              "UPDATE packets SET state = 'retry', next_attempt_at = ? WHERE id = ?",
              now + RETRY_BASE_MS * 2 ** Math.max(0, packet.attempts - 1),
              packetId,
            );
          }
          return true;
        case "unknown":
          if (rank >= 1) return false;
          this.store.run("UPDATE packets SET state = 'unconfirmed' WHERE id = ?", packetId);
          return true;
      }
    });
    if (changed) this.app.emit("events", bindingId);
  }

  private close(packetId: string, reason: string, now: number): void {
    this.store.run("UPDATE packets SET state = 'closed', close_reason = ?, closed_at = ? WHERE id = ? AND state <> 'closed'", reason, now, packetId);
    this.store.run("UPDATE events SET state = 'unacknowledged' WHERE packet_id = ? AND state IN ('queued', 'delivered')", packetId);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
