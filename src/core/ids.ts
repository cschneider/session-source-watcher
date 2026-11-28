// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit millisecond time plus 80 random bits, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[bytes[i]! % 32];
  return time + random;
}

export function shortId(id: string): string {
  return id.slice(-6).toLowerCase();
}
