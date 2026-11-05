import { describe, expect, it } from 'vitest';
import { Settings } from '@tandem/shared';
import { MemorySecrets } from '../secrets/keychain.js';
import { JiraConnections, jiraSiteOf } from './jira-connections.js';
import { atlassianOAuth, type JiraOAuth } from './jira-oauth.js';
import type { Fetch } from './jira-tracker.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Atlassian (sign-in and gateway) and Jira sites, faked: routes by "METHOD host+path". */
function fake(routes: Record<string, (c: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const c: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) };
    calls.push(c);
    const u = new URL(url);
    const route = routes[`${c.method} ${u.host}${u.pathname}`];
    if (!route) return { ok: false, status: 404, text: async () => `no route for ${c.method} ${u.host}${u.pathname}` };
    const r = route(c);
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fetch, calls };
}

function harness(o: { oauth?: JiraOAuth; fetch?: Fetch; now?: () => number } = {}) {
  const secrets = new MemorySecrets();
  let settings = Settings.parse({});
  const jira = new JiraConnections({
    secrets,
    settings: async () => settings,
    saveJira: async (j) => void (settings = { ...settings, jira: { ...settings.jira, ...j } }),
    ...o,
  });
  return { jira, secrets, settings: () => settings };
}

const ACME = { id: 'cloud-acme', name: 'Acme', url: 'https://acme.atlassian.net', scopes: ['read:jira-work', 'write:jira-work'] };
const OTHER = { id: 'cloud-other', name: 'Other Co', url: 'https://other.atlassian.net', scopes: ['read:jira-work'] };
const WIKI = { id: 'cloud-wiki', name: 'Wiki', url: 'https://acme.atlassian.net', scopes: ['read:confluence-content.all'] };

