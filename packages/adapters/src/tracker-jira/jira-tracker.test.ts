import { describe, expect, it } from 'vitest';
import { RetryableError } from '@tandem/core';
import { JiraError, JiraTracker, type Fetch } from './jira-tracker.js';
import { adfToText, markdownToAdf } from './adf.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A tiny fake Jira: routes by "METHOD path" (query string ignored unless the route includes it). */
function fakeJira(routes: Record<string, (call: Call) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, ...(init?.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(call);
    const u = new URL(url);
    const exact = `${call.method} ${u.pathname}${u.search}`;
    const route = routes[exact] ?? routes[`${call.method} ${u.pathname}`];
    if (!route) return { ok: false, status: 404, text: async () => `no route for ${exact}` };
    const r = await route(call);
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fetch, calls };
}

const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const cloud = (routes: Parameters<typeof fakeJira>[0]) => {
  const f = fakeJira(routes);
  return { jira: new JiraTracker({ baseUrl: 'https://acme.atlassian.net/', email: 'me@acme.test', token: 'jira-secret-token-123', fetch: f.fetch }), calls: f.calls };
};
const dc = (routes: Parameters<typeof fakeJira>[0]) => {
  const f = fakeJira(routes);
  return { jira: new JiraTracker({ baseUrl: 'https://jira.acme.test', email: '', token: 'pat-secret-456789', fetch: f.fetch }), calls: f.calls };
};

