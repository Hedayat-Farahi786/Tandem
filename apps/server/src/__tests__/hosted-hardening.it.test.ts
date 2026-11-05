import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHosted, type Hosted } from '../hosted/server.js';
import { backup, restore } from '../backup.js';

/** The web app's brakes: invite-only sign-up, quotas, rate limits, probes and metrics. */
const people: Record<string, { id: number; login: string; name: string }> = {
  founder: { id: 11, login: 'founder', name: 'Founder' },
  friend: { id: 12, login: 'friend', name: 'Friend' },
  stranger: { id: 13, login: 'stranger', name: 'Stranger' },
  late: { id: 14, login: 'late', name: 'Late' },
};
const fakeFetch = (async (input: URL | string, init?: { body?: string; headers?: Record<string, string> }) => {
  const url = new URL(String(input));
  if (url.pathname === '/login/oauth/access_token') {
    const { code } = JSON.parse(init?.body ?? '{}') as { code: string };
    return Response.json(people[code] ? { access_token: `ghu_${code}`, expires_in: 28_800 } : { error: 'bad' });
  }
  const p = people[String(init?.headers?.Authorization ?? '').replace('Bearer ghu_', '')];
  return p ? Response.json({ ...p, email: null, avatar_url: null }) : new Response('{}', { status: 401 });
}) as unknown as typeof fetch;

let h: Hosted;
const home = mkdtempSync(join(tmpdir(), 'tandem-hardening-'));
const METRICS = 'metrics-token-0123456789abcdef';
const secretKey = randomBytes(32).toString('base64');
const H = { host: 'tandem.test' };
const cookieOf = (setCookie: string | string[] | undefined, name: string) => ([] as string[]).concat(setCookie ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0] ?? '';

/** The GitHub sign-in; returns the answer of the callback and the session (when there is one). */
async function signIn(code: string, extraCookie = '', ip = '10.9.9.9') {
  const start = await h.app.inject({ method: 'GET', url: '/auth/github', headers: { ...H, 'x-forwarded-for': ip } });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const back = await h.app.inject({ method: 'GET', url: `/auth/github/callback?code=${code}&state=${state}`, headers: { ...H, 'x-forwarded-for': ip, cookie: [cookieOf(start.headers['set-cookie'], 'tandem_oauth'), extraCookie].filter(Boolean).join('; ') } });
  const cookie = cookieOf(back.headers['set-cookie'], 'tandem_session');
  const session = cookie ? await h.directory.session(decodeURIComponent(cookie.split('=')[1]!)) : undefined;
  return { back, cookie, csrf: session?.csrf ?? '' };
}

