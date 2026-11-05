import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSql, type Row, type Sql } from './sql.js';

/*
 * The hosted app's directory: people, their sessions, workspaces and who belongs to which, and on
 * more than one replica, which replica runs each workspace. Each workspace's own data (projects,
 * tasks, chats, audit log) lives in its own database, so one workspace can never read another's.
 * Tokens are stored encrypted (AES-256-GCM). SQLite on one server, Postgres for several.
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
export type RunnerMode = 'cloud' | 'company';
export interface RunnerKey {
  workspaceId: string;
  createdBy: string;
  createdAt: number;
  lastSeenAt?: number | undefined;
  machine?: string | undefined;
  /** The replica the runner is connected to right now (when it is). */
  connectedReplica?: string | undefined;
  connectedAt?: number | undefined;
}
export interface Replica {
  id: string;
  url: string;
  seenAt: number;
}

/** SQLite (as first shipped; never edited) and Postgres (the same tables, BIGINT for times). */
const SQLITE = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT, avatar_url TEXT, created_at TEXT NOT NULL);
   CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, workspace_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
   CREATE TABLE members (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id));
   CREATE INDEX members_user ON members(user_id);
   CREATE TABLE github_tokens (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sealed TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  // Each workspace's secrets (AWS connection, Jira and GitHub tokens), sealed; and whose Copilot plan it uses.
  `CREATE TABLE workspace_secrets (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, sealed TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, name));
   ALTER TABLE workspaces ADD COLUMN copilot_user_id TEXT;
   CREATE TABLE invites (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`,
  // Where a workspace works: Tandem's cloud, or a company's own computer (its runner and the runner's key).
  `ALTER TABLE workspaces ADD COLUMN runner TEXT NOT NULL DEFAULT 'cloud';
   CREATE TABLE runners (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, machine TEXT);`,
  // More than one replica: which replica runs each workspace, and where each runner is connected.
  `CREATE TABLE replicas (id TEXT PRIMARY KEY, url TEXT NOT NULL, seen_at INTEGER NOT NULL);
   ALTER TABLE workspaces ADD COLUMN replica TEXT;
   ALTER TABLE runners ADD COLUMN connected_replica TEXT;
   ALTER TABLE runners ADD COLUMN connected_at INTEGER;`,
];
const POSTGRES = SQLITE.map((m) => m.replace(/\bINTEGER\b/g, 'BIGINT'));

