// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from "node:fs";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Append-only log of identifiers and states; never source content. */
export function fileLogger(path: string): Logger {
  const write = (level: string, message: string) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${message.replace(/\s+/g, " ").slice(0, 1000)}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the daemon down.
    }
  };
  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