beforeAll(async () => {
  h = await startHosted(
    {
      home,
      port: 0,
      listenHost: '127.0.0.1',
      publicUrl: 'http://tandem.test',
      github: { clientId: 'Iv1.test', clientSecret: 'secret', webUrl: 'https://github.example', apiUrl: 'https://api.github.example' },
      secretKey,
      logLevel: 'silent',
      agent: 'scripted',
      signup: { mode: 'invite', allow: ['Founder'] },
      limits: { workspacesPerPerson: 2, membersPerWorkspace: 2, invitesPerDay: 3 },
      metricsToken: METRICS,
    },
    { fetch: fakeFetch },
  );
}, 60_000);
afterAll(async () => {
  await h?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('the web app, hardened', () => {
  it('lets in only the listed and the invited while sign-up is invite-only', async () => {
    const stranger = await signIn('stranger');
    expect(stranger.back.statusCode).toBe(403);
    expect(stranger.back.body).toContain('invite-only');
    const founder = await signIn('founder');
    expect(founder.back.statusCode).toBe(302);
    const invite = (await h.app.inject({ method: 'POST', url: '/api/workspace/invites', headers: { ...H, cookie: founder.cookie, 'x-tandem-token': founder.csrf, 'content-type': 'application/json' }, payload: '{}' })).json() as { url: string };
    const token = invite.url.split('/join/')[1]!;
    const friend = await signIn('friend', `tandem_join=${token}`);
    expect(friend.back.statusCode).toBe(302);
    expect(friend.back.headers.location).toBe(`/join/${token}`);
    // Opening the link (from anywhere) only asks; nothing joins without the page's own token.
    const ask = await h.app.inject({ method: 'GET', url: `/join/${token}`, headers: { ...H, cookie: friend.cookie } });
    expect(ask.body).toContain('Join Founder&#39;s workspace?');
    expect(ask.body).toContain('Founder invited you');
    const forged = await h.app.inject({ method: 'POST', url: `/join/${token}`, headers: { ...H, cookie: friend.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'csrf=forged' });
    expect(forged.statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/workspace', headers: { ...H, cookie: friend.cookie } })).json()).toMatchObject({ role: 'owner' });
    const joined = await h.app.inject({ method: 'POST', url: `/join/${token}`, headers: { ...H, cookie: friend.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `csrf=${encodeURIComponent(friend.csrf)}` });
    expect(joined.statusCode).toBe(303);
    expect((await h.app.inject({ method: 'GET', url: '/api/workspace', headers: { ...H, cookie: friend.cookie } })).json()).toMatchObject({ role: 'member' });
    // The workspace is full now (2 members): a later invitee doesn't get in, and no more links are made.
    const late = await signIn('late', `tandem_join=${token}`);
    expect(late.back.statusCode).toBe(302);
    const full = await h.app.inject({ method: 'POST', url: `/join/${token}`, headers: { ...H, cookie: late.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `csrf=${encodeURIComponent(late.csrf)}` });
    expect(full.statusCode).toBe(409);
    expect((await h.app.inject({ method: 'GET', url: '/api/workspace', headers: { ...H, cookie: late.cookie } })).json()).toMatchObject({ role: 'owner', members: [expect.objectContaining({ login: 'late' })] });
    expect((await h.app.inject({ method: 'POST', url: '/api/workspace/invites', headers: { ...H, cookie: founder.cookie, 'x-tandem-token': founder.csrf, 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(409);
  });

  it('caps how many workspaces one person owns', async () => {
    const founder = await signIn('founder');
    const make = () => h.app.inject({ method: 'POST', url: '/api/workspaces', headers: { ...H, cookie: founder.cookie, 'x-tandem-token': founder.csrf, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'Another' }) });
    expect((await make()).statusCode).toBe(200);
    const third = await make();
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toMatch(/You own 2 workspaces/);
  });

  it('slows down sign-in attempts from one address, and nobody else', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await h.app.inject({ method: 'GET', url: '/auth/github', headers: { ...H, 'x-forwarded-for': '203.0.113.7' } })).statusCode);
    expect(statuses.filter((s) => s === 302).length).toBe(20);
    const limited = await h.app.inject({ method: 'GET', url: '/auth/github', headers: { ...H, 'x-forwarded-for': '203.0.113.7' } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await h.app.inject({ method: 'GET', url: '/auth/github', headers: { ...H, 'x-forwarded-for': '203.0.113.8' } })).statusCode).toBe(302);
    // An address the client wrote itself in front of the load balancer's doesn't get it past the limit.
    expect((await h.app.inject({ method: 'GET', url: '/auth/github', headers: { ...H, 'x-forwarded-for': '198.51.100.99, 203.0.113.7' } })).statusCode).toBe(429);
  });

  it('answers probes on any address, and shows metrics only with the token', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/healthz', headers: { host: '10.1.2.3:8080' } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/readyz', headers: { host: '10.1.2.3:8080' } })).json()).toMatchObject({ ok: true });
    expect((await h.app.inject({ method: 'GET', url: '/metrics', headers: { host: '10.1.2.3:8080' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/metrics', headers: { host: '10.1.2.3:8080', authorization: 'Bearer wrong-token-0123456789abc' } })).statusCode).toBe(404);
    const m = await h.app.inject({ method: 'GET', url: '/metrics', headers: { host: '10.1.2.3:8080', authorization: `Bearer ${METRICS}` } });
    expect(m.statusCode).toBe(200);
    expect(m.body).toMatch(/tandem_http_requests_total\{method="GET",route="\/auth\/github",status="302"\} \d+/);
    expect(m.body).toContain('tandem_rate_limited_total{policy="auth"}');
    expect(m.body).toContain('tandem_signins_total{result="not-invited"} 1');
    expect(m.body).toMatch(/tandem_workspaces_running\{replica="main"\} \d+/);
    expect(m.body).toContain('tandem_replicas_live 1');
    // Everything else still answers only on the public address.
    expect((await h.app.inject({ method: 'GET', url: '/', headers: { host: '10.1.2.3:8080' } })).statusCode).toBe(421);
  });

  it('backs up while running, and a restore drill brings everything back', async () => {
    const founder = await signIn('founder');
    const settings = (await h.app.inject({ method: 'GET', url: '/api/settings', headers: { ...H, cookie: founder.cookie } })).json();
    await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { ...H, cookie: founder.cookie, 'x-tandem-token': founder.csrf, 'content-type': 'application/json' }, payload: JSON.stringify({ ...settings, limits: { ...settings.limits, buildTimeoutMin: 44 } }) });
    const to = join(home, '..', `${home.split('/').pop()}-backup`);
    const m = await backup(home, to, 'test');
    expect(m.databases).toEqual(expect.arrayContaining(['directory.db', expect.stringMatching(/^workspaces\/[0-9a-f-]+\/tandem\.db$/)]));
    // Restore into a new, empty data folder; refused over existing data without --force.
    const home2 = mkdtempSync(join(tmpdir(), 'tandem-restored-'));
    expect(() => restore(to, home)).toThrow(/exists/);
    restore(to, home2);
    const h2 = await startHosted({ home: home2, port: 0, listenHost: '127.0.0.1', publicUrl: 'http://tandem.test', github: { clientId: 'Iv1.test', clientSecret: 'secret' }, secretKey, logLevel: 'silent', agent: 'scripted' }, { fetch: fakeFetch });
    try {
      // The same session still works, and the workspace has its settings.
      const back = await h2.app.inject({ method: 'GET', url: '/api/settings', headers: { ...H, cookie: founder.cookie } });
      expect(back.statusCode).toBe(200);
      expect(back.json()).toMatchObject({ limits: { buildTimeoutMin: 44 } });
      expect(await h2.directory.gitHubTokens((await h2.directory.userByGitHubId(11))!.id)).toMatchObject({ access: 'ghu_founder' });
    } finally {
      await h2.stop();
      rmSync(home2, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });
});
