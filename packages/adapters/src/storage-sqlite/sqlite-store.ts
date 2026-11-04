import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from 'node:sqlite';
import { DEFAULT_SETTINGS, Settings, type AgentStep, type AuditEntry, type Task, type TaskTransition } from '@tandem/shared';
import { auditMatches, chainEntry, lockedStore, redactor, type Collection, type Job, type RawRepos, type Store, type TaskScoped, type TrackerComment } from '@tandem/core';
import { MIGRATIONS } from './migrations.js';
import { openDatabase } from './open.js';

type Row = Record<string, SQLInputValue>;

interface TableSpec<T> {
  table: string;
  /** Primary key column (default "id"). */
  pk?: string;
  /** Indexed columns derived from the document. */
  columns: (doc: T) => Row;
}

/** Raw repositories over one node:sqlite connection. SqliteStore adds locking and transactions. */
class SqliteRepos implements RawRepos {
  constructor(readonly db: DatabaseSyncT) {}

  /** Raw operations are synchronous; the locked facade serializes them. */
  private async op<T>(fn: () => T): Promise<T> {
    return fn();
  }

  /* -------------------------------------------------------------- helpers */

  private encode(doc: unknown): string {
    return JSON.stringify(redactor.redactDeep(doc));
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return (this.db.prepare(sql).all(...params) as Array<{ doc: string }>).map((r) => JSON.parse(r.doc) as T);
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const r = this.db.prepare(sql).get(...params) as { doc: string } | undefined;
    return r ? (JSON.parse(r.doc) as T) : undefined;
  }

  /** Upsert that keeps the row's position (INSERT OR REPLACE would move it to the end). */
  private put<T>(spec: TableSpec<T>, doc: T): void {
    const cols = { ...spec.columns(doc), doc: this.encode(doc) };
    const names = Object.keys(cols);
    const pk = spec.pk ?? 'id';
    const updates = names.filter((n) => n !== pk).map((n) => `${n} = excluded.${n}`);
    this.db.prepare(`INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(${pk}) DO UPDATE SET ${updates.join(', ')}`).run(...Object.values(cols));
  }

