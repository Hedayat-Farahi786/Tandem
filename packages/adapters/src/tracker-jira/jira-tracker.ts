import { RetryableError, type Tracker, type TrackerComment, type TrackerTask } from '@tandem/core';
import { checkOutbound } from '../net/outbound.js';
import { redactor } from '@tandem/core';
import { adfToText, markdownToAdf } from './adf.js';

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface JiraConfig {
  /** The Jira site (for links; with a token, the API too). */
  baseUrl: string;
  /** Jira Cloud: the account email (Basic auth with an API token). Empty = Data Center (Bearer PAT). */
  email?: string;
  token?: string;
  /** Atlassian's sign-in: calls go through api.atlassian.com to this site, with a token that renews. */
  oauth?: { cloudId: string; accessToken(renew?: boolean): Promise<string> };
  fetch?: Fetch;
}

export interface JiraProject {
  key: string;
  name: string;
}
export interface JiraPerson {
  id: string;
  name: string;
}

export class JiraError extends Error {
  override readonly name = 'JiraError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface JiraUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName?: string;
}
interface JiraComment {
  id: string;
  author?: JiraUser;
  body: unknown;
  created: string;
}

/**
 * Jira Cloud (REST v3, ADF bodies, POST /search/jql) or Data Center (REST v2, wiki/plain bodies,
 * POST /search). Only the token is secret; it comes from the OS keychain.
 */
export class JiraTracker implements Tracker {
  readonly kind = 'jira' as const;
  private readonly base: string;
  /** Where the REST API answers: the site itself, or Atlassian's gateway for a signed-in site. */
  private readonly root: string;
  readonly cloud: boolean;
  private readonly api: string;

