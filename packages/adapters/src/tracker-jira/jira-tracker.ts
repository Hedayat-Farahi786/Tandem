import { RetryableError, type Tracker, type TrackerComment, type TrackerTask } from '@tandem/core';
import { checkOutbound } from '../net/outbound.js';
import { redactor } from '@tandem/core';
import { adfToText, markdownToAdf } from './adf.js';

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface JiraConfig {
  baseUrl: string;
  /** Jira Cloud: the account email (Basic auth with an API token). Empty = Data Center (Bearer PAT). */
  email: string;
  token: string;
  fetch?: Fetch;
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
  private readonly cloud: boolean;
  private readonly api: string;

  constructor(private readonly c: JiraConfig) {
    this.base = c.baseUrl.replace(/\/+$/, '');
    this.cloud = Boolean(c.email.trim());
    this.api = this.cloud ? '/rest/api/3' : '/rest/api/2';
    redactor.register(c.token);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = this.cloud ? `Basic ${Buffer.from(`${this.c.email}:${this.c.token}`).toString('base64')}` : `Bearer ${this.c.token}`;
    const f = this.c.fetch ?? (globalThis.fetch as unknown as Fetch);
    let res: Awaited<ReturnType<Fetch>>;
    try {
      await checkOutbound(this.base);
    } catch (err) {
      throw new JiraError(`The Jira address can't be used: ${(err as Error).message}`, 400);
    }
    try {
      res = await f(`${this.base}${path}`, {
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
    if (res.status === 401) throw new JiraError('Jira rejected the token. Check the email and API token in Settings (Jira Cloud tokens are created at id.atlassian.com).', 401);
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
