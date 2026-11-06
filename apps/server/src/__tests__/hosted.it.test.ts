import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHosted, type Hosted } from '../hosted/server.js';

/** A pretend GitHub: the OAuth code exchange and /user, for two people. */
const people: Record<string, { id: number; login: string; name: string }> = {
  'code-mona': { id: 1, login: 'mona', name: 'Mona Lisa' },
  'code-hubot': { id: 2, login: 'hubot', name: 'Hubot' },
};
/** Grants revoked at GitHub ("Disconnect GitHub"): the tokens, with the app's own credentials. */
const revoked: Array<{ token: string; auth: string }> = [];
const fakeFetch = (async (input: URL | string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  const url = new URL(String(input));
  if (init?.method === 'DELETE' && url.pathname === '/applications/Iv1.test/grant') {
    revoked.push({ token: (JSON.parse(init.body ?? '{}') as { access_token: string }).access_token, auth: String(init.headers?.Authorization ?? '') });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/login/oauth/access_token') {
    const { code } = JSON.parse(init?.body ?? '{}') as { code: string };
    return new Response(JSON.stringify(people[code] ? { access_token: `ghu_${code}`, expires_in: 28800, refresh_token: `ghr_${code}`, refresh_token_expires_in: 15897600 } : { error: 'bad_verification_code' }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/user') {
    const code = String(init?.headers?.Authorization ?? '').replace('Bearer ghu_', '');
    const p = people[code];
    return p ? new Response(JSON.stringify({ ...p, email: null, avatar_url: null })) : new Response('{}', { status: 401 });
  }
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

let h: Hosted;
const home = mkdtempSync(join(tmpdir(), 'tandem-hosted-'));
const cookieOf = (setCookie: string | string[] | undefined, name: string) => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0]! : '';
};

/** Signs a person in through the whole GitHub flow; returns their cookie and CSRF token. */
async function signIn(code: string) {
  const start = await h.app.inject({ method: 'GET', url: '/auth/github' });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  expect(to.origin + to.pathname).toBe('https://github.example/login/oauth/authorize');
  expect(to.searchParams.get('redirect_uri')).toBe('http://tandem.test/auth/github/callback');
  const state = to.searchParams.get('state')!;
  const oauth = cookieOf(start.headers['set-cookie'], 'tandem_oauth');
  const back = await h.app.inject({ method: 'GET', url: `/auth/github/callback?code=${code}&state=${state}`, headers: { cookie: oauth } });
  expect(back.statusCode).toBe(302);
  const session = cookieOf(back.headers['set-cookie'], 'tandem_session');
  expect(back.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringMatching(/tandem_session=.*HttpOnly; SameSite=Lax/)]));
  const page = await h.app.inject({ method: 'GET', url: '/', headers: { cookie: session } });
  const csrf = /<meta name="tandem-token" content="([^"]+)">/.exec(page.body)?.[1] ?? '';
  return { cookie: session, csrf };
}