describe('Connect Jira with Atlassian’s sign-in', () => {
  it('opens Atlassian with everything it needs, and connects the one site the account reaches', async () => {
    let issued = 0;
    const a = fake({
      'POST auth.atlassian.com/oauth/token': (c) => {
        issued++;
        expect(c.body).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'cid', client_secret: 'csecret', redirect_uri: 'http://localhost:4400/auth/jira/callback' });
        return { body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } };
      },
      'GET api.atlassian.com/oauth/token/accessible-resources': (c) => {
        expect(c.headers.Authorization).toBe('Bearer at-1');
        return { body: [ACME, WIKI] };
      },
      'GET api.atlassian.com/ex/jira/cloud-acme/rest/api/3/myself': (c) => {
        expect(c.headers.Authorization).toBe('Bearer at-1');
        return { body: { accountId: 'acc-1', displayName: 'Jane Doe' } };
      },
    });
    const oauth = atlassianOAuth({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'http://localhost:4400/auth/jira/callback', fetch: a.fetch });
    const h = harness({ oauth, fetch: a.fetch });
    expect(await h.jira.state()).toEqual({ connected: false, oauth: true });

    const page = new URL(h.jira.startSignIn());
    expect(`${page.origin}${page.pathname}`).toBe('https://auth.atlassian.com/authorize');
    expect(Object.fromEntries(page.searchParams)).toMatchObject({ audience: 'api.atlassian.com', client_id: 'cid', scope: 'read:jira-work write:jira-work read:jira-user offline_access', redirect_uri: 'http://localhost:4400/auth/jira/callback', response_type: 'code', prompt: 'consent' });
    const state = page.searchParams.get('state')!;
    // A made-up state is refused; the real one works once.
    await expect(h.jira.finishSignIn('forged', 'the-code')).rejects.toThrow(/no longer valid/);
    expect(await h.jira.finishSignIn(state, 'the-code')).toEqual({ connected: true, method: 'atlassian', site: { name: 'Acme', url: 'https://acme.atlassian.net' }, account: 'Jane Doe', oauth: true });
    await expect(h.jira.finishSignIn(state, 'the-code')).rejects.toThrow(/no longer valid/);
    expect(issued).toBe(1);
    // The site is the settings' Jira (for links); no token or email is kept for it.
    expect(h.settings().jira).toMatchObject({ baseUrl: 'https://acme.atlassian.net', email: '' });
    expect(await h.secrets.get('jira-token')).toBeUndefined();
    expect((await h.jira.tracker())?.link('SHOP-1')).toBe('https://acme.atlassian.net/browse/SHOP-1');
  });

  it('asks which site, when the account reaches several', async () => {
    const a = fake({ 'GET api.atlassian.com/ex/jira/cloud-other/rest/api/3/myself': () => ({ body: { accountId: 'acc-2', displayName: 'Jane at Other' } }) });
    const h = harness({ fetch: a.fetch, oauth: { available: () => true, refresh: async () => ({ access: 'x', expiresAt: 0 }) } });
    const s = await h.jira.useGrant({ access: 'at', refresh: 'rt', expiresAt: Date.now() + 3_600_000, sites: [ACME, OTHER] });
    expect(s).toMatchObject({ connected: false, sites: [{ id: 'cloud-acme' }, { id: 'cloud-other' }] });
    expect(await h.jira.tracker()).toBeUndefined();
    await expect(h.jira.chooseSite('cloud-nowhere')).rejects.toThrow(/Choose one of the sites/);
    expect(await h.jira.chooseSite('cloud-other')).toMatchObject({ connected: true, site: { name: 'Other Co' }, account: 'Jane at Other' });
  });

  it('renews the token before it runs out, keeping each new refresh token (Atlassian retires the old one)', async () => {
    let now = 1_000_000;
    const refreshed: string[] = [];
    const oauth: JiraOAuth = {
      available: () => true,
      refresh: async (rt) => {
        refreshed.push(rt);
        await new Promise((r) => setTimeout(r, 5));
        return { access: `at-${refreshed.length + 1}`, refresh: `rt-${refreshed.length + 1}`, expiresAt: now + 3_600_000 };
      },
    };
    const seen: string[] = [];
    const a = fake({ 'GET api.atlassian.com/ex/jira/cloud-acme/rest/api/3/myself': (c) => (seen.push(c.headers.Authorization!), { body: { accountId: 'a', displayName: 'Jane' } }) });
    const h = harness({ oauth, fetch: a.fetch, now: () => now });
    await h.jira.useGrant({ access: 'at-1', refresh: 'rt-1', expiresAt: now + 3_600_000, sites: [ACME] });
    const t = (await h.jira.tracker())!;
    now += 3_600_000; // the hour is up
    // Three calls at once renew once.
    await Promise.all([t.myself(), t.myself(), t.myself()]);
    expect(refreshed).toEqual(['rt-1']);
    expect(seen.slice(-3)).toEqual(['Bearer at-2', 'Bearer at-2', 'Bearer at-2']);
    expect(JSON.parse((await h.secrets.get('jira-oauth'))!)).toMatchObject({ access: 'at-2', refresh: 'rt-2' });
    now += 3_600_000;
    await t.myself();
    expect(refreshed).toEqual(['rt-1', 'rt-2']);
  });

  it('renews once when Jira turns the token down early, and says so plainly when renewing fails', async () => {
    let calls = 0;
    const a = fake({ 'GET api.atlassian.com/ex/jira/cloud-acme/rest/api/3/myself': (c) => (calls++, c.headers.Authorization === 'Bearer fresh' ? { body: { accountId: 'a', displayName: 'Jane' } } : { status: 401, body: {} }) });
    let fail = false;
    const oauth: JiraOAuth = {
      available: () => true,
      refresh: async () => {
        if (fail) throw new Error("Jira's sign-in has expired. Connect Jira again in Settings.");
        return { access: 'fresh', refresh: 'rt-2', expiresAt: Date.now() + 3_600_000 };
      },
    };
    const h = harness({ oauth, fetch: a.fetch });
    await h.jira.useGrant({ access: 'revoked', refresh: 'rt-1', expiresAt: Date.now() + 3_600_000, sites: [ACME] });
    expect((await (await h.jira.tracker())!.myself()).name).toBe('Jane');
    fail = true;
    await h.secrets.set('jira-oauth', JSON.stringify({ ...JSON.parse((await h.secrets.get('jira-oauth'))!), access: 'revoked-again' }));
    await expect((await h.jira.tracker())!.myself()).rejects.toThrow(/Connect Jira again/);
    expect(calls).toBeGreaterThan(2);
  });

  it('turns a refused renewal into "connect again"', async () => {
    const a = fake({ 'POST auth.atlassian.com/oauth/token': () => ({ status: 403, body: { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' } }) });
    const oauth = atlassianOAuth({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app.test/auth/jira/callback', fetch: a.fetch });
    await expect(oauth.refresh('old')).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/Connect Jira again/) });
  });

  it('refuses an Atlassian account without a Jira site', async () => {
    const a = fake({
      'POST auth.atlassian.com/oauth/token': () => ({ body: { access_token: 'at', expires_in: 3600 } }),
      'GET api.atlassian.com/oauth/token/accessible-resources': () => ({ body: [WIKI] }),
    });
    await expect(atlassianOAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', fetch: a.fetch }).exchange('code')).rejects.toThrow(/no Jira site/);
  });

  it("says the sign-in isn't available when this Tandem has no Atlassian app", () => {
    expect(() => harness().jira.startSignIn()).toThrow(/Connect with a token instead/);
  });
});

describe('Connect Jira with a token', () => {
  it('works out the site from any link, and checks the token before keeping it', async () => {
    const a = fake({
      'GET acme.atlassian.net/rest/api/3/myself': (c) =>
        c.headers.Authorization === `Basic ${Buffer.from('jane@acme.test:good-token').toString('base64')}` ? { body: { accountId: 'a1', displayName: 'Jane Doe' } } : { status: 401, body: {} },
    });
    const h = harness({ fetch: a.fetch });
    await expect(h.jira.useToken({ site: 'https://acme.atlassian.net/browse/SHOP-12', email: 'jane@acme.test', token: 'bad-token' })).rejects.toThrow(/did not accept that email and token/);
    expect(await h.secrets.get('jira-token')).toBeUndefined();
    await expect(h.jira.useToken({ site: 'acme', token: 'good-token' })).rejects.toThrow(/needs the email/);
    expect(await h.jira.useToken({ site: 'https://acme.atlassian.net/jira/software/projects/SHOP/boards/1', email: ' jane@acme.test ', token: ' good-token ' })).toEqual({ connected: true, method: 'token', site: { name: 'acme.atlassian.net', url: 'https://acme.atlassian.net' }, account: 'Jane Doe', oauth: false });
    expect(h.settings().jira).toMatchObject({ baseUrl: 'https://acme.atlassian.net', email: 'jane@acme.test' });
    expect(await h.secrets.get('jira-token')).toBe('good-token');
    await h.jira.disconnect();
    expect(await h.jira.state()).toEqual({ connected: false, oauth: false });
    expect(h.settings().jira.baseUrl).toBe('');
  });

  it('connects Jira Data Center with a personal access token, under a path', async () => {
    const a = fake({ 'GET jira.acme.test/tools/jira/rest/api/2/myself': (c) => (c.headers.Authorization === 'Bearer pat-1234567890' ? { body: { key: 'jdoe', displayName: 'J. Doe' } } : { status: 401, body: {} }) });
    const h = harness({ fetch: a.fetch });
    expect(await h.jira.useToken({ site: 'https://jira.acme.test/tools/jira/browse/OPS-7', email: 'ignored@acme.test', token: 'pat-1234567890' })).toMatchObject({ connected: true, method: 'token', site: { url: 'https://jira.acme.test/tools/jira' }, account: 'J. Doe' });
    expect(h.settings().jira.email).toBe('');
  });

  it('reads sites from what people paste', () => {
    expect(jiraSiteOf('acme')).toEqual({ url: 'https://acme.atlassian.net', cloud: true });
    expect(jiraSiteOf('ACME.atlassian.net/browse/X-1')).toEqual({ url: 'https://acme.atlassian.net', cloud: true });
    expect(jiraSiteOf('https://jira.acme.test/secure/Dashboard.jspa')).toEqual({ url: 'https://jira.acme.test', cloud: false });
    expect(() => jiraSiteOf('  ')).toThrow(/Paste the address/);
    expect(() => jiraSiteOf('ftp://jira.acme.test')).toThrow(/https address/);
  });
});

describe('What the pickers show', () => {
  it('lists projects, statuses (to do first) and people, through the gateway', async () => {
    const base = 'api.atlassian.com/ex/jira/cloud-acme/rest/api/3';
    const a = fake({
      [`GET ${base}/project/search`]: (c) =>
        new URL(c.url).searchParams.get('startAt') === '0' ? { body: { values: [{ key: 'SHOP', name: 'Shop' }], isLast: false, total: 2 } } : { body: { values: [{ key: 'OPS', name: 'Operations' }], isLast: true, total: 2 } },
      [`GET ${base}/project/SHOP/statuses`]: () => ({
        body: [
          { name: 'Task', statuses: [{ name: 'Done', statusCategory: { key: 'done' } }, { name: 'Ready for AI', statusCategory: { key: 'new' } }, { name: 'In Review', statusCategory: { key: 'indeterminate' } }] },
          { name: 'Bug', statusCategory: { key: 'new' }, statuses: [{ name: 'Ready for AI', statusCategory: { key: 'new' } }] },
        ],
      }),
      [`GET ${base}/status`]: () => ({ body: [{ name: 'Backlog', statusCategory: { key: 'new' } }] }),
      [`GET ${base}/user/search`]: (c) => {
        expect(new URL(c.url).searchParams.get('query')).toBe('pat');
        return { body: [{ accountId: 'u1', displayName: 'Pat Lee', accountType: 'atlassian' }, { accountId: 'bot', displayName: 'Pat Bot', accountType: 'app' }, { accountId: 'u2', displayName: 'Pat Gone', accountType: 'atlassian', active: false }] };
      },
    });
    const h = harness({ fetch: a.fetch, oauth: { available: () => true, refresh: async () => ({ access: 'x', expiresAt: 0 }) } });
    await h.jira.useGrant({ access: 'at', expiresAt: Date.now() + 3_600_000, sites: [ACME] });
    const t = (await h.jira.tracker())!;
    expect(await t.projects()).toEqual([
      { key: 'SHOP', name: 'Shop' },
      { key: 'OPS', name: 'Operations' },
    ]);
    expect(await t.statuses('SHOP')).toEqual(['Ready for AI', 'In Review', 'Done']);
    expect(await t.statuses()).toEqual(['Backlog']);
    expect(await t.people('pat')).toEqual([{ id: 'u1', name: 'Pat Lee' }]);
    expect(await t.people('  ')).toEqual([]);
  });
});
