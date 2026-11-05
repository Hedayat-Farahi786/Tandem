import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHosted, type Hosted } from '../hosted/server.js';

/*
 * "Connect Jira" in the web app: the front starts Atlassian's sign-in for an owner, takes
 * Atlassian's answer, and hands the finished sign-in to the workspace. GitHub and Atlassian are faked.
 */
const people: Record<string, { id: number; login: string; name: string }> = {
  owner: { id: 21, login: 'owner', name: 'Olive Owner' },
  member: { id: 22, login: 'member', name: 'Mo Member' },
};
const atlassian: Array<{ grant: string; body: Record<string, string> }> = [];
let refreshes = 0;
const fakeFetch = (async (input: URL | string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  const url = new URL(String(input));
  const auth = String(init?.headers?.Authorization ?? '');
  if (url.host === 'auth.atlassian.com' && url.pathname === '/oauth/token') {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, string>;
    atlassian.push({ grant: body.grant_type!, body });
    if (body.grant_type === 'authorization_code') return body.code === 'good' ? Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) : Response.json({ error: 'invalid_grant' }, { status: 403 });
    refreshes++;
    return body.refresh_token === `rt-${refreshes}` ? Response.json({ access_token: `at-${refreshes + 1}`, refresh_token: `rt-${refreshes + 1}`, expires_in: 3600 }) : Response.json({ error: 'invalid_grant' }, { status: 403 });
  }
  if (url.host === 'api.atlassian.com') {
    if (url.pathname === '/oauth/token/accessible-resources') return Response.json([{ id: 'cloud-acme', name: 'Acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] }]);
    if (!/^Bearer at-\d+$/.test(auth)) return Response.json({}, { status: 401 });
    if (url.pathname.endsWith('/rest/api/3/myself')) return Response.json({ accountId: 'acc-1', displayName: 'Olive at Acme' });
    if (url.pathname.endsWith('/rest/api/3/project/search')) return Response.json({ values: [{ key: 'SHOP', name: 'Shop' }], isLast: true });
    return Response.json({}, { status: 404 });
  }
  if (url.pathname === '/login/oauth/access_token') {
    const { code } = JSON.parse(init?.body ?? '{}') as { code: string };
    return Response.json(people[code] ? { access_token: `ghu_${code}`, expires_in: 28_800 } : { error: 'bad' });
  }
  const p = people[auth.replace('Bearer ghu_', '')];
  return p ? Response.json({ ...p, email: null, avatar_url: null }) : new Response('{}', { status: 401 });
}) as unknown as typeof fetch;

let h: Hosted;
const home = mkdtempSync(join(tmpdir(), 'tandem-jira-hosted-'));
const H = { host: 'tandem.test' };
const cookieOf = (setCookie: string | string[] | undefined, name: string) => ([] as string[]).concat(setCookie ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0] ?? '';

async function signIn(code: string, extraCookie = '') {
  const start = await h.app.inject({ method: 'GET', url: '/auth/github', headers: H });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const back = await h.app.inject({ method: 'GET', url: `/auth/github/callback?code=${code}&state=${state}`, headers: { ...H, cookie: [cookieOf(start.headers['set-cookie'], 'tandem_oauth'), extraCookie].filter(Boolean).join('; ') } });
  const cookie = cookieOf(back.headers['set-cookie'], 'tandem_session');
  const session = await h.directory.session(decodeURIComponent(cookie.split('=')[1]!));
  return { cookie, csrf: session!.csrf, userId: session!.userId };
}
const api = (who: { cookie: string; csrf: string }, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
  h.app.inject({ method, url, headers: { ...H, cookie: who.cookie, ...(method !== 'GET' ? { 'x-tandem-token': who.csrf } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });

let owner: Awaited<ReturnType<typeof signIn>>;
let member: Awaited<ReturnType<typeof signIn>>;
let workspaceId = '';

beforeAll(async () => {
  h = await startHosted(
    { home, port: 0, listenHost: '127.0.0.1', publicUrl: 'http://tandem.test', github: { clientId: 'Iv1.test', clientSecret: 'secret', webUrl: 'https://github.example', apiUrl: 'https://api.github.example' }, secretKey: randomBytes(32).toString('base64'), logLevel: 'silent', agent: 'scripted', sandbox: 'off', jira: { clientId: 'atl-client', clientSecret: 'atl-secret' } },
    { fetch: fakeFetch },
  );
  owner = await signIn('owner');
  workspaceId = (await h.directory.workspacesOf(owner.userId))[0]!.id;
  const invite = (await api(owner, 'POST', '/api/workspace/invites', {})).json() as { url: string };
  const token = invite.url.split('/join/')[1]!;
  member = await signIn('member', `tandem_join=${token}`);
  await h.app.inject({ method: 'POST', url: `/join/${token}`, headers: { ...H, cookie: member.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `csrf=${encodeURIComponent(member.csrf)}` });
}, 60_000);
afterAll(async () => {
  await h?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('Connect Jira in the web app', () => {
  it('lets only an owner start, and only this server finish', async () => {
    expect((await api(member, 'GET', '/api/jira')).json()).toEqual({ connected: false, oauth: true });
    expect((await api(member, 'POST', '/api/jira/oauth/start', {})).statusCode).toBe(403);
    // A finished sign-in can't be posted from a page, not even an owner's.
    expect((await api(owner, 'POST', '/api/jira/oauth', { access: 'mine', expiresAt: Date.now() + 3_600_000, sites: [{ id: 'x', name: 'Evil', url: 'https://evil.atlassian.net' }] })).statusCode).toBe(404);
    expect((await api(owner, 'GET', '/api/jira')).json().connected).toBe(false);
  });

  it('signs the owner in at Atlassian and connects the workspace', async () => {
    const start = await api(owner, 'POST', '/api/jira/oauth/start', { from: 'settings' });
    const { url } = start.json() as { url: string };
    const page = new URL(url);
    expect(page.origin + page.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(page.searchParams.get('redirect_uri')).toBe('http://tandem.test/auth/jira/callback');
    expect(page.searchParams.get('client_id')).toBe('atl-client');
    const state = page.searchParams.get('state')!;
    const nonce = cookieOf(start.headers['set-cookie'], 'tandem_jira');
    const callback = (q: string, cookie: string) => h.app.inject({ method: 'GET', url: `/auth/jira/callback?${q}`, headers: { ...H, cookie } });

    // Without the browser's own cookie (a link sent to someone else), or someone else's session: refused.
    expect((await callback(`code=good&state=${encodeURIComponent(state)}`, owner.cookie)).headers.location).toMatch(/^\/settings\?jira=failed&message=That%20sign-in%20is%20no%20longer%20valid/);
    expect((await callback(`code=good&state=${encodeURIComponent(state)}`, `${member.cookie}; ${nonce}`)).headers.location).toMatch(/jira=failed&message=Sign%20in%20to%20Tandem/);
    // A state changed on the way: refused.
    expect((await callback(`code=good&state=${encodeURIComponent(`x${state}`)}`, `${owner.cookie}; ${nonce}`)).headers.location).toMatch(/jira=failed/);
    expect(atlassian.filter((a) => a.grant === 'authorization_code')).toHaveLength(0);

    const back = await callback(`code=good&state=${encodeURIComponent(state)}`, `${owner.cookie}; ${nonce}`);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/settings?jira=connected#jira');
    expect(atlassian.find((a) => a.grant === 'authorization_code')?.body).toMatchObject({ client_id: 'atl-client', client_secret: 'atl-secret', code: 'good', redirect_uri: 'http://tandem.test/auth/jira/callback' });
    // Every member sees it; the tokens are sealed in the workspace's secrets, never in a page.
    expect((await api(member, 'GET', '/api/jira')).json()).toEqual({ connected: true, method: 'atlassian', site: { name: 'Acme', url: 'https://acme.atlassian.net' }, account: 'Olive at Acme', oauth: true });
    expect(JSON.parse((await h.directory.secretOf(workspaceId, 'jira-oauth'))!)).toMatchObject({ access: 'at-1', refresh: 'rt-1', site: { id: 'cloud-acme' } });
    expect((await api(owner, 'GET', '/api/settings')).body).not.toContain('at-1');
    expect(JSON.stringify((await api(owner, 'GET', '/api/activity')).json())).toContain('Olive Owner');
  });

  it('renews the sign-in in the cloud when it runs out, with the app’s secret', async () => {
    const kept = JSON.parse((await h.directory.secretOf(workspaceId, 'jira-oauth'))!) as Record<string, unknown>;
    await h.directory.setSecret(workspaceId, 'jira-oauth', JSON.stringify({ ...kept, expiresAt: Date.now() - 1000 }));
    expect((await api(member, 'GET', '/api/jira/projects')).json()).toEqual({ projects: [{ key: 'SHOP', name: 'Shop' }] });
    expect(atlassian.filter((a) => a.grant === 'refresh_token').map((a) => a.body)).toEqual([expect.objectContaining({ refresh_token: 'rt-1', client_id: 'atl-client', client_secret: 'atl-secret' })]);
    expect(JSON.parse((await h.directory.secretOf(workspaceId, 'jira-oauth'))!)).toMatchObject({ access: 'at-2', refresh: 'rt-2' });
  });

  it('renews a company runner’s sign-in only for a runner of this Tandem', async () => {
    const refresh = (headers: Record<string, string>) => h.app.inject({ method: 'POST', url: '/runner/jira/refresh', headers: { ...H, 'content-type': 'application/json', ...headers }, payload: JSON.stringify({ refresh: 'rt-2' }) });
    expect((await refresh({})).statusCode).toBe(401);
    expect((await refresh({ authorization: 'Bearer tdr_not-a-key' })).statusCode).toBe(401);
    const { key } = (await api(owner, 'POST', '/api/workspace/runner', {})).json() as { key: string };
    const renewed = await refresh({ authorization: `Bearer ${key}` });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({ access: 'at-3', refresh: 'rt-3' });
  });
});
