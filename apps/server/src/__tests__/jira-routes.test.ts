import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatService } from '@tandem/core';
import { MemorySecrets, ScriptedAgent, atlassianOAuth, createTandem, defaultScript, type Fetch, type Tandem } from '@tandem/adapters';
import { buildApp } from '../app.js';
import { EventBus } from '../events.js';

/*
 * Settings › Jira in the local app: "Connect Jira" with Atlassian's sign-in (Atlassian faked), and
 * with a token; then the pickers. The keychain is in memory here.
 */
const PORT = 4503;
const TOKEN = 'test-token-0123456789';
const H = { host: `localhost:${PORT}` };
const W = { ...H, 'x-tandem-token': TOKEN, 'content-type': 'application/json' };
const BASIC = `Basic ${Buffer.from('jane@acme.test:good-api-token').toString('base64')}`;
const GATEWAY = '/ex/jira/cloud-acme/rest/api/3';

const searched: string[] = [];
const fetch: Fetch = async (url, init) => {
  const u = new URL(url);
  const auth = init?.headers?.Authorization ?? '';
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const key = `${init?.method ?? 'GET'} ${u.host}${u.pathname}`;
  if (key === 'POST auth.atlassian.com/oauth/token') {
    const b = JSON.parse(init!.body!) as { code?: string; grant_type: string };
    return b.code === 'good-code' ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 403);
  }
  if (key === 'GET api.atlassian.com/oauth/token/accessible-resources') return json([{ id: 'cloud-acme', name: 'Acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work'] }]);
  const signedIn = auth === 'Bearer at-1' && u.host === 'api.atlassian.com';
  const withToken = auth === BASIC && u.host === 'acme.atlassian.net';
  const path = signedIn ? u.pathname.replace('/ex/jira/cloud-acme', '') : u.pathname;
  if ((signedIn && u.pathname.startsWith(GATEWAY.split('/rest')[0]!)) || withToken) {
    if (path === '/rest/api/3/myself') return json({ accountId: 'acc-1', displayName: 'Jane Doe' });
    if (path === '/rest/api/3/status') return json([{ name: 'Done', statusCategory: { key: 'done' } }, { name: 'Ready for AI', statusCategory: { key: 'new' } }]);
    if (path === '/rest/api/3/project/search') return json({ values: [{ key: 'SHOP', name: 'Shop' }], isLast: true });
    if (path === '/rest/api/3/user/search') return json([{ accountId: 'pm-1', displayName: 'Pat Lee', accountType: 'atlassian' }]);
    if (path === '/rest/api/3/search/jql') {
      searched.push((JSON.parse(init!.body!) as { jql: string }).jql);
      return json({ issues: [], isLast: true });
    }
  }
  if (u.host === 'acme.atlassian.net') return json({}, 401);
  return json({ error: `no fake for ${key}` }, 404);
};

let dir: string;
let tandem: Tandem;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-jira-'));
  const bus = new EventBus();
  tandem = await createTandem({
    home: join(dir, 'home'),
    agent: new ScriptedAgent(defaultScript),
    secrets: new MemorySecrets(),
    events: bus,
    jira: { oauth: atlassianOAuth({ clientId: 'cid', clientSecret: 'csecret', redirectUri: `http://localhost:${PORT}/auth/jira/callback`, fetch }), fetch },
  });
  ({ app } = await buildApp({ tandem, bus, chat: new ChatService(tandem.deps, tandem.service), doctor: {} }, { port: PORT, token: TOKEN, version: '9.9.9' }));
});
afterAll(async () => {
  await app.close();
  await tandem.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: H })).json();

