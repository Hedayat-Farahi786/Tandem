/**
 * Prototype of packages/adapters/src/tracker-local on node:sqlite (Node >= 22.13).
 * The real adapter implements the core Tracker port; this keeps the same shape.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// node:sqlite prints an ExperimentalWarning once per process; Tandem filters exactly that warning.
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
// Imported after the filter is installed; a static import would warn before this module runs.
const { DatabaseSync } = await import('node:sqlite');

export interface TrackerTask {
  key: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerComment {
  id: string;
  key: string;
  author: string;
  body: string;
  createdAt: string;
}

export class LocalTracker {
  readonly db: DatabaseSyncType;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tracker_tasks (
        key TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracker_comments (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL REFERENCES tracker_tasks(key) ON DELETE CASCADE,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracker_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL REFERENCES tracker_tasks(key) ON DELETE CASCADE,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tracker_comments_key ON tracker_comments(key, created_at);
    `);
  }

  createTask(title: string, description: string, prefix = 'TND'): TrackerTask {
    const now = new Date().toISOString();
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tracker_tasks').get() as { next: number };
    const key = `${prefix}-${row.next}`;
    this.db
      .prepare('INSERT INTO tracker_tasks (key, seq, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key, row.next, title, description, 'DRAFT', now, now);
    return this.getTask(key);
  }

  getTask(key: string): TrackerTask {
    const r = this.db.prepare('SELECT key, title, description, status, created_at, updated_at FROM tracker_tasks WHERE key = ?').get(key) as
      | { key: string; title: string; description: string; status: string; created_at: string; updated_at: string }
      | undefined;
    if (!r) throw new Error(`Task ${key} not found`);
    return { key: r.key, title: r.title, description: r.description, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  findReadyTasks(status = 'READY'): TrackerTask[] {
    const rows = this.db.prepare('SELECT key FROM tracker_tasks WHERE status = ? ORDER BY seq').all(status) as Array<{ key: string }>;
    return rows.map((r) => this.getTask(r.key));
  }

  comment(key: string, body: string, author = 'tandem'): TrackerComment {
    this.getTask(key);
    const c: TrackerComment = { id: randomUUID(), key, author, body, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO tracker_comments (id, key, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, c.key, c.author, c.body, c.createdAt);
    return c;
  }

  /** Status change and its history row are written in one transaction. */
  transition(key: string, to: string, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const from = this.getTask(key).status;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE tracker_tasks SET status = ?, updated_at = ? WHERE key = ?').run(to, now, key);
      this.db.prepare('INSERT INTO tracker_transitions (key, from_status, to_status, reason, at) VALUES (?, ?, ?, ?, ?)').run(key, from, to, reason, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  readReplies(key: string, since: Date, authors?: string[]): TrackerComment[] {
    const rows = this.db.prepare('SELECT id, key, author, body, created_at FROM tracker_comments WHERE key = ? AND created_at > ? ORDER BY created_at').all(key, since.toISOString()) as Array<{
      id: string;
      key: string;
      author: string;
      body: string;
      created_at: string;
    }>;
    return rows.filter((r) => !authors || authors.includes(r.author)).map((r) => ({ id: r.id, key: r.key, author: r.author, body: r.body, createdAt: r.created_at }));
  }

  transitions(key: string): Array<{ from: string; to: string; reason: string; at: string }> {
    return (this.db.prepare('SELECT from_status, to_status, reason, at FROM tracker_transitions WHERE key = ? ORDER BY id').all(key) as Array<{ from_status: string; to_status: string; reason: string; at: string }>).map((r) => ({
      from: r.from_status,
      to: r.to_status,
      reason: r.reason,
      at: r.at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