  private collection<T extends { id: string }>(spec: TableSpec<T>): Collection<T> {
    return {
      get: (id) => this.op(() => this.one<T>(`SELECT doc FROM ${spec.table} WHERE id = ?`, id)),
      list: () => this.op(() => this.all<T>(`SELECT doc FROM ${spec.table} ORDER BY rowid`)),
      upsert: (item) => this.op(() => this.put(spec, item)),
      delete: (id) => this.op(() => void this.db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id)),
    };
  }

  private scoped<T extends { id: string; taskId: string }>(spec: TableSpec<T>): TaskScoped<T> {
    return {
      get: (id) => this.op(() => this.one<T>(`SELECT doc FROM ${spec.table} WHERE id = ?`, id)),
      list: (taskId) => this.op(() => this.all<T>(`SELECT doc FROM ${spec.table} WHERE task_id = ? ORDER BY rowid`, taskId)),
      upsert: (item) => this.op(() => this.put(spec, item)),
    };
  }

  /* -------------------------------------------------------------- repositories */

  projects: Store['projects'] = this.collection({ table: 'projects', columns: (p) => ({ id: p.id }) });
  repos: Store['repos'] = this.collection({ table: 'repos', columns: (r) => ({ id: r.id }) });

  private readonly taskSpec: TableSpec<Task> = { table: 'tasks', columns: (t) => ({ id: t.id, key: t.key, project_id: t.projectId, state: t.state, updated_at: t.updatedAt }) };
  tasks: Store['tasks'] = {
    ...this.collection(this.taskSpec),
    getByKey: (key) => this.op(() => this.one<Task>('SELECT doc FROM tasks WHERE key = ?', key)),
    listByState: (states) => this.op(() => (states.length ? this.all<Task>(`SELECT doc FROM tasks WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY rowid`, ...states) : [])),
    nextSeq: (prefix) =>
      this.op(() => {
        const rows = this.db.prepare("SELECT key FROM tasks WHERE key LIKE ? || '-%'").all(prefix) as Array<{ key: string }>;
        return rows.reduce((max, r) => Math.max(max, Number(/-(\d+)$/.exec(r.key)?.[1] ?? 0)), 0) + 1;
      }),
  };

  transitions: Store['transitions'] = {
    add: (t) =>
      this.op(() => {
        const r = this.db.prepare('INSERT INTO transitions (task_id, at, doc) VALUES (?, ?, ?)').run(t.taskId, t.at, this.encode(t));
        return { ...t, id: Number(r.lastInsertRowid) } as TaskTransition;
      }),
    list: (taskId) =>
      this.op(() => (this.db.prepare('SELECT id, doc FROM transitions WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number; doc: string }>).map((r) => ({ ...(JSON.parse(r.doc) as Omit<TaskTransition, 'id'>), id: r.id }))),
  };

  specs: Store['specs'] = {
    add: (v) =>
      this.op(() => {
        this.db.prepare('INSERT INTO specs (task_id, version, doc) VALUES (?, ?, ?)').run(v.taskId, v.version, this.encode(v));
      }),
    list: (taskId) => this.op(() => this.all('SELECT doc FROM specs WHERE task_id = ? ORDER BY version', taskId)),
    latest: (taskId) => this.op(() => this.one('SELECT doc FROM specs WHERE task_id = ? ORDER BY version DESC LIMIT 1', taskId)),
  };

  approvals: Store['approvals'] = this.scoped({ table: 'approvals', columns: (a) => ({ id: a.id, task_id: a.taskId }) });

  runs: Store['runs'] = {
    ...this.collection({ table: 'runs', columns: (r) => ({ id: r.id, task_id: r.taskId ?? null, thread_id: r.threadId ?? null }) }),
    listFor: (scope) =>
      this.op(() => {
        if (scope.taskId) return this.all('SELECT doc FROM runs WHERE task_id = ? ORDER BY rowid', scope.taskId);
        if (scope.threadId) return this.all('SELECT doc FROM runs WHERE thread_id = ? ORDER BY rowid', scope.threadId);
        return this.all('SELECT doc FROM runs ORDER BY rowid');
      }),
  };

  verifyRuns: Store['verifyRuns'] = this.scoped({ table: 'verify_runs', columns: (v) => ({ id: v.id, task_id: v.taskId, created_at: v.createdAt }) });

  criterionTests: Store['criterionTests'] = {
    replace: (taskId, items) => this.op(() => void this.db.prepare('INSERT INTO criterion_tests (task_id, doc) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET doc = excluded.doc').run(taskId, this.encode(items))),
    list: (taskId) => this.op(() => this.one('SELECT doc FROM criterion_tests WHERE task_id = ?', taskId) ?? []),
  };

  private readonly findingSpec: TableSpec<{ id: string; taskId: string }> = { table: 'findings', columns: (f) => ({ id: f.id, task_id: f.taskId }) };
  findings: Store['findings'] = {
    ...(this.scoped(this.findingSpec) as Store['findings']),
    replace: (taskId, items) =>
      this.op(() => {
        this.db.prepare('DELETE FROM findings WHERE task_id = ?').run(taskId);
        for (const f of items) this.put(this.findingSpec, f);
      }),
  };

  prs: Store['prs'] = {
    ...(this.scoped({ table: 'prs', columns: (p: { id: string; taskId: string; status?: string }) => ({ id: p.id, task_id: p.taskId, status: p.status ?? null }) }) as Store['prs']),
    listByStatus: (statuses) => this.op(() => (statuses.length ? this.all(`SELECT doc FROM prs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY rowid`, ...statuses) : [])),
  };

  threads: Store['threads'] = {
    ...(this.collection({ table: 'threads', columns: (t: { id: string; projectId?: string; taskId?: string }) => ({ id: t.id, project_id: t.projectId ?? null, task_id: t.taskId ?? null }) }) as unknown as Store['threads']),
    listFor: (scope) =>
      this.op(() => {
        if (scope.taskId !== undefined) return this.all('SELECT doc FROM threads WHERE task_id = ? ORDER BY rowid', scope.taskId);
        if (scope.projectId) return this.all('SELECT doc FROM threads WHERE project_id = ? ORDER BY rowid', scope.projectId);
        return this.all('SELECT doc FROM threads ORDER BY rowid');
      }),
  };

  messages: Store['messages'] = {
    add: (m) => this.op(() => void this.db.prepare('INSERT INTO messages (id, thread_id, created_at, doc) VALUES (?, ?, ?, ?)').run(m.id, m.threadId, m.createdAt, this.encode(m))),
    list: (threadId) => this.op(() => this.all('SELECT doc FROM messages WHERE thread_id = ? ORDER BY seq', threadId)),
    deleteFor: (threadId) => this.op(() => Number(this.db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId).changes)),
  };

  rules: Store['rules'] = {
    ...(this.collection({ table: 'rules', columns: (r: { id: string; repoId: string; status: string }) => ({ id: r.id, repo_id: r.repoId, status: r.status }) }) as unknown as Store['rules']),
    listPending: (repoId) => this.op(() => this.all("SELECT doc FROM rules WHERE repo_id = ? AND status = 'pending' ORDER BY rowid", repoId)),
  };

  usage: Store['usage'] = {
    add: (u) => this.op(() => void this.db.prepare('INSERT INTO usage (id, task_id, at, prompts, doc) VALUES (?, ?, ?, ?, ?)').run(u.id, u.taskId ?? null, u.at, u.prompts, this.encode(u))),
    prompts: (scope) =>
      this.op(() => {
        const { where, params } = usageWhere(scope);
        return (this.db.prepare(`SELECT COALESCE(SUM(prompts), 0) AS n FROM usage ${where}`).get(...params) as { n: number }).n;
      }),
    list: (scope) =>
      this.op(() => {
        const { where, params } = usageWhere(scope);
        return this.all(`SELECT doc FROM usage ${where} ORDER BY at`, ...params);
      }),
  };

  jobs: Store['jobs'] = {
    get: (taskId) => this.op(() => this.one<Job>('SELECT doc FROM jobs WHERE task_id = ?', taskId)),
    upsert: (job) => this.op(() => void this.db.prepare('INSERT INTO jobs (task_id, doc) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET doc = excluded.doc').run(job.taskId, JSON.stringify(job))),
    delete: (taskId) => this.op(() => void this.db.prepare('DELETE FROM jobs WHERE task_id = ?').run(taskId)),
    list: () => this.op(() => this.all<Job>('SELECT doc FROM jobs ORDER BY rowid')),
  };

  settings: Store['settings'] = {
    get: () => this.op(() => Settings.parse(this.one("SELECT doc FROM settings WHERE id = 'settings'") ?? DEFAULT_SETTINGS)),
    set: (s) => this.op(() => void this.db.prepare("INSERT INTO settings (id, doc) VALUES ('settings', ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc").run(JSON.stringify(Settings.parse(s)))),
  };

  trackerComments: Store['trackerComments'] = {
    add: (c) => this.op(() => void this.db.prepare('INSERT INTO tracker_comments (id, key, created_at, doc) VALUES (?, ?, ?, ?)').run(c.id, c.key, c.createdAt, this.encode(c))),
    list: (key) => this.op(() => this.all<TrackerComment>('SELECT doc FROM tracker_comments WHERE key = ? ORDER BY created_at, rowid', key)),
  };

  agentSteps: Store['agentSteps'] = {
    add: (step) => this.op(() => void this.db.prepare('INSERT INTO agent_steps (id, run_id, task_id, seq, at, doc) VALUES (?, ?, ?, ?, ?, ?)').run(step.id, step.runId, step.taskId ?? null, step.seq, step.at, this.encode(step))),
    list: (scope) =>
      this.op(() => {
        if (scope.runId) return this.all<AgentStep>('SELECT doc FROM agent_steps WHERE run_id = ? ORDER BY seq', scope.runId);
        if (scope.taskId) return this.all<AgentStep>('SELECT doc FROM agent_steps WHERE task_id = ? ORDER BY at, seq', scope.taskId);
        return this.all<AgentStep>('SELECT doc FROM agent_steps ORDER BY at, seq');
      }),
  };

  audit: Store['audit'] = {
    append: (input) =>
      this.op(() => {
        // Redact first: the hash covers exactly what is stored.
        const e = chainEntry(this.one<AuditEntry>('SELECT doc FROM audit ORDER BY seq DESC LIMIT 1'), redactor.redactDeep(input));
        this.db.prepare('INSERT INTO audit (seq, at, task_id, action, doc) VALUES (?, ?, ?, ?, ?)').run(e.seq, e.at, e.taskId ?? null, e.action, JSON.stringify(e));
        return e;
      }),
    list: (scope = {}) =>
      this.op(() => {
        const clauses: string[] = [];
        const params: SQLInputValue[] = [];
        if (scope.taskId) {
          clauses.push('task_id = ?');
          params.push(scope.taskId);
        }
        if (scope.since) {
          clauses.push('at >= ?');
          params.push(scope.since);
        }
        if (scope.until) {
          clauses.push('at < ?');
          params.push(scope.until);
        }
        if (scope.afterSeq) {
          clauses.push('seq > ?');
          params.push(scope.afterSeq);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = scope.limit ? this.all<AuditEntry>(`SELECT doc FROM audit ${where} ORDER BY seq DESC LIMIT ?`, ...params, scope.limit).reverse() : this.all<AuditEntry>(`SELECT doc FROM audit ${where} ORDER BY seq`, ...params);
        return rows.filter((e) => auditMatches(e, scope));
      }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface SqliteStore extends Store {}

/**
 * SQLite Store on node:sqlite (Node >= 22.13). Each entity has its own table: indexed columns for
 * queries plus the full document as JSON, so a Postgres implementation can mirror it (jsonb).
 * Every document passes through the redactor on write, as a last line of defence.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SqliteStore {
  private constructor(readonly db: DatabaseSyncT) {
    const raw = new SqliteRepos(db);
    Object.assign(
      this,
      lockedStore(raw, {
        begin: () => db.exec('BEGIN IMMEDIATE'),
        commit: () => db.exec('COMMIT'),
        rollback: () => db.exec('ROLLBACK'),
      }),
    );
  }

  static async open(path: string): Promise<SqliteStore> {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = await openDatabase(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
    migrate(db);
    return new SqliteStore(db);
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  }
}

function migrate(db: DatabaseSyncT): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Database migration ${m.version} failed: ${String(err)}`, { cause: err });
    }
  }
}

function usageWhere(scope: { taskId?: string; since?: string }): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (scope.taskId) {
    clauses.push('task_id = ?');
    params.push(scope.taskId);
  }
  if (scope.since) {
    clauses.push('at >= ?');
    params.push(scope.since);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
