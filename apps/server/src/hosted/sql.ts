import type { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { openDatabase } from '@tandem/adapters';

/*
 * The directory's database: SQLite on one server (the default), or Postgres when the web app runs
 * on more than one replica (TANDEM_DATABASE_URL). Queries are written once, with `?` placeholders
 * and SQL both understand; BIGINT columns come back as numbers either way.
 */

export type Row = Record<string, unknown>;

export interface Sql {
  readonly dialect: 'sqlite' | 'postgres';
  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  /** Returns how many rows changed. */
  run(sql: string, ...params: unknown[]): Promise<number>;
  /** Several statements (migrations). */
  exec(sql: string): Promise<void>;
  /** One transaction; `lock` rows inside with SELECT … FOR UPDATE (Postgres; SQLite has one writer). */
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** SQLite: one connection; transactions are queued so two never interleave on it. */
class SqliteSql implements Sql {
  readonly dialect = 'sqlite' as const;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly db: DatabaseSync,
    private readonly inTx = false,
  ) {}
  private bind(params: unknown[]) {
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p)) as Array<string | number | null>;
  }
  async all<T>(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql.replace(/ FOR UPDATE\b/i, '')).all(...this.bind(params)) as T[];
  }
  async get<T>(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql.replace(/ FOR UPDATE\b/i, '')).get(...this.bind(params)) as T | undefined;
  }
  async run(sql: string, ...params: unknown[]) {
    return Number(this.db.prepare(sql).run(...this.bind(params)).changes);
  }
  async exec(sql: string) {
    this.db.exec(sql);
  }
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const run = async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(new SqliteSql(this.db, true));
        this.db.exec('COMMIT');
        return out;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  async close() {
    this.db.close();
  }
}

type Queryable = Pick<pg.Pool, 'query'>;

/** `?` placeholders become $1, $2, … (the directory's SQL has no `?` inside its strings). */
const numbered = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};
// BIGINT (millisecond times, counts) as numbers, not strings.
pg.types.setTypeParser(20, (v) => Number(v));

class PgSql implements Sql {
  readonly dialect = 'postgres' as const;
  constructor(
    private readonly q: Queryable,
    private readonly pool?: pg.Pool,
  ) {}
  async all<T>(sql: string, ...params: unknown[]) {
    return (await this.q.query(numbered(sql), params)).rows as T[];
  }
  async get<T>(sql: string, ...params: unknown[]) {
    return (await this.all<T>(sql, ...params))[0];
  }
  async run(sql: string, ...params: unknown[]) {
    return (await this.q.query(numbered(sql), params)).rowCount ?? 0;
  }
  async exec(sql: string) {
    await this.q.query(sql);
  }
  async tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(new PgSql(client));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool?.end();
  }
}

/** A postgres:// URL opens Postgres; anything else is a SQLite file. */
export async function openSql(target: string): Promise<Sql> {
  if (/^postgres(ql)?:\/\//.test(target)) {
    const pool = new pg.Pool({ connectionString: target, max: 10, idleTimeoutMillis: 30_000 });
    pool.on('error', () => undefined);
    await pool.query('SELECT 1');
    return new PgSql(pool, pool);
  }
  const db = await openDatabase(target);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return new SqliteSql(db);
}