describe('JiraTracker (Cloud)', () => {
  it('authenticates with email + API token and reads the user', async () => {
    const { jira, calls } = cloud({ 'GET /rest/api/3/myself': () => ({ body: { accountId: 'acc-1', displayName: 'Me' } }) });
    expect(await jira.myself()).toEqual({ id: 'acc-1', name: 'Me' });
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.test:jira-secret-token-123').toString('base64')}`);
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    expect(jira.link('SHOP-1')).toBe('https://acme.atlassian.net/browse/SHOP-1');
  });

  it('gets an issue with an ADF description, and undefined for a missing one', async () => {
    const { jira } = cloud({
      'GET /rest/api/3/issue/SHOP-1': () => ({ body: { key: 'SHOP-1', fields: { summary: 'Health endpoint', status: { name: 'Ready for AI' }, description: adf('Add GET /health.') } } }),
      'GET /rest/api/3/issue/SHOP-404': () => ({ status: 404, body: { errorMessages: ['nope'] } }),
    });
    expect(await jira.getTask('SHOP-1')).toEqual({ key: 'SHOP-1', title: 'Health endpoint', description: 'Add GET /health.', status: 'Ready for AI', url: 'https://acme.atlassian.net/browse/SHOP-1' });
    expect(await jira.getTask('SHOP-404')).toBeUndefined();
  });

  it('searches with POST /search/jql and follows nextPageToken', async () => {
    let page = 0;
    const { jira, calls } = cloud({
      'POST /rest/api/3/search/jql': () => {
        page++;
        return page === 1
          ? { body: { issues: [{ key: 'A-1', fields: { summary: 'one', description: null, status: { name: 'Ready for AI' } } }], nextPageToken: 'tok2' } }
          : { body: { issues: [{ key: 'A-2', fields: { summary: 'two', description: adf('d'), status: { name: 'Ready for AI' } } }], isLast: true } };
      },
    });
    const found = await jira.findReadyTasks('project = A AND status = "Ready for AI"');
    expect(found.map((t) => [t.key, t.title, t.description])).toEqual([
      ['A-1', 'one', ''],
      ['A-2', 'two', 'd'],
    ]);
    expect(calls[0]!.body).toEqual({ jql: 'project = A AND status = "Ready for AI"', fields: ['summary', 'description', 'status'], maxResults: 50 });
    expect(calls[1]!.body).toMatchObject({ nextPageToken: 'tok2' });
  });

  it('posts comments as ADF, redacting secrets first', async () => {
    const { jira, calls } = cloud({ 'POST /rest/api/3/issue/A-1/comment': () => ({ status: 201, body: { id: '10', created: '2026-11-03T10:00:00.000+0000' } }) });
    const r = await jira.comment('A-1', '## Spec\n\n- item with `code`\n\ntoken=abc123secret');
    expect(r).toEqual({ id: '10', createdAt: '2026-11-03T10:00:00.000Z' });
    const body = calls[0]!.body as { body: { type: string; content: Array<{ type: string }> } };
    expect(body.body.type).toBe('doc');
    expect(body.body.content.map((n) => n.type)).toEqual(['heading', 'bulletList', 'paragraph']);
    expect(JSON.stringify(body)).not.toContain('abc123secret');
  });

  it('moves an issue by target status or transition name, or reports not available', async () => {
    const transitions = { transitions: [{ id: '21', name: 'Start review', to: { name: 'In Review' } }, { id: '31', name: 'Done', to: { name: 'Done' } }] };
    const { jira, calls } = cloud({
      'GET /rest/api/3/issue/A-1/transitions': () => ({ body: transitions }),
      'POST /rest/api/3/issue/A-1/transitions': () => ({ status: 204 }),
    });
    expect(await jira.transition('A-1', 'in review')).toBe('moved');
    expect(calls[1]!.body).toEqual({ transition: { id: '21' } });
    expect(await jira.transition('A-1', 'Done')).toBe('moved');
    expect(await jira.transition('A-1', 'Blocked')).toBe('not-available');
  });

  it('reads replies after a time from the configured PMs only, across pages', async () => {
    const c = (id: string, accountId: string, created: string, text: string): unknown => ({ id, author: { accountId, displayName: accountId.toUpperCase() }, created, body: adf(text) });
    const { jira } = cloud({
      'GET /rest/api/3/issue/A-1/comment?orderBy=created&startAt=0&maxResults=100': () => ({ body: { total: 3, comments: [c('1', 'pm-1', '2026-11-03T09:00:00.000+0000', 'old approve'), c('2', 'dev', '2026-11-03T11:00:00.000+0000', 'approve')] } }),
      'GET /rest/api/3/issue/A-1/comment?orderBy=created&startAt=2&maxResults=100': () => ({ body: { total: 3, comments: [c('3', 'pm-1', '2026-11-03T12:00:00.000+0000', 'changes: add the version')] } }),
    });
    const replies = await jira.readReplies('A-1', '2026-11-03T10:00:00.000Z', ['pm-1']);
    expect(replies).toEqual([{ id: '3', key: 'A-1', authorId: 'pm-1', authorName: 'PM-1', body: 'changes: add the version', createdAt: '2026-11-03T12:00:00.000Z' }]);
    expect((await jira.readReplies('A-1', '2026-11-03T10:00:00.000Z')).map((r) => r.id)).toEqual(['2', '3']);
  });

  it('explains auth and permission errors and retries on 429/5xx/network', async () => {
    const { jira } = cloud({
      'GET /rest/api/3/myself': () => ({ status: 401, body: { message: 'Unauthorized jira-secret-token-123' } }),
      'GET /rest/api/3/issue/A-1/transitions': () => ({ status: 403 }),
      'POST /rest/api/3/search/jql': () => ({ status: 429 }),
      'POST /rest/api/3/issue/A-1/comment': () => ({ status: 503 }),
      'GET /rest/api/3/issue/A-2': () => ({ status: 400, body: { errorMessages: ['bad request jira-secret-token-123'] } }),
    });
    await expect(jira.myself()).rejects.toThrow(/Jira rejected the token/);
    await expect(jira.transition('A-1', 'x')).rejects.toThrow(/may not read/);
    await expect(jira.findReadyTasks()).rejects.toBeInstanceOf(RetryableError);
    await expect(jira.comment('A-1', 'x')).rejects.toBeInstanceOf(RetryableError);
    const err = await jira.getTask('A-2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(String((err as Error).message)).not.toContain('jira-secret-token-123');
    const offline = new JiraTracker({ baseUrl: 'https://x', email: 'e', token: 'tokentoken', fetch: async () => Promise.reject(new Error('ENOTFOUND')) });
    await expect(offline.myself()).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('JiraTracker (Data Center)', () => {
  it('uses a Bearer PAT, REST v2, plain comment bodies and startAt paging', async () => {
    let page = 0;
    const { jira, calls } = dc({
      'GET /rest/api/2/myself': () => ({ body: { name: 'jdoe', key: 'JIRAUSER1', displayName: 'J Doe' } }),
      'POST /rest/api/2/search': () => {
        page++;
        return { body: { total: 3, issues: page === 1 ? [{ key: 'B-1', fields: { summary: 's1', description: 'plain d', status: { name: 'Ready for AI' } } }, { key: 'B-2', fields: { summary: 's2' } }] : [{ key: 'B-3', fields: { summary: 's3' } }] } };
      },
      'POST /rest/api/2/issue/B-1/comment': () => ({ body: { id: '5', created: '2026-11-03T10:00:00.000+0000' } }),
      'GET /rest/api/2/issue/B-1/comment?orderBy=created&startAt=0&maxResults=100': () => ({ body: { total: 1, comments: [{ id: '6', author: { key: 'JIRAUSER9', name: 'pm', displayName: 'P M' }, created: '2026-11-03T11:00:00.000+0000', body: 'approve' }] } }),
    });
    expect(await jira.myself()).toEqual({ id: 'JIRAUSER1', name: 'J Doe' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer pat-secret-456789');
    const found = await jira.findReadyTasks();
    expect(found.map((t) => t.key)).toEqual(['B-1', 'B-2', 'B-3']);
    expect(found[0]!.description).toBe('plain d');
    expect((calls[2]!.body as { startAt: number }).startAt).toBe(2);
    await jira.comment('B-1', '**bold** text');
    expect(calls[3]!.body).toEqual({ body: '**bold** text' });
    expect(await jira.readReplies('B-1', '2026-11-03T10:30:00.000Z', ['JIRAUSER9'])).toMatchObject([{ id: '6', authorId: 'JIRAUSER9', body: 'approve' }]);
  });
});

describe('ADF', () => {
  it('converts Markdown to ADF', () => {
    const doc = markdownToAdf('# Title\n\nHello **bold** `code` [link](https://x.test)\nsame para\n\n1. one\n2. two\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 \\| 3 |\n');
    expect(doc.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'orderedList', 'codeBlock', 'table']);
    expect(doc.content[1]!.content!.map((n) => [n.text, n.marks?.[0]?.type])).toEqual([
      ['Hello ', undefined],
      ['bold', 'strong'],
      [' ', undefined],
      ['code', 'code'],
      [' ', undefined],
      ['link', 'link'],
      [' same para', undefined],
    ]);
    expect(doc.content[3]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] });
    const table = doc.content[4]!;
    expect(table.content!).toHaveLength(2);
    expect(table.content![0]!.content![0]!.type).toBe('tableHeader');
    expect(adfToText(table.content![1]!)).toBe('| 1 | 2 | 3 |');
  });

  it('reads ADF back as text', () => {
    const doc = markdownToAdf('Intro\n\n- a\n- b\n\n## H\n\n```\nx\n```');
    expect(adfToText(doc)).toBe('Intro\n\n- a\n- b\n\nH\n\n```\nx\n```');
    expect(adfToText({ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(adfToText(null)).toBe('');
    expect(adfToText('plain')).toBe('plain');
  });
});
