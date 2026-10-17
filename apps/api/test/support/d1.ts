import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlResult, SqlStatement, SqlValue } from "../../src/platform.js";

// D1 stand-in over Node's built-in SQLite (D1 *is* SQLite), with the real migrations applied. Every call yields
// to the event loop first, so concurrent requests interleave at the same points they would against D1.

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

const tick = () => new Promise<void>((r) => setImmediate(r));
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

class Statement implements SqlStatement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly params: SqlValue[];
  constructor(db: DatabaseSync, sql: string, params: SqlValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: SqlValue[]): SqlStatement {
    return new Statement(this.db, this.sql, values);
  }
  execSync(): SqlResult<unknown> {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...this.params).map((r) => plain(r));
      const changes = Number((this.db.prepare("SELECT changes() AS c").get() as { c: number }).c);
      return { results: rows, meta: { changes: /^\s*select/i.test(this.sql) ? 0 : changes } };
    }
    const r = stmt.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  async first<T>(): Promise<T | null> {
    await tick();
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? plain<T>(row) : null;
  }
  async all<T>(): Promise<SqlResult<T>> {
    await tick();
    return this.execSync() as SqlResult<T>;
  }
  async run(): Promise<SqlResult<unknown>> {
    await tick();
    return this.execSync();
  }
}

export class SqliteD1 implements SqlDb {
  readonly raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(":memory:");
    for (const f of readdirSync(MIGRATIONS).sort()) this.raw.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  prepare(query: string): SqlStatement {
    return new Statement(this.raw, query);
  }
  async batch(statements: SqlStatement[]): Promise<SqlResult<unknown>[]> {
    await tick();
    this.raw.exec("BEGIN");
    try {
      const out = statements.map((s) => (s as Statement).execSync());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  /** Synchronous helper for assertions. */
  query<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw
      .prepare(sql)
      .all(...params)
      .map((r) => plain<T>(r));
  }
}
