import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHosted, type Hosted } from '../hosted/server.js';
import { Directory } from '../hosted/directory.js';

/**
 * Two replicas of the web app sharing one Postgres directory, each with its own data folder: the
 * way a StatefulSet runs it. Needs TANDEM_TEST_DATABASE_URL (an empty Postgres database).
 */
const DB = process.env.TANDEM_TEST_DATABASE_URL;
const run = DB ? describe : describe.skip;

const people: Record<string, { id: number; login: string; name: string }> = { mona: { id: 1, login: 'mona', name: 'Mona Lisa' }, hubot: { id: 2, login: 'hubot', name: 'Hubot' } };
let refreshes = 0;
const fakeFetch = (async (input: URL | string, init?: { body?: string; headers?: Record<string, string> }) => {
  const url = new URL(String(input));
  if (url.pathname === '/login/oauth/access_token') {
    const b = JSON.parse(init?.body ?? '{}') as { code?: string; grant_type?: string; refresh_token?: string };
    if (b.grant_type === 'refresh_token') {
      refreshes++;
      await new Promise((r) => setTimeout(r, 150));
      return Response.json({ access_token: `ghu_renewed_${refreshes}`, expires_in: 28_800, refresh_token: `ghr_renewed_${refreshes}` });
    }
    return Response.json(b.code && people[b.code] ? { access_token: `ghu_${b.code}`, expires_in: 28_800, refresh_token: `ghr_${b.code}` } : { error: 'bad' });
  }
  if (url.pathname === '/user') {
    const p = people[String(init?.headers?.Authorization ?? '').replace('Bearer ghu_', '')];
    return p ? Response.json({ ...p, email: null, avatar_url: null }) : new Response('{}', { status: 401 });
  }
  return new Response('{}', { status: 404 });
}) as unknown as typeof fetch;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });

let r1: Hosted;
let r2: Hosted;
const homes: string[] = [];
const secretKey = randomBytes(32).toString('base64');
const PUBLIC = 'http://tandem.test';

async function replica(id: string): Promise<Hosted> {
  const home = mkdtempSync(join(tmpdir(), `tandem-replica-${id}-`));
  homes.push(home);
  const port = await freePort();
  return startHosted(
    { home, port, listenHost: '127.0.0.1', publicUrl: PUBLIC, github: { clientId: 'Iv1.test', clientSecret: 'secret', webUrl: 'https://github.example', apiUrl: 'https://api.github.example' }, secretKey, logLevel: 'silent', agent: 'scripted', databaseUrl: DB, replica: { id, url: `http://127.0.0.1:${port}` } },
    { fetch: fakeFetch },
  );
}

const cookieOf = (setCookie: string | string[] | undefined, name: string) => ([] as string[]).concat(setCookie ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0] ?? '';
async function signIn(h: Hosted, code: string) {
  const start = await h.app.inject({ method: 'GET', url: '/auth/github', headers: { host: 'tandem.test' } });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const back = await h.app.inject({ method: 'GET', url: `/auth/github/callback?code=${code}&state=${state}`, headers: { host: 'tandem.test', cookie: cookieOf(start.headers['set-cookie'], 'tandem_oauth') } });
  const cookie = cookieOf(back.headers['set-cookie'], 'tandem_session');
  const me = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { host: 'tandem.test', cookie } })).json() as { user: { id: string }; current: string };
  const session = await h.directory.session(decodeURIComponent(cookie.split('=')[1]!));
  return { cookie, csrf: session!.csrf, userId: me.user.id, workspace: me.current };
}

