import { describe, expect, it } from 'vitest';
import { MemorySecrets } from '../secrets/keychain.js';
import { AwsConnections, normalizeStartUrl } from './aws-connection.js';

type Call = { url: string; method: string; body?: unknown; headers?: Record<string, string> };

/** A pretend AWS: IAM Identity Center's OIDC and portal endpoints, scripted per path. */
function fakeAws(routes: Record<string, (c: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  let now = 1_800_000_000_000;
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const c: Call = { url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}), ...(init?.headers ? { headers: init.headers } : {}) };
    calls.push(c);
    const key = `${c.method} ${new URL(url).pathname}`;
    const r = routes[key]?.(c) ?? { status: 404, body: { error: 'not_found' } };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  const secrets = new MemorySecrets();
  const aws = new AwsConnections({ secrets, fetch, now: () => now, profiles: () => ['work'], verify: async () => undefined });
  return { aws, calls, secrets, tick: (ms: number) => (now += ms) };
}

describe('AWS connection', () => {
  it('reads the access portal URL the ways people paste it', () => {
    expect(normalizeStartUrl('acme')).toBe('https://acme.awsapps.com/start');
    expect(normalizeStartUrl('acme.awsapps.com/start/')).toBe('https://acme.awsapps.com/start');
    expect(normalizeStartUrl('https://acme.awsapps.com/start#/')).toBe('https://acme.awsapps.com/start#/');
    expect(() => normalizeStartUrl('http://acme.awsapps.com/start')).toThrow(/https/);
  });

  it('signs in with IAM Identity Center: a code to approve, then the account and role, then short-lived credentials', async () => {
    let approved = false;
    const t = fakeAws({
      'POST /client/register': () => ({ body: { clientId: 'cid', clientSecret: 'csecret', clientSecretExpiresAt: 1_900_000_000 } }),
      'POST /device_authorization': (c) => ({ body: { deviceCode: 'dev1', userCode: 'ABCD-EFGH', verificationUri: 'https://device.sso.eu-central-1.amazonaws.com/', verificationUriComplete: 'https://device.sso.eu-central-1.amazonaws.com/?user_code=ABCD-EFGH', expiresIn: 600, interval: 1, startUrl: (c.body as { startUrl: string }).startUrl } }),
      'POST /token': (c) => {
        const b = c.body as { grantType: string };
        if (b.grantType.endsWith('device_code')) return approved ? { body: { accessToken: 'at1', expiresIn: 3600, refreshToken: 'rt1' } } : { status: 400, body: { error: 'authorization_pending' } };
        return { body: { accessToken: 'at2', expiresIn: 3600 } };
      },
      'GET /assignment/accounts': () => ({ body: { accountList: [{ accountId: '111122223333', accountName: 'Acme Dev' }, { accountId: '444455556666', accountName: 'Acme Prod' }] } }),
      'GET /assignment/roles': (c) => ({ body: { roleList: new URL(c.url).searchParams.get('account_id') === '111122223333' ? [{ roleName: 'Developer' }] : [] } }),
      'GET /federation/credentials': () => ({ body: { roleCredentials: { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session', expiration: 1_800_003_600_000 } } }),
    });
    const start = await t.aws.ssoBegin('acme', 'eu-central-1');
    expect(start).toMatchObject({ userCode: 'ABCD-EFGH', verificationUriComplete: expect.stringContaining('user_code=ABCD-EFGH') });
    expect(t.calls.find((c) => c.url.endsWith('/device_authorization'))!.body).toMatchObject({ startUrl: 'https://acme.awsapps.com/start', clientId: 'cid' });
    expect(await t.aws.ssoPoll(start.flowId)).toEqual({ status: 'pending' });
    // Polls no faster than AWS asks.
    expect(await t.aws.ssoPoll(start.flowId)).toEqual({ status: 'pending' });
    expect(t.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    approved = true;
    t.tick(1500);
    const chosen = await t.aws.ssoPoll(start.flowId);
    // Only accounts with a role are offered.
    expect(chosen).toEqual({ status: 'choose', accounts: [{ id: '111122223333', name: 'Acme Dev', roles: ['Developer'] }] });
    expect(t.calls.find((c) => c.url.includes('/assignment/accounts'))!.headers!['x-amz-sso_bearer_token']).toBe('at1');
    const s = await t.aws.ssoChoose(start.flowId, '111122223333', 'Developer');
    expect(s).toMatchObject({ connected: true, kind: 'sso', label: 'Acme Dev · Developer' });
    expect(await t.aws.credentials()).toMatchObject({ accessKeyId: 'ASIAEXAMPLE', sessionToken: 'session' });
    // The connection is in the keychain; the state shown never carries a secret.
    expect(await t.secrets.get('aws-connection')).toContain('rt1');
    expect(JSON.stringify(await t.aws.state())).not.toMatch(/rt1|at1|secret/);
    // When the access token runs out, it renews itself with the refresh token.
    t.tick(2 * 3600_000);
    await t.aws.credentials();
    expect(t.calls.filter((c) => c.url.endsWith('/token')).map((c) => (c.body as { grantType: string }).grantType).at(-1)).toBe('refresh_token');
  });

  it('says plainly when the sign-in is declined, and refuses temporary or malformed keys', async () => {
    const t = fakeAws({
      'POST /client/register': () => ({ body: { clientId: 'cid', clientSecret: 'cs', clientSecretExpiresAt: 1_900_000_000 } }),
      'POST /device_authorization': () => ({ body: { deviceCode: 'd', userCode: 'U', verificationUri: 'https://x', expiresIn: 600, interval: 1 } }),
      'POST /token': () => ({ status: 400, body: { error: 'access_denied' } }),
    });
    const start = await t.aws.ssoBegin('acme', 'eu-central-1');
    expect(await t.aws.ssoPoll(start.flowId)).toEqual({ status: 'error', message: 'The sign-in was declined in the browser.' });
    await expect(t.aws.ssoBegin('acme', 'mars-1')).rejects.toThrow(/region/);
    await expect(t.aws.useKeys('ASIAABCDEFGHIJKLMNOP', 'x'.repeat(40), 'eu-central-1')).rejects.toThrow(/temporary/);
    await expect(t.aws.useKeys('nope', 'x'.repeat(40), 'eu-central-1')).rejects.toThrow(/AKIA/);
    expect(await t.aws.useKeys('AKIAABCDEFGHIJKLMNOP', 'x'.repeat(40), 'eu-central-1')).toMatchObject({ connected: true, kind: 'keys', label: 'Access key …MNOP' });
    await expect(t.aws.useProfile('missing', 'eu-central-1')).rejects.toThrow(/no AWS profile/);
    await t.aws.disconnect();
    expect((await t.aws.state()).connected).toBe(false);
  });
});
