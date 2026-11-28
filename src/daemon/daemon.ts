// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { systemClock, type Clock } from "../core/clock.js";
import { ensureSecret } from "../protocol/auth.js";
import { ensureDirs, type Paths } from "../protocol/paths.js";
import { Store } from "../store/store.js";
import { App } from "./app.js";
import { Collector } from "./collector.js";
import { Delivery } from "./delivery.js";
import { fileLogger, type Logger } from "./log.js";
import { SourceRegistry } from "./registry.js";
import { runRetention } from "./retention.js";
import { IpcServer } from "./server.js";

export interface DaemonOptions {
  paths: Paths;
  sources: SourceRegistry;
  clock?: Clock;
  logger?: Logger;
  /** Exit after this long with no active watches and no clients. 0 disables. */
  idleExitMs?: number;
  /** Disable timers; tests drive ticks explicitly. */
  manual?: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function socketInUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export class AlreadyRunning extends Error {}

export class Daemon {
  readonly store: Store;
  readonly app: App;
  readonly collector: Collector;
  readonly delivery: Delivery;
  readonly server: IpcServer;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly timers: NodeJS.Timeout[] = [];
  private lockFd: number | undefined;
  private idleSince: number;
  private stopping = false;
  private collecting = false;
  private delivering = false;
  onStop: () => void = () => {};

  constructor(private readonly options: DaemonOptions) {
    // Everything the daemon creates (database, socket, log) is private to the user.
    process.umask(0o077);
    ensureDirs(options.paths);
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? fileLogger(options.paths.log);
    this.acquireLock();
    const secret = ensureSecret(options.paths.secret);
    this.store = new Store(options.paths.database);
    this.app = new App(this.store, options.sources, this.clock);
    this.collector = new Collector(this.app, this.store, this.clock, this.log);
    this.delivery = new Delivery(this.app, this.store, this.clock, this.log);
    this.server = new IpcServer(this.app, this.delivery, secret, this.log);
    this.idleSince = this.clock.now();
    this.server.onActivity = () => (this.idleSince = this.clock.now());
    this.app.onChange((kind, bindingId) => {
      if (this.options.manual) return;
      if (kind === "watches") setImmediate(() => void this.collect());
      if (bindingId) setImmediate(() => void this.delivery.run(bindingId));
    });
  }

  private acquireLock(): void {
    const path = this.options.paths.lock;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.lockFd = openSync(path, "wx", 0o600);
        writeSync(this.lockFd, String(process.pid));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number(readFileSync(path, "utf8").trim());
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
          throw new AlreadyRunning(`A watcher daemon is already running (pid ${pid}); socket ${this.options.paths.socket}`);
        }
        unlinkSync(path);
      }
    }
    throw new Error(`Could not acquire ${path}`);
  }

  async start(): Promise<void> {
    const socket = this.options.paths.socket;
    if (process.platform !== "win32" && existsSync(socket)) {
      if (await socketInUse(socket)) throw new AlreadyRunning(`Another daemon is listening on ${socket}`);
      unlinkSync(socket);
    }
    await this.server.listen(socket);
    // Restart: packets that were being sent may have reached the harness.
    this.store.run("UPDATE packets SET state = 'unconfirmed' WHERE state = 'sending'");
    this.store.run("UPDATE collection_groups SET lease_owner = NULL, lease_until = NULL");
    this.store.run("UPDATE bindings SET status = 'disconnected', busy = 0 WHERE status = 'connected'");
    this.log.info(`daemon started pid ${process.pid}`);
    if (this.options.manual) return;
    this.every(1000, () => this.collect());
    this.every(5000, () => this.deliver());
    this.every(3_600_000, () => runRetention(this.store, this.clock.now()));
    this.every(60_000, () => this.checkIdle());
    runRetention(this.store, this.clock.now());
  }

  private every(ms: number, fn: () => unknown): void {
    const timer = setInterval(() => {
      try {
        const result = fn();
        if (result instanceof Promise) result.catch((error: unknown) => this.log.error(String(error)));
      } catch (error) {
        this.log.error(String(error));
      }
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  async collect(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      await this.collector.tick();
    } finally {
      this.collecting = false;
    }
  }

  async deliver(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      await this.delivery.tick();
    } finally {
      this.delivering = false;
    }
  }

  private checkIdle(): void {
    const idleExit = this.options.idleExitMs ?? 10 * 60_000;
    if (!idleExit) return;
    const active = this.store.get<{ n: number }>(
      "SELECT count(*) AS n FROM subscriptions WHERE state IN ('active', 'paused', 'suspended')",
    )!.n;
    const pending = this.store.get<{ n: number }>("SELECT count(*) AS n FROM packets WHERE state <> 'closed'")!.n;
    if (active || pending || this.server.peers.size) {
      this.idleSince = this.clock.now();
      return;
    }
    if (this.clock.now() - this.idleSince >= idleExit) {
      this.log.info("idle, exiting");
      void this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await this.server.close();
    this.store.close();
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd);
      try {
        unlinkSync(this.options.paths.lock);
      } catch {
        // Already gone.
      }
    }
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.options.paths.socket);
      } catch {
        // Already gone.
      }
    }
    this.onStop();
  }
}