beforeAll(async () => {
  if (!DB) return;
  r1 = await replica('r1');
  r2 = await replica('r2');
}, 120_000);
afterAll(async () => {
  await r1?.stop();
  await r2?.stop();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

run('Tandem on two replicas (Postgres)', () => {
  it('spreads workspaces over the replicas, and answers for any workspace on either one', async () => {
    const mona = await signIn(r1, 'mona');
    const hubot = await signIn(r2, 'hubot');
    // Each workspace runs on exactly one replica, the quietest when it was made.
    expect(await r1.directory.workspaceReplica(mona.workspace)).toBe('r1');
    expect(await r1.directory.workspaceReplica(hubot.workspace)).toBe('r2');
    await new Promise((r) => setTimeout(r, 300));
    expect(r1.cells.has(mona.workspace) && !r2.cells.has(mona.workspace)).toBe(true);
    expect(r2.cells.has(hubot.workspace) && !r1.cells.has(hubot.workspace)).toBe(true);

    // Mona, sent to r2 by the load balancer: her session is good there, and her workspace answers from r1.
    const boot = await r2.app.inject({ method: 'GET', url: '/api/bootstrap', headers: { host: 'tandem.test', cookie: mona.cookie } });
    expect(boot.statusCode).toBe(200);
    const settings = boot.json().settings;
    const put = await r2.app.inject({ method: 'PUT', url: '/api/settings', headers: { host: 'tandem.test', cookie: mona.cookie, 'x-tandem-token': mona.csrf, 'content-type': 'application/json' }, payload: JSON.stringify({ ...settings, limits: { ...settings.limits, buildTimeoutMin: 33 } }) });
    expect(put.statusCode).toBe(200);
    const again = await r1.app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'tandem.test', cookie: mona.cookie } });
    expect(again.json()).toMatchObject({ limits: { buildTimeoutMin: 33 } });
    // The audit log on r1 names her, though she asked r2.
    const audit = (await r1.app.inject({ method: 'GET', url: '/api/activity?format=json', headers: { host: 'tandem.test', cookie: mona.cookie } })).body;
    expect(audit).toContain('Mona Lisa');
    // Live updates stream through r2 from r1.
    const port2 = Number(new URL(r2.url).port);
    const events = await fetch(`http://127.0.0.1:${port2}/api/events`, { headers: { cookie: mona.cookie } });
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
    await reader.cancel();
  });

  it('keeps the replicas\' own routes closed to everyone else', async () => {
    const port1 = Number(new URL(r1.url).port);
    expect((await fetch(`http://127.0.0.1:${port1}/internal/workspaces/00000000-0000-4000-8000-000000000000/purge`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port1}/internal/ws/00000000-0000-4000-8000-000000000000/api/settings`, { headers: { 'x-tandem-internal': 'guess' } })).status).toBe(404);
  });

  it('renews a GitHub token once when two replicas need it at the same moment', async () => {
    const mona = await signIn(r1, 'mona');
    await r1.directory.saveGitHubTokens(mona.userId, { access: 'ghu_old', accessExpiresAt: Date.now() - 60_000, refresh: 'ghr_old', refreshExpiresAt: Date.now() + 86_400_000 });
    refreshes = 0;
    const useMine = (h: Hosted) => h.app.inject({ method: 'POST', url: '/api/copilot/use-mine', headers: { host: 'tandem.test', cookie: mona.cookie, 'x-tandem-token': mona.csrf } });
    const [a, b] = await Promise.all([useMine(r1), useMine(r2)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(refreshes).toBe(1);
    expect(await r2.directory.gitHubTokens(mona.userId)).toMatchObject({ access: 'ghu_renewed_1', refresh: 'ghr_renewed_1' });
  });

  it('reaches a company runner connected to the other replica', async () => {
    const hubot = await signIn(r2, 'hubot');
    const made = (await r2.app.inject({ method: 'POST', url: '/api/workspace/runner', headers: { host: 'tandem.test', cookie: hubot.cookie, 'x-tandem-token': hubot.csrf, 'content-type': 'application/json' }, payload: '{}' })).json() as { key: string };
    // A pretend runner connects to r1 and answers every request itself.
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(r1.url).port}/runner/connect`, { headers: { authorization: `Bearer ${made.key}`, host: 'tandem.test' } });
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as { t: string; id: string; url: string };
      if (f.t !== 'req') return;
      ws.send(JSON.stringify({ t: 'head', id: f.id, status: 200, headers: { 'content-type': 'application/json' } }));
      ws.send(JSON.stringify({ t: 'data', id: f.id, b64: Buffer.from(JSON.stringify({ from: 'the runner', url: f.url })).toString('base64') }));
      ws.send(JSON.stringify({ t: 'end', id: f.id }));
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', machine: 'build-box', version: 'test' }));
    let info: { runner: { connected: boolean } } | undefined;
    for (let i = 0; i < 40 && !info?.runner.connected; i++) {
      await new Promise((r) => setTimeout(r, 100));
      info = (await r2.app.inject({ method: 'GET', url: '/api/workspace', headers: { host: 'tandem.test', cookie: hubot.cookie } })).json();
    }
    expect(info?.runner.connected).toBe(true);
    // Asked on r2, answered by the runner on r1.
    const res = await fetch(`http://127.0.0.1:${new URL(r2.url).port}/api/tasks`, { headers: { cookie: hubot.cookie } });
    expect(await res.json()).toEqual({ from: 'the runner', url: '/api/tasks' });
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    ws.close();
  });

  it('deletes a workspace on the replica that runs it, asked from the other', async () => {
    const mona = await signIn(r1, 'mona');
    const home = join(homes[0]!, 'workspaces', mona.workspace);
    expect(existsSync(home)).toBe(true);
    const del = await r2.app.inject({ method: 'DELETE', url: '/api/workspace', headers: { host: 'tandem.test', cookie: mona.cookie, 'x-tandem-token': mona.csrf } });
    expect(del.json()).toMatchObject({ ok: true });
    expect(existsSync(home)).toBe(false);
    expect(r1.cells.has(mona.workspace)).toBe(false);
  });

  it("moves a one-replica directory (SQLite) into Postgres, tokens and all", async () => {
    const home = mkdtempSync(join(tmpdir(), 'tandem-onebox-'));
    homes.push(home);
    const old = await Directory.open(join(home, 'directory.db'), secretKey);
    const user = await old.upsertGitHubUser({ id: 99, login: 'octo', name: 'Octo Cat' });
    const ws = await old.createWorkspace('Octo team', user.id);
    await old.saveGitHubTokens(user.id, { access: 'ghu_octo', refresh: 'ghr_octo' });
    await old.setSecret(ws.id, 'aws-connection', '{"kind":"keys"}');
    const counts = await r1.directory.copyFrom(old);
    await old.close();
    expect(counts).toMatchObject({ users: 1, workspaces: 1, members: 1, github_tokens: 1, workspace_secrets: 1 });
    expect((await r2.directory.workspacesOf(user.id)).map((w) => w.name)).toEqual(['Octo team']);
    expect(await r2.directory.gitHubTokens(user.id)).toMatchObject({ access: 'ghu_octo' });
    expect(await r2.directory.secretOf(ws.id, 'aws-connection')).toBe('{"kind":"keys"}');
    // No replica runs it yet: the first to start takes it.
    expect(await r2.directory.workspaceReplica(ws.id)).toBeUndefined();
  });
});
