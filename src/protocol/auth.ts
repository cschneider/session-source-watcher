// SPDX-License-Identifier: Apache-2.0
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const PROTOCOL_VERSION = 1;

export type Role = "adapter" | "cli" | "ui";

export function proof(secret: Buffer, nonce: string, role: Role, client: string): string {
  return createHmac("sha256", secret).update(`${nonce}|${PROTOCOL_VERSION}|${role}|${client}`).digest("hex");
}

export function verifyProof(secret: Buffer, nonce: string, role: Role, client: string, given: string): boolean {
  const expected = Buffer.from(proof(secret, nonce, role, client), "hex");
  const actual = Buffer.from(given, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function readSecret(path: string): Buffer {
  return readFileSync(path);
}

export function ensureSecret(path: string): Buffer {
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  return readFileSync(path);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
