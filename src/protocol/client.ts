// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { proof, PROTOCOL_VERSION, readSecret, type Role } from "./auth.js";
import { Connection } from "./connection.js";
import { resolvePaths, type Paths } from "./paths.js";

export interface ConnectOptions {
  role: Role;
  client: string;
  paths?: Paths;
  /** Command that starts the daemon when no socket is reachable. */
  daemonCommand?: readonly string[];
  startTimeoutMs?: number;
}

export interface Welcome {
  protocol: number;
  connectionId: string;
}

function openSocket(path: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(new Connection(socket)));
    socket.once("error", reject);
  });
}

async function handshake(connection: Connection, paths: Paths, role: Role, client: string): Promise<Welcome> {
  const nonce = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Daemon sent no challenge")), 5000);
    connection.onNotification = (method, params) => {
      if (method === "challenge") {
        clearTimeout(timer);
        resolve(String((params as { nonce?: unknown })?.nonce ?? ""));
      }
    };
    connection.onClose(() => reject(new Error("Daemon closed the connection")));
  });
  connection.onNotification = () => {};
  const secret = readSecret(paths.secret);
  return connection.request<Welcome>("hello", {
    protocol: PROTOCOL_VERSION,
    role,
    client,
    proof: proof(secret, nonce, role, client),
  });
}

/** Start the daemon detached; its stderr goes to daemon.stderr.log for diagnosis. */
export function startDaemon(command: readonly string[], paths: Paths): Promise<void> {
  const [program, ...args] = command;
  if (!program) return Promise.reject(new Error("No daemon command configured"));
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  const stderr = openSync(join(paths.stateDir, "daemon.stderr.log"), "a", 0o600);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: ["ignore", "ignore", stderr], env: process.env });
    child.once("error", (error) => reject(new Error(`Could not start "${command.join(" ")}": ${error.message}`)));
    child.once("spawn", () => resolve());
    child.unref();
  }).finally(() => closeSync(stderr));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect and authenticate, starting the daemon if needed. */
export async function connectDaemon(options: ConnectOptions): Promise<{ connection: Connection; welcome: Welcome }> {
  const paths = options.paths ?? resolvePaths();
  let started = false;
  const deadline = Date.now() + (options.startTimeoutMs ?? 5000);
  let delay = 100;
  for (;;) {
    try {
      if (!existsSync(paths.secret)) throw new Error("no secret");
      const connection = await openSocket(paths.socket);
      const welcome = await handshake(connection, paths, options.role, options.client);
      return { connection, welcome };
    } catch (error) {
      if (!options.daemonCommand) throw new Error(`The watcher daemon is not reachable at ${paths.socket}: ${String(error)}`);
      if (!started) {
        started = true;
        await startDaemon(options.daemonCommand, paths);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The watcher daemon did not start within the timeout (command: ${options.daemonCommand.join(" ")}; see ${join(paths.stateDir, "daemon.stderr.log")}). Run "ssw doctor".`,
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }
}