beforeAll(async () => {
  h = await startHosted(
    { home, port: 0, listenHost: '127.0.0.1', publicUrl: 'http://tandem.test', github: { clientId: 'Iv1.test', clientSecret: 'secret', webUrl: 'https://github.example', apiUrl: 'https://api.github.example' }, secretKey: randomBytes(32).toString('base64'), logLevel: 'silent', agent: 'scripted' },
    {
      fetch: fakeFetch,
      webDir: join(__dirname, '..', '..', '..', 'web', 'dist'),
      legalDir: join(__dirname, '..', '..', '..', '..', 'docs', 'legal'),
      // Tandem's own AWS identity, pretend: it may assume a customer's role when the external ID matches.
      awsRoleSource: {
        principal: 'arn:aws:iam::111122223333:role/tandem-server',
        credentials: async () => ({ accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'x'.repeat(40) }),
        assume: async (roleArn, externalId) => {
          if (!roleArn.endsWith('/TandemCodeCommit') || !externalId.startsWith('tandem-')) throw new Error('AccessDenied: not authorized to perform sts:AssumeRole');
          return { accessKeyId: 'ASIAROLE', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3_600_000) };
        },
      },
    },
  );
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

describe('hosted Tandem', () => {
  it('shows the sign-in page to visitors and answers APIs with "sign in"', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/tasks' });
    expect(page.body).toContain('Continue with GitHub');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const api = await h.app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toMatchObject({ signIn: true });
    // Only its public address: another Host is refused (DNS rebinding).
    expect((await h.app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(421);
    // A sign-in that GitHub didn't complete, or with the wrong state, shows a plain error.
    const bad = await h.app.inject({ method: 'GET', url: '/auth/github/callback?code=code-mona&state=forged', headers: { cookie: 'tandem_oauth=other' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('could not be completed');
  });

  it('shows the legal documents to everyone, as pages of the app', async () => {
    const privacy = await h.app.inject({ method: 'GET', url: '/legal/privacy' });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain('<h1 id="privacy-policy">Privacy policy</h1>');
    expect(privacy.body).toContain('<table>');
    expect(privacy.body).toContain('href="/legal/dpa"');
    expect(privacy.body).not.toMatch(/<script/i);
    expect((await h.app.inject({ method: 'GET', url: '/legal/terms' })).body).toContain('Terms of service');
    expect((await h.app.inject({ method: 'GET', url: '/legal/records-of-processing' })).statusCode).toBe(404);
  });

  it('signs in with GitHub, gives a first workspace, and serves its own Tandem behind the session', async () => {
    const mona = await signIn('code-mona');
    expect(mona.csrf.length).toBeGreaterThan(20);
    const me = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: mona.cookie } })).json();
    expect(me).toMatchObject({ user: { login: 'mona', name: 'Mona Lisa' }, workspaces: [{ name: "Mona Lisa's workspace", role: 'owner' }] });
    const boot = await h.app.inject({ method: 'GET', url: '/api/bootstrap', headers: { cookie: mona.cookie } });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toMatchObject({ setupComplete: false, projects: [] });
    // Changes need the session's token: without it, refused; with it, done in her workspace.
    const noToken = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: mona.cookie, 'content-type': 'application/json' }, payload: JSON.stringify(boot.json().settings) });
    expect(noToken.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: mona.cookie, 'x-tandem-token': mona.csrf, 'content-type': 'application/json' }, payload: JSON.stringify({ ...boot.json().settings, ownerName: 'Mona' }) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ownerName: 'Mona' });
    // Tokens are stored sealed, never in the clear.
    expect(await h.directory.gitHubTokens(me.user.id)).toMatchObject({ access: 'ghu_code-mona', refresh: 'ghr_code-mona' });
  });

  it('keeps workspaces apart: nobody reaches a workspace they are not a member of', async () => {
    const mona = await signIn('code-mona');
    const hubot = await signIn('code-hubot');
    const monaWs = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: mona.cookie } })).json().current as string;
    const use = await h.app.inject({ method: 'POST', url: `/api/workspaces/${monaWs}/use`, headers: { cookie: hubot.cookie, 'x-tandem-token': hubot.csrf } });
    expect(use.statusCode).toBe(404);
    const hubotBoot = (await h.app.inject({ method: 'GET', url: '/api/bootstrap', headers: { cookie: hubot.cookie } })).json();
    expect(hubotBoot.settings.ownerName).not.toBe('Mona');
    // A second workspace of her own, which she can switch to.
    const created = await h.app.inject({ method: 'POST', url: '/api/workspaces', headers: { cookie: mona.cookie, 'x-tandem-token': mona.csrf, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'Acme' }) });
    expect(created.json()).toMatchObject({ name: 'Acme' });
    expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: mona.cookie } })).json().workspaces).toHaveLength(2);
  });

  it("connects CodeCommit with a role in the customer's account: a template, their external ID, the role's ARN", async () => {
    const mona = await signIn('code-mona');
    const h1 = { cookie: mona.cookie };
    const setup = (await h.app.inject({ method: 'GET', url: '/api/aws/role', headers: h1 })).json();
    expect(setup).toMatchObject({ available: true, principal: 'arn:aws:iam::111122223333:role/tandem-server', externalId: expect.stringMatching(/^tandem-/), template: '/api/aws/role/template' });
    expect(setup.command).toContain(`ExternalId=${setup.externalId}`);
    const tpl = await h.app.inject({ method: 'GET', url: '/api/aws/role/template?repositories=shop', headers: h1 });
    expect(tpl.headers['content-disposition']).toContain('tandem-codecommit-role.yaml');
    expect(tpl.body).toContain(':codecommit:*:${AWS::AccountId}:shop');
    const write = (url: string, body: unknown) => h.app.inject({ method: 'POST', url, headers: { cookie: mona.cookie, 'x-tandem-token': mona.csrf, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect((await write('/api/aws/role', { roleArn: 'arn:aws:iam::444455556666:role/SomethingElse' })).json().error).toMatch(/can't assume .* yet/);
    expect((await write('/api/aws/role', { roleArn: 'arn:aws:iam::444455556666:role/TandemCodeCommit' })).json()).toMatchObject({ connected: true, kind: 'role', label: 'Role TandemCodeCommit in 444455556666' });
  });

  it('disconnects GitHub: access revoked at GitHub, signed out everywhere, workspaces kept', async () => {
    const here = await signIn('code-mona');
    const there = await signIn('code-mona');
    const ws = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: here.cookie } })).json() as { workspaces: Array<{ id: string }> };
    // A change needs the session's CSRF token, like every other.
    expect((await h.app.inject({ method: 'POST', url: '/auth/disconnect-github', headers: { cookie: here.cookie } })).statusCode).toBe(403);
    const out = await h.app.inject({ method: 'POST', url: '/auth/disconnect-github', headers: { cookie: here.cookie, 'x-tandem-token': here.csrf } });
    expect(out.json()).toEqual({ ok: true });
    expect(out.headers['set-cookie']).toEqual(expect.stringMatching(/^tandem_session=;/));
    expect(revoked).toEqual([{ token: 'ghu_code-mona', auth: `Basic ${Buffer.from('Iv1.test:secret').toString('base64')}` }]);
    for (const s of [here, there]) expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: s.cookie } })).statusCode).toBe(401);
    // Back with GitHub: the same workspaces.
    const again = await signIn('code-mona');
    const after = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: again.cookie } })).json() as { workspaces: Array<{ id: string }> };
    expect(after.workspaces.map((w) => w.id)).toEqual(ws.workspaces.map((w) => w.id));
  });

  it('exports the account, and deletes it with the workspaces only that person owned', async () => {
    const hubot = await signIn('code-hubot');
    const exported = await h.app.inject({ method: 'GET', url: '/api/me/export', headers: { cookie: hubot.cookie } });
    expect(exported.headers['content-disposition']).toContain('tandem-account.json');
    expect(exported.json()).toMatchObject({ user: { login: 'hubot' } });
    const before = readdirSync(join(home, 'workspaces')).length;
    const del = await h.app.inject({ method: 'DELETE', url: '/api/me', headers: { cookie: hubot.cookie, 'x-tandem-token': hubot.csrf } });
    expect(del.json()).toMatchObject({ ok: true, workspacesDeleted: 1 });
    expect(readdirSync(join(home, 'workspaces')).length).toBe(before - 1);
    expect((await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: hubot.cookie } })).statusCode).toBe(401);
    expect(existsSync(join(home, 'directory.db'))).toBe(true);
  });
});
