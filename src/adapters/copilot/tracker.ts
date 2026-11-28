// SPDX-License-Identifier: Apache-2.0
import type { ProgressReply, ProgressStatus } from "../../protocol/methods.js";

interface Sent {
  messageId?: string;
  failed: boolean;
}

export interface HistoryEvent {
  type: string;
  agentId?: string;
  data?: { clientTurnId?: string } & Record<string, unknown>;
}

/**
 * Tracks watcher messages in one Copilot session: admission, consumption
 * (a user.message echoing the packet ID as clientTurnId) and completion
 * (the top-level agent stopped after consuming it).
 */
export class PacketTracker {
  private readonly sent = new Map<string, Sent>();
  private readonly consumed = new Set<string>();
  private readonly completed = new Set<string>();
  report: (packet: string, status: ProgressStatus, receipt?: string) => void = () => {};

  recordSend(packet: string, messageId: string | undefined, failed: boolean): void {
    this.sent.set(packet, { ...(messageId ? { messageId } : {}), failed });
  }

  /** Feed live session events. */
  observe(event: HistoryEvent): void {
    if (event.type === "user.message") {
      const id = event.data?.clientTurnId;
      if (id && this.isPacketId(id) && !this.consumed.has(id)) {
        this.consumed.add(id);
        this.report(id, "consumed");
      }
    } else if (event.type === "abort" && !event.agentId) {
      this.stopped();
    }
  }

  /** The top-level agent stopped: every consumed packet's work is over. */
  stopped(): void {
    for (const packet of this.consumed) {
      if (this.completed.has(packet)) continue;
      this.completed.add(packet);
      this.report(packet, "completed");
    }
  }

  /** What this process can prove about a packet, using the persisted history. */
  reconcile(packet: string, history: readonly HistoryEvent[]): ProgressReply {
    const consumedInHistory = history.some((event) => event.type === "user.message" && event.data?.clientTurnId === packet);
    const sent = this.sent.get(packet);
    if (consumedInHistory || this.consumed.has(packet)) {
      this.consumed.add(packet);
      // A packet not sent by this process was consumed before a restart; that turn is over.
      if (this.completed.has(packet) || !sent) {
        this.completed.add(packet);
        return { status: "completed" };
      }
      return { status: "consumed" };
    }
    if (sent?.messageId && !sent.failed) return { status: "admitted", receipt: sent.messageId };
    return { status: "unknown", reason: sent?.failed ? "send failed; consumption not observed" : "not sent by this process" };
  }

  private isPacketId(id: string): boolean {
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
  }
}
