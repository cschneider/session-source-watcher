// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server, type Socket } from "node:net";
import type { ZodType } from "zod";
import { ulid } from "../core/ids.js";
import { newNonce, PROTOCOL_VERSION, verifyProof, type Role } from "../protocol/auth.js";
import { Connection, ERR, RemoteError } from "../protocol/connection.js";
import {
  ackParams,
  bindParams,
  expectParams,
  helloParams,
  lifecycleParams,
  progressParams,
  resolveParams,
  sessionScope,
  watchAddParams,
  watchRef,
  watchUpdateParams,
  writesReportParams,
  type DeliverParams,
  type ProgressReply,
  type ReconcileParams,
} from "../protocol/methods.js";
import type { Actor, App } from "./app.js";
import type { AdapterLink, Delivery } from "./delivery.js";
import type { Logger } from "./log.js";

interface Peer {
  id: string;
  connection: Connection;
  role?: Role;
  client?: string;
  bindingId?: string;
  epoch?: number;
  link?: AdapterLink;
}

function parse<T>(schema: ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RemoteError(ERR.params, `Invalid parameters: ${issue ? `${issue.path.join(".") || "params"} ${issue.message}` : "invalid"}`);
  }
  return result.data;
}

export class IpcServer {
  private server: Server | undefined;
  readonly peers = new Set<Peer>();
  onActivity: () => void = () => {};

  constructor(
    private readonly app: App,
    private readonly delivery: Delivery,
    private readonly secret: Buffer,
    private readonly log: Logger,
  ) {}

  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.accept(socket));
      this.server.once("error", reject);
      this.server.listen(path, () => resolve());
    });
  }

  close(): Promise<void> {
    for (const peer of this.peers) peer.connection.close();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    const peer: Peer = { id: ulid(), connection: new Connection(socket) };
    this.peers.add(peer);
    const nonce = newNonce();
    const helloTimer = setTimeout(() => {
      if (!peer.role) peer.connection.close();
    }, 10_000);
    helloTimer.unref?.();
    peer.connection.onRequest = (method, params) => {
      this.onActivity();
      if (!peer.role) {
        if (method !== "hello") throw new RemoteError(ERR.unauthorized, "Send hello first");
        const hello = parse(helloParams, params);
        if (hello.protocol !== PROTOCOL_VERSION) {
          setTimeout(() => peer.connection.close(), 10);
          throw new RemoteError(ERR.refused, `Unsupported protocol ${hello.protocol}; this daemon speaks ${PROTOCOL_VERSION}`);
        }
        if (!verifyProof(this.secret, nonce, hello.role, hello.client, hello.proof)) {
          setTimeout(() => peer.connection.close(), 10);
          throw new RemoteError(ERR.unauthorized, "Authentication failed");
        }
        clearTimeout(helloTimer);
        peer.role = hello.role;
        peer.client = hello.client;
        return { protocol: PROTOCOL_VERSION, connectionId: peer.id };
      }
      return this.route(peer, method, params);
    };
    peer.connection.onClose(() => {
      clearTimeout(helloTimer);
      this.peers.delete(peer);
      if (peer.link) {
        this.delivery.detach(peer.link);
        const stillAttached = [...this.peers].some((other) => other.bindingId === peer.bindingId && other.link);
        if (!stillAttached && peer.bindingId) this.app.lifecycle(peer.bindingId, "disconnected");
      }
      this.onActivity();
    });
    peer.connection.notify("challenge", { nonce });
  }

  private actor(peer: Peer): Actor {
    if (peer.role === "adapter") {
      if (!peer.bindingId) throw new RemoteError(ERR.unauthorized, "Bind a session first");
      return { role: "agent", bindingId: peer.bindingId };
    }
    return { role: "user" };
  }

  private agent(peer: Peer): Actor & { role: "agent" } {
    const actor = this.actor(peer);
    if (actor.role !== "agent") throw new RemoteError(ERR.unauthorized, "Only a session adapter can do this");
    return actor;
  }

  private user(peer: Peer): Actor {
    if (peer.role === "adapter") throw new RemoteError(ERR.unauthorized, "This needs user authority");
    return { role: "user" };
  }

  private async route(peer: Peer, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session.bind": {
        if (peer.role !== "adapter") throw new RemoteError(ERR.unauthorized, "Only adapters bind sessions");
        const bind = parse(bindParams, params);
        const result = this.app.bind(bind);
        if (peer.link) this.delivery.detach(peer.link);
        peer.bindingId = result.bindingId;
        peer.epoch = result.epoch;
        const connection = peer.connection;
        peer.link = {
          bindingId: result.bindingId,
          epoch: result.epoch,
          deliver: (deliver: DeliverParams) => connection.request<ProgressReply>("packet.deliver", deliver, 30_000),
          reconcile: (reconcile: ReconcileParams) => connection.request<ProgressReply>("packet.reconcile", reconcile, 30_000),
        };
        this.delivery.attach(peer.link);
        this.log.info(`bound ${bind.harness} session ${result.bindingId} epoch ${result.epoch}`);
        this.app.emit("binding", result.bindingId);
        return result;
      }
      case "session.lifecycle": {
        const actor = this.agent(peer);
        const { state } = parse(lifecycleParams, params);
        this.app.lifecycle(actor.bindingId, state);
        return { ok: true };
      }
      case "sessions.list":
        this.user(peer);
        return this.app.sessions();
      case "watch.add":
        return this.app.add(this.actor(peer), parse(watchAddParams, params));
      case "watch.update":
        return this.app.update(this.actor(peer), parse(watchUpdateParams, params));
      case "watch.pause":
        return this.app.setPaused(this.actor(peer), parse(watchRef, params), true);
      case "watch.resume":
        return this.app.setPaused(this.actor(peer), parse(watchRef, params), false);
      case "watch.remove":
        return this.app.remove(this.actor(peer), parse(watchRef, params));
      case "watch.list":
        return this.app.list(this.actor(peer), parse(sessionScope, params).session);
      case "watch.pending":
        return this.app.pending(this.actor(peer), parse(sessionScope, params).session);
      case "watch.ack":
        return this.app.ack(this.agent(peer), parse(ackParams, params));
      case "watch.expect":
        return this.app.expect(this.agent(peer), parse(expectParams, params));
      case "writes.report":
        return this.app.expectWrites(this.agent(peer), parse(writesReportParams, params).writes);
      case "packet.progress": {
        const actor = this.agent(peer);
        const progress = parse(progressParams, params);
        this.delivery.progress(actor.bindingId, progress.epoch, progress.packet, progress.status, progress.receipt);
        return { ok: true };
      }
      case "escalation.resolve": {
        const resolve = parse(resolveParams, params);
        return this.app.resolveEscalation(this.user(peer), resolve.event, resolve.session, resolve.note);
      }
      case "status":
        return { ...this.app.status(), clients: this.peers.size };
      default:
        throw new RemoteError(ERR.method, `Unknown method ${method}`);
    }
  }
}
