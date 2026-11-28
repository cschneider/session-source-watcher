// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface Paths {
  stateDir: string;
  runtimeDir: string;
  socket: string;
  secret: string;
  lock: string;
  database: string;
  hostId: string;
  log: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const stateDir =
    env["SSW_STATE_DIR"] ??
    (platform() === "darwin"
      ? join(homedir(), "Library", "Application Support", "session-source-watcher")
      : join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "session-source-watcher"));
  const runtimeDir = env["SSW_STATE_DIR"]
    ? stateDir
    : env["XDG_RUNTIME_DIR"]
      ? join(env["XDG_RUNTIME_DIR"], "session-source-watcher")
      : stateDir;
  const socket =
    platform() === "win32" ? `\\\\.\\pipe\\session-source-watcher-${Buffer.from(stateDir).toString("hex").slice(-16)}` : join(runtimeDir, "daemon.sock");
  return {
    stateDir,
    runtimeDir,
    socket,
    secret: join(stateDir, "client.secret"),
    lock: join(stateDir, "daemon.lock"),
    database: join(stateDir, "state.db"),
    hostId: join(stateDir, "host.id"),
    log: join(stateDir, "daemon.log"),
  };
}

export function ensureDirs(paths: Paths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
}
