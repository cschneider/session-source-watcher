// SPDX-License-Identifier: Apache-2.0
import type { Socket } from "node:net";

export const MAX_FRAME_BYTES = 1024 * 1024;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RemoteError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export const ERR = {
  parse: -32700,
  invalid: -32600,
  method: -32601,
  params: -32602,
  internal: -32603,
  unauthorized: -32001,
  conflict: -32002,
  notFound: -32003,
  refused: -32004,
} as const;

type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** JSON-RPC 2.0 over newline-delimited JSON, usable by both peers. */
export class Connection {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  onRequest: RequestHandler = (method) => {
    throw new RemoteError(ERR.method, `Unknown method ${method}`);
  };
  onNotification: NotificationHandler = () => {};
  private readonly closeListeners: Array<() => void> = [];

  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new RemoteError(ERR.internal, "Connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RemoteError(ERR.internal, `Timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.socket.end();
    this.handleClose();
  }

  private write(message: unknown): void {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new RemoteError(ERR.invalid, "Frame too large");
    this.socket.write(`${line}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.socket.destroy();
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: RpcError };
    try {
      message = JSON.parse(line);
    } catch {
      this.socket.destroy();
      return;
    }
    if (typeof message.method === "string") {
      const method = message.method;
      if (message.id === undefined) {
        try {
          this.onNotification(method, message.params);
        } catch {
          // Notifications have no reply channel.
        }
        return;
      }
      const id = message.id;
      Promise.resolve()
        .then(() => this.onRequest(method, message.params))
        .then(
          (result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
          (error: unknown) => {
            const remote =
              error instanceof RemoteError ? error : new RemoteError(ERR.internal, error instanceof Error ? error.message : String(error));
            this.write({ jsonrpc: "2.0", id, error: { code: remote.code, message: remote.message, data: remote.data } });
          },
        )
        .catch(() => {});
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RemoteError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RemoteError(ERR.internal, "Connection closed"));
    }
    this.pending.clear();
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}
