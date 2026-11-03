import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type PullRequest, type Repo } from '@tandem/shared';
import { RetryableError } from '@tandem/core';
import { MemorySecrets } from '../secrets/keychain.js';
import { GitHubHost, parseGitHubUrl, type Fetch } from './github-host.js';

const repo: Repo = { id: 'r1', url: 'git@github.com:acme/shop.git', host: { kind: 'github', owner: 'acme', name: 'shop' }, name: 'shop', defaultBranch: 'main', role: 'full-stack', commands: {}, createdAt: '' };

function gh(routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>, token: string | null = 'ghp_testtoken1234567890abcdef') {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, ...(init?.headers?.Authorization ? { auth: init.headers.Authorization } : {}) });
    const u = new URL(url);
    const r = (routes[`${method} ${u.pathname}${u.search}`] ?? routes[`${method} ${u.pathname}`])?.(body);
    if (!r) return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  const secrets = new MemorySecrets();
  const h = new GitHubHost({ home: mkdtempSync(join(tmpdir(), 'tandem-gh-')), settings: async () => DEFAULT_SETTINGS, secrets, fetch, ghToken: async () => token ?? undefined });
  return { h, calls, secrets };
}

const req = { repo, sourceBranch: 'agent/TND-1-health', destinationBranch: 'main', title: 'TND-1: Health', description: 'Body', idempotencyKey: 'k' };

describe('GitHub URLs', () => {
  it('parses SSH, scp-style and HTTPS URLs, including enterprise hosts', () => {
    expect(parseGitHubUrl('git@github.com:acme/shop.git')).toEqual({ host: 'github.com', owner: 'acme', name: 'shop', transport: 'ssh' });
    expect(parseGitHubUrl('ssh://git@github.com/acme/shop')).toEqual({ host: 'github.com', owner: 'acme', name: 'shop', transport: 'ssh' });
    expect(parseGitHubUrl('https://github.com/acme/shop.git')).toEqual({ host: 'github.com', owner: 'acme', name: 'shop', transport: 'https' });
    expect(parseGitHubUrl('https://acme.ghe.com/team/app')).toMatchObject({ host: 'acme.ghe.com', transport: 'https' });
    expect(parseGitHubUrl('https://gitlab.com/a/b')).toBeUndefined();
    const { h } = gh({});
    expect(h.detect('https://acme.ghe.com/team/app')?.host).toEqual({ kind: 'github', owner: 'team', name: 'app', apiBase: 'https://acme.ghe.com/api/v3' });
    expect(h.access({ ...repo, url: 'https://github.com/acme/shop' }).config).toEqual(['credential.helper=', 'credential.helper=!gh auth git-credential']);
    expect(h.access(repo).config).toEqual([]);
  });
});

describe('GitHub pull requests', () => {
  it('creates a PR, or reuses the one that already exists for the branch', async () => {
    const created = gh({
      'GET /repos/acme/shop/pulls': () => ({ body: [] }),
      'POST /repos/acme/shop/pulls': () => ({ status: 201, body: { number: 7, html_url: 'https://github.com/acme/shop/pull/7' } }),
    });
    expect(await created.h.openPullRequest(req)).toEqual({ kind: 'created', providerId: '7', url: 'https://github.com/acme/shop/pull/7' });
    expect(created.calls[0]!.url).toContain('head=acme%3Aagent%2FTND-1-health');
    expect(created.calls[1]!.body).toMatchObject({ title: 'TND-1: Health', head: 'agent/TND-1-health', base: 'main', body: 'Body' });
    expect(created.calls[1]!.auth).toBe('Bearer ghp_testtoken1234567890abcdef');
    const existing = gh({ 'GET /repos/acme/shop/pulls': () => ({ body: [{ number: 3, html_url: 'https://github.com/acme/shop/pull/3' }] }) });
    expect(await existing.h.openPullRequest(req)).toMatchObject({ providerId: '3' });
    expect(existing.calls).toHaveLength(1);
  });

  it('prefers a token saved in Settings over the GitHub CLI', async () => {
    const t = gh({ 'GET /repos/acme/shop/pulls': () => ({ body: [{ number: 1, html_url: 'u' }] }) });
    await t.secrets.set('github-token', 'ghp_fromsettings1234567890');
    await t.h.openPullRequest(req);
    expect(t.calls[0]!.auth).toBe('Bearer ghp_fromsettings1234567890');
  });

  it('falls back to a compare link without a token or when refused, and retries 5xx', async () => {
    const none = gh({}, null);
    const r = await none.h.openPullRequest(req);
    expect(r).toMatchObject({ kind: 'manual' });
    expect(r.url).toBe('https://github.com/acme/shop/compare/main...agent%2FTND-1-health?expand=1&title=TND-1%3A%20Health');
    const refused = gh({ 'GET /repos/acme/shop/pulls': () => ({ body: [] }), 'POST /repos/acme/shop/pulls': () => ({ status: 403, body: { message: 'Resource not accessible' } }) });
    expect((await refused.h.openPullRequest(req)).kind).toBe('manual');
    const down = gh({ 'GET /repos/acme/shop/pulls': () => ({ status: 502 }) });
    await expect(down.h.openPullRequest(req)).rejects.toBeInstanceOf(RetryableError);
  });

  it('maps status and updates the body', async () => {
    const t = gh({
      'GET /repos/acme/shop/pulls/1': () => ({ body: { state: 'open', merged_at: null } }),
      'GET /repos/acme/shop/pulls/2': () => ({ body: { state: 'closed', merged_at: '2026-11-03T00:00:00Z' } }),
      'GET /repos/acme/shop/pulls/3': () => ({ body: { state: 'closed', merged_at: null } }),
      'PATCH /repos/acme/shop/pulls/1': () => ({ body: {} }),
    });
    const pr = (n: string): PullRequest => ({ id: n, taskId: 't', repoId: 'r1', providerId: n, url: '', title: '', description: '', status: 'open', manual: false, createdAt: '' });
    expect(await t.h.getPullRequestStatus(repo, pr('1'))).toBe('open');
    expect(await t.h.getPullRequestStatus(repo, pr('2'))).toBe('merged');
    expect(await t.h.getPullRequestStatus(repo, pr('3'))).toBe('closed');
    expect(await t.h.getPullRequestStatus(repo, { ...pr('4'), providerId: undefined, status: 'manual-pending' } as unknown as PullRequest)).toBe('manual-pending');
    await t.h.updatePullRequestDescription(repo, pr('1'), 'new body');
    expect(t.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { body: 'new body' } });
  });
});
