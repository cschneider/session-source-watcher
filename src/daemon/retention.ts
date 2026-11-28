// SPDX-License-Identifier: Apache-2.0
import type { Store } from "../store/store.js";

const DAY = 24 * 3_600_000;

/** Delete old records in dependency order. */
export function runRetention(store: Store, now: number): void {
  store.tx(() => {
    // 1. Closed packets whose events need nothing more, with those events.
    const packets = store.all<{ id: string }>(
      `SELECT p.id FROM packets p WHERE p.state = 'closed' AND p.closed_at < ?
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.packet_id = p.id AND e.state NOT IN ('acknowledged', 'suppressed', 'superseded', 'invalidated'))`,
      now - 7 * DAY,
    );
    for (const packet of packets) {
      store.run("DELETE FROM events WHERE packet_id = ?", packet.id);
      store.run("DELETE FROM packets WHERE id = ?", packet.id);
    }
    // Escalated and unacknowledged events are kept for 30 days.
    const stale = store.all<{ id: string; packet_id: string | null }>(
      "SELECT id, packet_id FROM events WHERE state IN ('escalated', 'unacknowledged') AND created_at < ?",
      now - 30 * DAY,
    );
    for (const event of stale) store.run("UPDATE events SET state = 'acknowledged' WHERE id = ?", event.id);
    // Passive events are informational; they expire after a week.
    store.run("UPDATE events SET state = 'invalidated' WHERE urgency = 'passive' AND state = 'pending' AND created_at < ?", now - 7 * DAY);
    // Events that never reached a packet and are closed.
    store.run(
      "DELETE FROM events WHERE packet_id IS NULL AND state IN ('suppressed', 'superseded', 'invalidated', 'acknowledged') AND created_at < ?",
      now - 7 * DAY,
    );
    // 2. Observations no event references.
    store.run(
      "DELETE FROM observations WHERE observed_at < ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.observation_id = observations.id)",
      now - 7 * DAY,
    );
    // 3. Expected writes and audit entries.
    store.run("DELETE FROM expected_writes WHERE expires_at < ?", now);
    store.run("DELETE FROM audit WHERE at < ?", now - 30 * DAY);
  });
}
