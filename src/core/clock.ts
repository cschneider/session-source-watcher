// SPDX-License-Identifier: Apache-2.0
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A manually advanced clock for tests. */
export class FakeClock implements Clock {
  constructor(private time = Date.UTC(2027, 0, 4, 9, 0, 0)) {}
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}
