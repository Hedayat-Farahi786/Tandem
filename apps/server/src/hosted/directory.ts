import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '@tandem/adapters';

/*
 * The hosted app's directory: people, their sessions, workspaces and who belongs to which. Each
 * workspace's own data (projects, tasks, chats, audit log) lives in its own database, so one
 * workspace can never read another's. Tokens are stored encrypted (AES-256-GCM).
 */

export interface User {
  id: string;
  githubId: number;
  login: string;
  name: string;
  email?: string | undefined;
  avatarUrl?: string | undefined;
  createdAt: string;
}
export type Role = 'owner' | 'member';
export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
}
export interface Membership extends Workspace {
  role: Role;
}
export interface Session {
  userId: string;
  csrf: string;
  workspaceId?: string | undefined;
  expiresAt: number;
}
export interface GitHubTokens {
  access: string;
  accessExpiresAt?: number | undefined;
  refresh?: string | undefined;
  refreshExpiresAt?: number | undefined;
}

const MIGRATIONS = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT, avatar_url TEXT, created_at TEXT NOT NULL);
   CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, workspace_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
   CREATE TABLE members (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id));
   CREATE INDEX members_user ON members(user_id);
   CREATE TABLE github_tokens (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sealed TEXT NOT NULL, updated_at TEXT NOT NULL);`,
];

const SESSION_DAYS = 14;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export class Directory {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
    private readonly now: () => number,
  ) {}

  /** Opens (and migrates) the directory. `secret` is 32 bytes, base64: the key that seals tokens. */
  static async open(path: string, secret: string, now: () => number = Date.now): Promise<Directory> {
    const key = Buffer.from(secret, 'base64');
    if (key.length !== 32) throw new Error('TANDEM_SECRET_KEY must be 32 random bytes in base64 (openssl rand -base64 32).');
    const db = await openDatabase(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
    MIGRATIONS.forEach((sql, i) => {
      if (done.has(i + 1)) return;
      db.exec('BEGIN');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, new Date(now()).toISOString());
      db.exec('COMMIT');
    });
    return new Directory(db, key, now);
  }

  close() {
    this.db.close();
  }

  /* ---------------------------------------------------------------- sealing */

  private seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`;
  }
  private unseal(sealed: string): string {
    const [v, iv, tag, body] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !body) throw new Error('Unknown sealed format.');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  }

  /* ---------------------------------------------------------------- users */

  private toUser(r: Record<string, unknown>): User {
    return { id: String(r.id), githubId: Number(r.github_id), login: String(r.login), name: String(r.name), ...(r.email ? { email: String(r.email) } : {}), ...(r.avatar_url ? { avatarUrl: String(r.avatar_url) } : {}), createdAt: String(r.created_at) };
  }

  /** Creates or updates the person behind a GitHub account. */
  upsertGitHubUser(gh: { id: number; login: string; name?: string | null; email?: string | null; avatarUrl?: string | null }): User {
    const existing = this.db.prepare('SELECT * FROM users WHERE github_id = ?').get(gh.id) as Record<string, unknown> | undefined;
    const name = gh.name?.trim() || gh.login;
    if (existing) {
      this.db.prepare('UPDATE users SET login = ?, name = ?, email = ?, avatar_url = ? WHERE id = ?').run(gh.login, name, gh.email ?? null, gh.avatarUrl ?? null, String(existing.id));
      return this.user(String(existing.id))!;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO users (id, github_id, login, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, gh.id, gh.login, name, gh.email ?? null, gh.avatarUrl ?? null, new Date(this.now()).toISOString());
    return this.user(id)!;
  }

  user(id: string): User | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.toUser(r) : undefined;
  }

  /** Deletes a person: sessions, tokens and memberships go with them (GDPR erasure). Returns the workspaces left without an owner. */
  deleteUser(id: string): string[] {
    const owned = (this.db.prepare("SELECT workspace_id FROM members WHERE user_id = ? AND role = 'owner'").all(id) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return owned.filter((w) => !(this.db.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND role = 'owner'").get(w)));
  }

  /* ---------------------------------------------------------------- GitHub tokens */

  saveGitHubTokens(userId: string, t: GitHubTokens) {
    this.db.prepare('INSERT INTO github_tokens (user_id, sealed, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at').run(userId, this.seal(JSON.stringify(t)), new Date(this.now()).toISOString());
  }
  gitHubTokens(userId: string): GitHubTokens | undefined {
    const r = this.db.prepare('SELECT sealed FROM github_tokens WHERE user_id = ?').get(userId) as { sealed: string } | undefined;
    return r ? (JSON.parse(this.unseal(r.sealed)) as GitHubTokens) : undefined;
  }

  /* ---------------------------------------------------------------- sessions */

  /** A new session; returns the cookie value (only its hash is stored). */
  createSession(userId: string, workspaceId?: string): { id: string; session: Session } {
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + SESSION_DAYS * 86_400_000;
    this.db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(hash(id), userId, csrf, workspaceId ?? null, this.now(), expiresAt);
    return { id, session: { userId, csrf, ...(workspaceId ? { workspaceId } : {}), expiresAt } };
  }
  session(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const r = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(hash(id)) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    if (Number(r.expires_at) < this.now()) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(id));
      return undefined;
    }
    return { userId: String(r.user_id), csrf: String(r.csrf), ...(r.workspace_id ? { workspaceId: String(r.workspace_id) } : {}), expiresAt: Number(r.expires_at) };
  }
  useWorkspace(sessionId: string, workspaceId: string) {
    this.db.prepare('UPDATE sessions SET workspace_id = ? WHERE id_hash = ?').run(workspaceId, hash(sessionId));
  }
  endSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(id));
  }
  static csrfMatches(session: Session, given: string | undefined): boolean {
    if (!given || given.length !== session.csrf.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(session.csrf));
  }

  /* ---------------------------------------------------------------- workspaces */

  createWorkspace(name: string, ownerId: string): Workspace {
    const w: Workspace = { id: randomUUID(), name: name.trim().slice(0, 80) || 'My workspace', createdAt: new Date(this.now()).toISOString(), createdBy: ownerId };
    this.db.exec('BEGIN');
    this.db.prepare('INSERT INTO workspaces (id, name, created_at, created_by) VALUES (?, ?, ?, ?)').run(w.id, w.name, w.createdAt, w.createdBy);
    this.db.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(w.id, ownerId, w.createdAt);
    this.db.exec('COMMIT');
    return w;
  }
  workspacesOf(userId: string): Membership[] {
    return (this.db.prepare('SELECT w.*, m.role FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at').all(userId) as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.created_at), createdBy: String(r.created_by), role: r.role as Role }));
  }
  /** The person's role in a workspace, or undefined when they are not a member. */
  roleIn(workspaceId: string, userId: string): Role | undefined {
    return (this.db.prepare('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId) as { role: Role } | undefined)?.role;
  }
  addMember(workspaceId: string, userId: string, role: Role = 'member') {
    this.db.prepare('INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(workspaceId, userId, role, new Date(this.now()).toISOString());
  }
  allWorkspaces(): Workspace[] {
    return (this.db.prepare('SELECT * FROM workspaces ORDER BY created_at').all() as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.created_at), createdBy: String(r.created_by) }));
  }
  deleteWorkspace(id: string) {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }
}