const SESSION_DAYS = 14;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export class Directory {
  /** Per person, one GitHub token renewal at a time (on one server; Postgres locks the row across replicas). */
  private readonly renewing = new Map<string, Promise<unknown>>();

  private constructor(
    readonly sql: Sql,
    private readonly key: Buffer,
    private readonly now: () => number,
  ) {}

  /**
   * Opens (and migrates) the directory: a SQLite file, or a postgres:// URL. `secret` is 32 bytes,
   * base64: the key that seals tokens.
   */
  static async open(target: string, secret: string, now: () => number = Date.now): Promise<Directory> {
    const key = Buffer.from(secret, 'base64');
    if (key.length !== 32) throw new Error('TANDEM_SECRET_KEY must be 32 random bytes in base64 (openssl rand -base64 32).');
    const sql = await openSql(target);
    await sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const steps = sql.dialect === 'postgres' ? POSTGRES : SQLITE;
    await sql.tx(async (q) => {
      // Replicas starting together: one migrates, the others wait for it.
      if (q.dialect === 'postgres') await q.get('SELECT pg_advisory_xact_lock(7213001)');
      const done = new Set((await q.all<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
      for (const [i, step] of steps.entries()) {
        if (done.has(i + 1)) continue;
        await q.exec(step);
        await q.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', i + 1, new Date(now()).toISOString());
      }
    });
    return new Directory(sql, key, now);
  }

  close(): Promise<void> {
    return this.sql.close();
  }

  /**
   * Copies everything from another directory (going from one replica's SQLite to Postgres). Rows
   * already there are kept; workspaces keep no replica, so the first replica to start runs them.
   * Returns how many rows each table got.
   */
  async copyFrom(source: Directory): Promise<Record<string, number>> {
    const tables = ['users', 'workspaces', 'members', 'sessions', 'github_tokens', 'workspace_secrets', 'invites', 'runners'];
    const counts: Record<string, number> = {};
    await this.sql.tx(async (q) => {
      for (const t of tables) {
        const rows = await source.sql.all(`SELECT * FROM ${t}`);
        counts[t] = 0;
        for (const r of rows) {
          const row: Row = { ...r };
          if (t === 'workspaces') row.replica = null;
          if (t === 'runners') Object.assign(row, { connected_replica: null, connected_at: null });
          const cols = Object.keys(row);
          counts[t] += await q.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`, ...cols.map((c) => row[c]));
        }
      }
    });
    return counts;
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

  private toUser(r: Row): User {
    return { id: String(r.id), githubId: Number(r.github_id), login: String(r.login), name: String(r.name), ...(r.email ? { email: String(r.email) } : {}), ...(r.avatar_url ? { avatarUrl: String(r.avatar_url) } : {}), createdAt: String(r.created_at) };
  }

  /** Creates or updates the person behind a GitHub account. */
  async upsertGitHubUser(gh: { id: number; login: string; name?: string | null; email?: string | null; avatarUrl?: string | null }): Promise<User> {
    const name = gh.name?.trim() || gh.login;
    const existing = await this.sql.get('SELECT id FROM users WHERE github_id = ?', gh.id);
    if (existing) {
      await this.sql.run('UPDATE users SET login = ?, name = ?, email = ?, avatar_url = ? WHERE id = ?', gh.login, name, gh.email ?? null, gh.avatarUrl ?? null, String(existing.id));
      return (await this.user(String(existing.id)))!;
    }
    await this.sql.run('INSERT INTO users (id, github_id, login, name, email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (github_id) DO NOTHING', randomUUID(), gh.id, gh.login, name, gh.email ?? null, gh.avatarUrl ?? null, new Date(this.now()).toISOString());
    // Two sign-ins at once (two replicas): whichever row was written first is the person.
    const row = await this.sql.get('SELECT * FROM users WHERE github_id = ?', gh.id);
    return this.toUser(row!);
  }

  async userByGitHubId(githubId: number): Promise<User | undefined> {
    const r = await this.sql.get('SELECT * FROM users WHERE github_id = ?', githubId);
    return r ? this.toUser(r) : undefined;
  }

  async user(id: string): Promise<User | undefined> {
    const r = await this.sql.get('SELECT * FROM users WHERE id = ?', id);
    return r ? this.toUser(r) : undefined;
  }

  /** Deletes a person: sessions, tokens and memberships go with them (GDPR erasure). Returns the workspaces left without an owner. */
  async deleteUser(id: string): Promise<string[]> {
    return this.sql.tx(async (q) => {
      const owned = (await q.all<{ workspace_id: string }>("SELECT workspace_id FROM members WHERE user_id = ? AND role = 'owner'", id)).map((r) => r.workspace_id);
      await q.run('DELETE FROM users WHERE id = ?', id);
      const orphans: string[] = [];
      for (const w of owned) if (!(await q.get("SELECT 1 AS x FROM members WHERE workspace_id = ? AND role = 'owner'", w))) orphans.push(w);
      return orphans;
    });
  }

  /* ---------------------------------------------------------------- GitHub tokens */

  async saveGitHubTokens(userId: string, t: GitHubTokens, q: Sql = this.sql): Promise<void> {
    await q.run('INSERT INTO github_tokens (user_id, sealed, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at', userId, this.seal(JSON.stringify(t)), new Date(this.now()).toISOString());
  }
  async gitHubTokens(userId: string, q: Sql = this.sql, lock = false): Promise<GitHubTokens | undefined> {
    const r = await q.get<{ sealed: string }>(`SELECT sealed FROM github_tokens WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`, userId);
    return r ? (JSON.parse(this.unseal(r.sealed)) as GitHubTokens) : undefined;
  }
  /**
   * Renews a person's GitHub tokens once, even when several replicas need them at the same time
   * (GitHub replaces the refresh token on every use, so two renewals would sign the person out).
   * `renew` gets the stored tokens as they are inside the lock and returns new ones, or undefined.
   */
  async renewGitHubTokens(userId: string, renew: (current: GitHubTokens | undefined) => Promise<GitHubTokens | undefined>): Promise<GitHubTokens | undefined> {
    const prev = this.renewing.get(userId) ?? Promise.resolve();
    const next = prev.then(
      () =>
        this.sql.tx(async (q) => {
          const current = await this.gitHubTokens(userId, q, true);
          const fresh = await renew(current);
          if (fresh) await this.saveGitHubTokens(userId, fresh, q);
          return fresh ?? current;
        }),
      () => undefined,
    );
    this.renewing.set(userId, next);
    void next.finally(() => {
      if (this.renewing.get(userId) === next) this.renewing.delete(userId);
    });
    return next;
  }

  /* ---------------------------------------------------------------- sessions */

  /** A new session; returns the cookie value (only its hash is stored). */
  async createSession(userId: string, workspaceId?: string): Promise<{ id: string; session: Session }> {
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + SESSION_DAYS * 86_400_000;
    await this.sql.run('INSERT INTO sessions (id_hash, user_id, csrf, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', hash(id), userId, csrf, workspaceId ?? null, this.now(), expiresAt);
    return { id, session: { userId, csrf, ...(workspaceId ? { workspaceId } : {}), expiresAt } };
  }
  async session(id: string | undefined): Promise<Session | undefined> {
    if (!id) return undefined;
    const r = await this.sql.get('SELECT * FROM sessions WHERE id_hash = ?', hash(id));
    if (!r) return undefined;
    if (Number(r.expires_at) < this.now()) {
      await this.sql.run('DELETE FROM sessions WHERE id_hash = ?', hash(id));
      return undefined;
    }
    return { userId: String(r.user_id), csrf: String(r.csrf), ...(r.workspace_id ? { workspaceId: String(r.workspace_id) } : {}), expiresAt: Number(r.expires_at) };
  }
  async useWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    await this.sql.run('UPDATE sessions SET workspace_id = ? WHERE id_hash = ?', workspaceId, hash(sessionId));
  }
  async endSession(id: string): Promise<void> {
    await this.sql.run('DELETE FROM sessions WHERE id_hash = ?', hash(id));
  }
  static csrfMatches(session: Session, given: string | undefined): boolean {
    if (!given || given.length !== session.csrf.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(session.csrf));
  }

  /* ---------------------------------------------------------------- workspaces */

  private toWorkspace(r: Row): Workspace {
    return { id: String(r.id), name: String(r.name), createdAt: String(r.created_at), createdBy: String(r.created_by) };
  }
  /** A new workspace with its first owner, run by `replica` (on one server, always the same). */
  async createWorkspace(name: string, ownerId: string, replica?: string): Promise<Workspace> {
    const w: Workspace = { id: randomUUID(), name: name.trim().slice(0, 80) || 'My workspace', createdAt: new Date(this.now()).toISOString(), createdBy: ownerId };
    await this.sql.tx(async (q) => {
      await q.run('INSERT INTO workspaces (id, name, created_at, created_by, replica) VALUES (?, ?, ?, ?, ?)', w.id, w.name, w.createdAt, w.createdBy, replica ?? null);
      await q.run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", w.id, ownerId, w.createdAt);
    });
    return w;
  }
  async workspace(id: string): Promise<Workspace | undefined> {
    const r = await this.sql.get('SELECT * FROM workspaces WHERE id = ?', id);
    return r ? this.toWorkspace(r) : undefined;
  }
  async workspacesOf(userId: string): Promise<Membership[]> {
    return (await this.sql.all('SELECT w.*, m.role FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at', userId)).map((r) => ({ ...this.toWorkspace(r), role: r.role as Role }));
  }
  /** The person's role in a workspace, or undefined when they are not a member. */
  async roleIn(workspaceId: string, userId: string): Promise<Role | undefined> {
    return (await this.sql.get<{ role: Role }>('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId))?.role;
  }
  async addMember(workspaceId: string, userId: string, role: Role = 'member'): Promise<void> {
    await this.sql.run('INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, user_id) DO NOTHING', workspaceId, userId, role, new Date(this.now()).toISOString());
  }
  async allWorkspaces(): Promise<Workspace[]> {
    return (await this.sql.all('SELECT * FROM workspaces ORDER BY created_at')).map((r) => this.toWorkspace(r));
  }
  async renameWorkspace(id: string, name: string): Promise<void> {
    await this.sql.run('UPDATE workspaces SET name = ? WHERE id = ?', name.trim().slice(0, 80), id);
  }
  async deleteWorkspace(id: string): Promise<void> {
    await this.sql.run('DELETE FROM workspaces WHERE id = ?', id);
  }

  /* ---------------------------------------------------------------- workspace secrets and Copilot */

  async secretOf(workspaceId: string, name: string): Promise<string | undefined> {
    const r = await this.sql.get<{ sealed: string }>('SELECT sealed FROM workspace_secrets WHERE workspace_id = ? AND name = ?', workspaceId, name);
    return r ? this.unseal(r.sealed) : undefined;
  }
  async setSecret(workspaceId: string, name: string, value: string): Promise<void> {
    await this.sql.run('INSERT INTO workspace_secrets (workspace_id, name, sealed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at', workspaceId, name, this.seal(value), new Date(this.now()).toISOString());
  }
  async deleteSecret(workspaceId: string, name: string): Promise<void> {
    await this.sql.run('DELETE FROM workspace_secrets WHERE workspace_id = ? AND name = ?', workspaceId, name);
  }

  /** Whose Copilot plan (and GitHub access) the workspace uses: chosen by a member, else its creator. */
  async copilotUser(workspaceId: string): Promise<string | undefined> {
    const r = await this.sql.get<{ copilot_user_id: string | null; created_by: string }>('SELECT copilot_user_id, created_by FROM workspaces WHERE id = ?', workspaceId);
    if (!r) return undefined;
    const pick = r.copilot_user_id ?? r.created_by;
    if (await this.roleIn(workspaceId, pick)) return pick;
    return (await this.sql.get<{ user_id: string }>("SELECT user_id FROM members WHERE workspace_id = ? ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1", workspaceId))?.user_id;
  }
  async setCopilotUser(workspaceId: string, userId: string): Promise<void> {
    await this.sql.run('UPDATE workspaces SET copilot_user_id = ? WHERE id = ?', userId, workspaceId);
  }

  /* ---------------------------------------------------------------- members and invitations */

  async members(workspaceId: string): Promise<Array<User & { role: Role }>> {
    return (await this.sql.all('SELECT u.*, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at', workspaceId)).map((r) => ({ ...this.toUser(r), role: r.role as Role }));
  }
  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.sql.run('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  }
  async setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    await this.sql.run('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', role, workspaceId, userId);
  }
  async owners(workspaceId: string): Promise<number> {
    return Number((await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'", workspaceId))?.n ?? 0);
  }
  /** An invitation link's secret (only its hash is stored), valid 7 days. */
  async createInvite(workspaceId: string, createdBy: string, role: Role = 'member'): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.sql.run('INSERT INTO invites (token_hash, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', hash(token), workspaceId, role, createdBy, this.now(), this.now() + 7 * 86_400_000);
    return token;
  }
  /** The workspace an invitation link leads to, while it is valid (without joining it). */
  async inviteTarget(token: string): Promise<string | undefined> {
    return (await this.inviteInfo(token))?.workspaceId;
  }
  /** A valid invitation's workspace and who made it. */
  async inviteInfo(token: string): Promise<{ workspaceId: string; createdBy: string } | undefined> {
    const r = await this.sql.get('SELECT workspace_id, created_by, expires_at FROM invites WHERE token_hash = ?', hash(token));
    return r && Number(r.expires_at) >= this.now() ? { workspaceId: String(r.workspace_id), createdBy: String(r.created_by) } : undefined;
  }
  /** Invitations made for a workspace since `since` (a time in ms). */
  async invitesSince(workspaceId: string, since: number): Promise<number> {
    return Number((await this.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM invites WHERE workspace_id = ? AND created_at >= ?', workspaceId, since))?.n ?? 0);
  }
  async memberCount(workspaceId: string): Promise<number> {
    return Number((await this.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE workspace_id = ?', workspaceId))?.n ?? 0);
  }
  /** Workspaces the person owns. */
  async ownedBy(userId: string): Promise<number> {
    return Number((await this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND role = 'owner'", userId))?.n ?? 0);
  }
  /** Deletes expired sessions and invitations (kept no longer than they work). */
  async purgeExpired(): Promise<{ sessions: number; invites: number }> {
    const now = this.now();
    return { sessions: await this.sql.run('DELETE FROM sessions WHERE expires_at < ?', now), invites: await this.sql.run('DELETE FROM invites WHERE expires_at < ?', now) };
  }
  /** The database answers (readiness). */
  async ping(): Promise<void> {
    await this.sql.get('SELECT 1 AS ok');
  }

  /** Joins the workspace of an invitation; returns it, or undefined when the link is unknown or expired. */
  async acceptInvite(token: string, userId: string): Promise<Workspace | undefined> {
    const r = await this.sql.get('SELECT * FROM invites WHERE token_hash = ?', hash(token));
    if (!r || Number(r.expires_at) < this.now()) return undefined;
    await this.addMember(String(r.workspace_id), userId, r.role as Role);
    return this.workspace(String(r.workspace_id));
  }

  /* ---------------------------------------------------------------- company runners */

  async runnerMode(workspaceId: string): Promise<RunnerMode> {
    const r = await this.sql.get<{ runner: string }>('SELECT runner FROM workspaces WHERE id = ?', workspaceId);
    return r?.runner === 'company' ? 'company' : 'cloud';
  }
  /** Works on a company computer from now on: a new runner key (shown once; only its hash is kept). */
  async useCompanyRunner(workspaceId: string, createdBy: string): Promise<string> {
    const token = `tdr_${randomBytes(32).toString('base64url')}`;
    await this.sql.tx(async (q) => {
      await q.run("UPDATE workspaces SET runner = 'company' WHERE id = ?", workspaceId);
      await q.run('DELETE FROM runners WHERE workspace_id = ?', workspaceId);
      await q.run('INSERT INTO runners (workspace_id, token_hash, created_by, created_at) VALUES (?, ?, ?, ?)', workspaceId, hash(token), createdBy, this.now());
    });
    return token;
  }
  /** Back to Tandem's cloud; the runner's key stops working. */
  async useCloudRunner(workspaceId: string): Promise<void> {
    await this.sql.tx(async (q) => {
      await q.run("UPDATE workspaces SET runner = 'cloud' WHERE id = ?", workspaceId);
      await q.run('DELETE FROM runners WHERE workspace_id = ?', workspaceId);
    });
  }
  /** The workspace a runner key belongs to, while that workspace works on a company computer. */
  async runnerByToken(token: string | undefined): Promise<RunnerKey | undefined> {
    if (!token || !token.startsWith('tdr_')) return undefined;
    const r = await this.sql.get("SELECT r.* FROM runners r JOIN workspaces w ON w.id = r.workspace_id WHERE r.token_hash = ? AND w.runner = 'company'", hash(token));
    return r ? this.toRunner(r) : undefined;
  }
  async runnerOf(workspaceId: string): Promise<RunnerKey | undefined> {
    const r = await this.sql.get('SELECT * FROM runners WHERE workspace_id = ?', workspaceId);
    return r ? this.toRunner(r) : undefined;
  }
  async runnerSeen(workspaceId: string, machine: string): Promise<void> {
    await this.sql.run('UPDATE runners SET last_seen_at = ?, machine = ? WHERE workspace_id = ?', this.now(), machine.slice(0, 120), workspaceId);
  }
  /** The runner connected to `replica`; or, with `replica` undefined, it disconnected from `from`. */
  async runnerConnected(workspaceId: string, replica: string | undefined, from?: string): Promise<void> {
    if (replica) await this.sql.run('UPDATE runners SET connected_replica = ?, connected_at = ? WHERE workspace_id = ?', replica, this.now(), workspaceId);
    else await this.sql.run('UPDATE runners SET connected_replica = NULL, connected_at = NULL WHERE workspace_id = ? AND connected_replica = ?', workspaceId, from ?? '');
  }
  private toRunner(r: Row): RunnerKey {
    return {
      workspaceId: String(r.workspace_id),
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
      ...(r.last_seen_at ? { lastSeenAt: Number(r.last_seen_at) } : {}),
      ...(r.machine ? { machine: String(r.machine) } : {}),
      ...(r.connected_replica ? { connectedReplica: String(r.connected_replica), connectedAt: Number(r.connected_at) } : {}),
    };
  }

  /* ---------------------------------------------------------------- replicas */

  /** This replica is alive and reachable at `url` (inside the cluster). */
  async replicaSeen(id: string, url: string): Promise<void> {
    await this.sql.run('INSERT INTO replicas (id, url, seen_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET url = excluded.url, seen_at = excluded.seen_at', id, url, this.now());
  }
  /** Replicas seen within the last `withinMs`. */
  async liveReplicas(withinMs = 45_000): Promise<Replica[]> {
    return (await this.sql.all('SELECT * FROM replicas WHERE seen_at >= ? ORDER BY id', this.now() - withinMs)).map((r) => ({ id: String(r.id), url: String(r.url), seenAt: Number(r.seen_at) }));
  }
  async replica(id: string): Promise<Replica | undefined> {
    const r = await this.sql.get('SELECT * FROM replicas WHERE id = ?', id);
    return r ? { id: String(r.id), url: String(r.url), seenAt: Number(r.seen_at) } : undefined;
  }
  /** The replica that runs a workspace. */
  async workspaceReplica(id: string): Promise<string | undefined> {
    return (await this.sql.get<{ replica: string | null }>('SELECT replica FROM workspaces WHERE id = ?', id))?.replica ?? undefined;
  }
  /** Workspaces no replica runs yet (made before there were several) become `replica`'s. */
  async claimUnassigned(replica: string): Promise<number> {
    return this.sql.run('UPDATE workspaces SET replica = ? WHERE replica IS NULL', replica);
  }
  async workspacesOn(replica: string): Promise<string[]> {
    return (await this.sql.all<{ id: string }>('SELECT id FROM workspaces WHERE replica = ? ORDER BY created_at', replica)).map((r) => r.id);
  }
  /** The live replica running the fewest workspaces: where a new one goes. */
  async quietestReplica(fallback: string): Promise<string> {
    const live = await this.liveReplicas();
    if (live.length <= 1) return live[0]?.id ?? fallback;
    const counts = new Map((await this.sql.all<{ replica: string; n: number }>('SELECT replica, COUNT(*) AS n FROM workspaces WHERE replica IS NOT NULL GROUP BY replica')).map((r) => [r.replica, Number(r.n)]));
    return live.map((r) => r.id).sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || a.localeCompare(b))[0] ?? fallback;
  }
}