  constructor(private readonly c: JiraConfig) {
    this.base = c.baseUrl.replace(/\/+$/, '');
    this.root = c.oauth ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(c.oauth.cloudId)}` : this.base;
    this.cloud = Boolean(c.oauth) || Boolean(c.email?.trim());
    this.api = this.cloud ? '/rest/api/3' : '/rest/api/2';
    if (c.token) redactor.register(c.token);
  }

  private async authorization(renew = false): Promise<string> {
    if (this.c.oauth) {
      const t = await this.c.oauth.accessToken(renew);
      redactor.register(t);
      return `Bearer ${t}`;
    }
    return this.c.email?.trim() ? `Basic ${Buffer.from(`${this.c.email}:${this.c.token ?? ''}`).toString('base64')}` : `Bearer ${this.c.token ?? ''}`;
  }

  private async req<T>(method: string, path: string, body?: unknown, renewed = false): Promise<T> {
    const auth = await this.authorization(renewed);
    const f = this.c.fetch ?? (globalThis.fetch as unknown as Fetch);
    let res: Awaited<ReturnType<Fetch>>;
    try {
      // A pasted address may lead anywhere; Atlassian's gateway is fixed.
      if (!this.c.oauth) await checkOutbound(this.root);
    } catch (err) {
      throw new JiraError(`The Jira address can't be used: ${(err as Error).message}`, 400);
    }
    try {
      res = await f(`${this.root}${path}`, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new RetryableError(`Could not reach Jira at ${this.base}: ${String((err as Error).message ?? err)}`);
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Jira returned ${res.status}; trying again later.`);
    // A signed-in site: the token may have just been revoked or expired early; renew it once.
    if (res.status === 401 && this.c.oauth && !renewed) return this.req<T>(method, path, body, true);
    if (res.status === 401) throw new JiraError(this.c.oauth ? 'Jira no longer accepts Tandem\'s sign-in. Connect Jira again in Settings.' : 'Jira rejected the token. Connect Jira again in Settings with a new token.', 401);
    if (res.status === 403) throw new JiraError(`Jira says this account may not ${method === 'GET' ? 'read' : 'change'} that (${path}).`, 403);
    if (res.status === 404) throw new JiraError(`Jira could not find ${path}. Check the issue key and project.`, 404);
    if (!res.ok) throw new JiraError(`Jira ${method} ${path} failed with ${res.status}: ${redactor.redact(text).slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  link(key: string): string {
    return `${this.base}/browse/${encodeURIComponent(key)}`;
  }

  async myself(): Promise<{ id: string; name: string }> {
    const me = await this.req<JiraUser>('GET', `${this.api}/myself`);
    return { id: me.accountId ?? me.key ?? me.name ?? '', name: me.displayName ?? me.name ?? '' };
  }

  private toTask(i: { key: string; fields: { summary?: string; description?: unknown; status?: { name?: string } } }): TrackerTask {
    const d = i.fields.description;
    return { key: i.key, title: i.fields.summary ?? i.key, description: typeof d === 'string' ? d : adfToText(d), status: i.fields.status?.name ?? '', url: this.link(i.key) };
  }

  /** The projects this account can see, by name. */
  async projects(): Promise<JiraProject[]> {
    if (!this.cloud) return (await this.req<Array<{ key: string; name: string }>>('GET', `${this.api}/project`)).map((p) => ({ key: p.key, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
    const out: JiraProject[] = [];
    for (let startAt = 0, page = 0; page < 10; page++) {
      const r = await this.req<{ values: Array<{ key: string; name: string }>; isLast?: boolean; total?: number }>('GET', `${this.api}/project/search?orderBy=name&maxResults=50&startAt=${startAt}`);
      out.push(...r.values.map((p) => ({ key: p.key, name: p.name })));
      startAt += r.values.length;
      if (r.isLast || !r.values.length || (r.total !== undefined && startAt >= r.total)) break;
    }
    return out;
  }

  /** Status names, of one project or of the whole site: to do first, done last. */
  async statuses(projectKey?: string): Promise<string[]> {
    type S = { name: string; statusCategory?: { key?: string } };
    const all: S[] = projectKey
      ? (await this.req<Array<{ statuses: S[] }>>('GET', `${this.api}/project/${encodeURIComponent(projectKey)}/statuses`)).flatMap((t) => t.statuses)
      : await this.req<S[]>('GET', `${this.api}/status`);
    const order: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
    const byName = new Map<string, number>();
    for (const x of all) if (!byName.has(x.name)) byName.set(x.name, order[x.statusCategory?.key ?? ''] ?? 1);
    return [...byName].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([n]) => n);
  }

  /** People whose name (or email) matches, for choosing who approves in Jira. */
  async people(query: string): Promise<JiraPerson[]> {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    type U = JiraUser & { accountType?: string; active?: boolean };
    const found = await this.req<U[]>('GET', this.cloud ? `${this.api}/user/search?query=${q}&maxResults=20` : `${this.api}/user/search?username=${q}&maxResults=20`);
    return found
      .filter((u) => (u.accountType === undefined || u.accountType === 'atlassian') && u.active !== false)
      .map((u) => ({ id: u.accountId ?? u.key ?? u.name ?? '', name: u.displayName ?? u.name ?? '' }))
      .filter((u) => u.id);
  }

  async getTask(key: string): Promise<TrackerTask | undefined> {
    try {
      return this.toTask(await this.req('GET', `${this.api}/issue/${encodeURIComponent(key)}?fields=summary,description,status`));
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined;
      throw err;
    }
  }

  async findReadyTasks(jql = 'status = "Ready for AI"'): Promise<TrackerTask[]> {
    const out: TrackerTask[] = [];
    const fields = ['summary', 'description', 'status'];
    if (this.cloud) {
      let next: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = await this.req<{ issues: Array<Parameters<JiraTracker['toTask']>[0]>; nextPageToken?: string; isLast?: boolean }>('POST', `${this.api}/search/jql`, { jql, fields, maxResults: 50, ...(next ? { nextPageToken: next } : {}) });
        out.push(...r.issues.map((i) => this.toTask(i)));
        if (!r.nextPageToken || r.isLast) break;
        next = r.nextPageToken;
      }
    } else {
      let startAt = 0;
      for (let page = 0; page < 10; page++) {
        const r = await this.req<{ issues: Array<Parameters<JiraTracker['toTask']>[0]>; total: number }>('POST', `${this.api}/search`, { jql, fields, maxResults: 50, startAt });
        out.push(...r.issues.map((i) => this.toTask(i)));
        startAt += r.issues.length;
        if (!r.issues.length || startAt >= r.total) break;
      }
    }
    return out;
  }

  async comment(key: string, markdown: string): Promise<{ id: string; createdAt: string }> {
    const safe = redactor.redact(markdown);
    const body = this.cloud ? { body: markdownToAdf(safe) } : { body: safe };
    const r = await this.req<{ id: string; created: string }>('POST', `${this.api}/issue/${encodeURIComponent(key)}/comment`, body);
    return { id: r.id, createdAt: new Date(r.created).toISOString() };
  }

  async transition(key: string, statusName: string): Promise<'moved' | 'not-available'> {
    const r = await this.req<{ transitions: Array<{ id: string; name: string; to?: { name?: string } }> }>('GET', `${this.api}/issue/${encodeURIComponent(key)}/transitions`);
    const want = statusName.trim().toLowerCase();
    const t = r.transitions.find((x) => x.to?.name?.toLowerCase() === want) ?? r.transitions.find((x) => x.name.toLowerCase() === want);
    if (!t) return 'not-available';
    await this.req('POST', `${this.api}/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return 'moved';
  }

  async readReplies(key: string, since: string, authorIds?: readonly string[]): Promise<TrackerComment[]> {
    const out: TrackerComment[] = [];
    let startAt = 0;
    for (let page = 0; page < 20; page++) {
      const r = await this.req<{ comments: JiraComment[]; total: number }>('GET', `${this.api}/issue/${encodeURIComponent(key)}/comment?orderBy=created&startAt=${startAt}&maxResults=100`);
      for (const c of r.comments) {
        const created = new Date(c.created).toISOString();
        const authorId = c.author?.accountId ?? c.author?.key ?? c.author?.name ?? '';
        if (created <= since) continue;
        if (authorIds && !authorIds.includes(authorId)) continue;
        out.push({ id: c.id, key, authorId, authorName: c.author?.displayName ?? authorId, body: typeof c.body === 'string' ? c.body : adfToText(c.body), createdAt: created });
      }
      startAt += r.comments.length;
      if (!r.comments.length || startAt >= r.total) break;
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
