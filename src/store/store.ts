// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

export type Row = Record<string, SQLInputValue>;
export type Param = SQLInputValue | undefined;

export class Store {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  get version(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  private migrate(): void {
    const current = this.version;
    if (current > MIGRATIONS.length) {
      throw new Error(`Database schema ${current} is newer than this watcher supports (${MIGRATIONS.length}).`);
    }
    for (let index = current; index < MIGRATIONS.length; index++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[index]!);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }

  /** Run `fn` in a transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...clean(params)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...clean(params)) as T[];
  }

  run(sql: string, ...params: Param[]): number {
    return Number(this.db.prepare(sql).run(...clean(params)).changes);
  }

  close(): void {
    this.db.close();
  }
}

function clean(params: Param[]): SQLInputValue[] {
  return params.map((value) => (value === undefined ? null : value));
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