describe('Connect Jira in the local app', () => {
  it('signs in at Atlassian and comes back to where it started, connected', async () => {
    expect(await get('/api/jira')).toEqual({ connected: false, oauth: true });
    // Starting needs the page's token, like every change.
    expect((await app.inject({ method: 'POST', url: '/api/jira/oauth/start', headers: H })).statusCode).toBe(403);
    const { url } = (await app.inject({ method: 'POST', url: '/api/jira/oauth/start', headers: W, payload: JSON.stringify({ from: 'setup' }) })).json() as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    // Atlassian sends the person back.
    const cancelled = await app.inject({ method: 'GET', url: `/auth/jira/callback?error=access_denied&state=${state}`, headers: H });
    expect(cancelled.headers.location).toBe(`/setup?jira=failed&message=${encodeURIComponent('You cancelled the sign-in at Atlassian.')}`);
    const { url: again } = (await app.inject({ method: 'POST', url: '/api/jira/oauth/start', headers: W, payload: '{}' })).json() as { url: string };
    const back = await app.inject({ method: 'GET', url: `/auth/jira/callback?code=good-code&state=${new URL(again).searchParams.get('state')}`, headers: H });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/settings?jira=connected#jira');
    expect(await get('/api/jira')).toEqual({ connected: true, method: 'atlassian', site: { name: 'Acme', url: 'https://acme.atlassian.net' }, account: 'Jane Doe', oauth: true });
    expect((await get('/api/bootstrap')).jiraConfigured).toBe(true);
    // The pickers: statuses, projects and people, from Jira.
    expect(await get('/api/jira/statuses')).toEqual({ statuses: ['Ready for AI', 'Done'] });
    expect(await get('/api/jira/projects')).toEqual({ projects: [{ key: 'SHOP', name: 'Shop' }] });
    expect(await get('/api/jira/people?query=pat')).toEqual({ people: [{ id: 'pm-1', name: 'Pat Lee' }] });
    expect(await get('/api/jira/people?query=p')).toEqual({ people: [] });
    // The audit log says who connected what, and no route shows a token.
    expect(JSON.stringify(await get('/api/activity'))).toContain("Connected Jira at https://acme.atlassian.net with Atlassian's sign-in.");
    expect(JSON.stringify(await get('/api/settings'))).not.toContain('at-1');
  });

  it('keeps the connection when a Settings page opened earlier is saved', async () => {
    const stale = await get('/api/settings');
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers: W, payload: JSON.stringify({ ...stale, jira: { ...stale.jira, baseUrl: '', email: 'someone@else.test', readyJql: 'status = "Ready for AI"' } }) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().jira).toMatchObject({ baseUrl: 'https://acme.atlassian.net', email: '' });
    expect((await get('/api/jira')).connected).toBe(true);
  });

  it('connects with a token, checked first, and disconnects', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/jira/token', headers: W, payload: JSON.stringify({ site: 'https://acme.atlassian.net/browse/SHOP-1', email: 'jane@acme.test', token: 'wrong' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/did not accept that email and token/);
    // The sign-in from before is still there after a failed attempt.
    expect((await get('/api/jira')).method).toBe('atlassian');
    const good = await app.inject({ method: 'POST', url: '/api/jira/token', headers: W, payload: JSON.stringify({ site: 'acme', email: 'jane@acme.test', token: 'good-api-token' }) });
    expect(good.json()).toMatchObject({ connected: true, method: 'token', account: 'Jane Doe' });
    expect(await tandem.secrets.get('jira-oauth')).toBeUndefined();
    // Importing a project's issues uses its Jira project with the status from Settings.
    const tracker = await tandem.deps.tracker();
    expect(tracker.kind).toBe('jira');
    await tracker.findReadyTasks('project = "SHOP" AND (status = "Ready for AI")');
    expect(searched.at(-1)).toBe('project = "SHOP" AND (status = "Ready for AI")');
    const gone = await app.inject({ method: 'DELETE', url: '/api/jira', headers: { ...H, 'x-tandem-token': TOKEN } });
    expect(gone.json()).toEqual({ connected: false, oauth: true });
    expect((await tandem.deps.tracker()).kind).toBe('local');
    expect((await app.inject({ method: 'GET', url: '/api/jira/projects', headers: H })).statusCode).toBe(409);
  });
});
