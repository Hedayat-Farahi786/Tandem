import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import type { SecretStore } from '../secrets/keychain.js';
import type { AwsKeys } from './codecommit-credential.js';

/*
 * Connecting AWS for CodeCommit, inside Tandem: sign in with AWS IAM Identity Center (SSO) in the
 * browser (the same device sign-in `aws sso login` uses, no AWS CLI needed), an access key, or a
 * profile already on this computer. The connection lives in the system keychain; temporary
 * credentials are made from it when needed and never leave the server.
 */

export type AwsConnection =
  | {
      kind: 'sso';
      startUrl: string;
      ssoRegion: string;
      client: { id: string; secret: string; expiresAt: number };
      token: { access: string; expiresAt: number; refresh?: string | undefined };
      account: { id: string; name: string };
      role: string;
    }
  | { kind: 'keys'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'profile'; profile: string };

export interface AwsState {
  connected: boolean;
  kind?: AwsConnection['kind'];
  /** "Acme Dev · DeveloperAccess", "Access key …MNOP", "Profile work". */
  label?: string;
  /** For SSO: when the sign-in has to be renewed. */
  expiresAt?: string;
  /** Profiles in ~/.aws, offered as a shortcut. */
  profiles: string[];
  error?: string;
}

export interface SsoStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | undefined;
  expiresInSec: number;
}
export type SsoPoll =
  | { status: 'pending' }
  | { status: 'choose'; accounts: Array<{ id: string; name: string; email?: string | undefined; roles: string[] }> }
  | { status: 'error'; message: string };

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface Pending {
  startUrl: string;
  ssoRegion: string;
  client: { id: string; secret: string; expiresAt: number };
  deviceCode: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  token?: { access: string; expiresAt: number; refresh?: string | undefined };
}

const SSO_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** "https://acme.awsapps.com/start" or an issuer URL; a bare "acme" becomes the awsapps URL. */
export function normalizeStartUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z0-9-]+$/i.test(s)) return `https://${s}.awsapps.com/start`;
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  if (u.protocol !== 'https:') throw new Error('The start URL must use https.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/start'}${u.hash}`;
}

/** Profile names in ~/.aws/config and ~/.aws/credentials. */
export function localProfiles(home = homedir()): string[] {
  const names = new Set<string>();
  const read = (file: string, prefixed: boolean) => {
    if (!existsSync(file)) return;
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*\[\s*([^\]]+?)\s*\]/gm)) {
      const raw = m[1]!;
      if (prefixed && raw.startsWith('sso-session ')) continue;
      names.add(prefixed ? raw.replace(/^profile\s+/, '') : raw);
    }
  };
  read(process.env.AWS_CONFIG_FILE || join(home, '.aws', 'config'), true);
  read(process.env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials'), false);
  return [...names].sort();
}

const mask = (id: string) => `…${id.slice(-4)}`;

/** AWS SDK shape: no undefined session token. */
export const sdkKeys = (k: AwsKeys & { expiration?: Date | undefined }) => ({ accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, ...(k.sessionToken ? { sessionToken: k.sessionToken } : {}), ...(k.expiration ? { expiration: k.expiration } : {}) });

export class AwsConnections {
  private readonly pending = new Map<string, Pending>();
  private cached: { key: string; keys: AwsKeys & { expiration?: Date } } | undefined;

  constructor(
    private readonly o: {
      secrets: SecretStore;
      fetch?: Fetch;
      now?: () => number;
      /** Test seam: check credentials (default: STS GetCallerIdentity). */
      verify?: (keys: () => Promise<AwsKeys>, region: string) => Promise<void>;
      profiles?: () => string[];
      /** Test seam for the profile credentials. */
      fromProfile?: (profile: string) => () => Promise<AwsKeys & { expiration?: Date }>;
    },
  ) {}

  private get http(): Fetch {
    return this.o.fetch ?? (fetch as unknown as Fetch);
  }
  private now() {
    return this.o.now?.() ?? Date.now();
  }

  async connection(): Promise<AwsConnection | undefined> {
    const raw = await this.o.secrets.get('aws-connection').catch(() => undefined);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AwsConnection;
    } catch {
      return undefined;
    }
  }
  private async save(c: AwsConnection | undefined) {
    this.cached = undefined;
    if (c) await this.o.secrets.set('aws-connection', JSON.stringify(c));
    else await this.o.secrets.delete('aws-connection').catch(() => undefined);
  }

  async state(): Promise<AwsState> {
    const profiles = (this.o.profiles ?? localProfiles)();
    const c = await this.connection();
    if (!c) return { connected: false, profiles };
    const label = c.kind === 'sso' ? `${c.account.name} · ${c.role}` : c.kind === 'keys' ? `Access key ${mask(c.accessKeyId)}` : `Profile ${c.profile}`;
    const base: AwsState = { connected: true, kind: c.kind, label, profiles };
    if (c.kind === 'sso') {
      const until = c.token.refresh ? c.client.expiresAt : c.token.expiresAt;
      return { ...base, expiresAt: new Date(until).toISOString(), ...(until < this.now() ? { error: 'The AWS sign-in has expired. Sign in again.' } : {}) };
    }
    return base;
  }

  /* ------------------------------------------------------------ SSO sign-in */

  private oidc(region: string) {
    return `https://oidc.${region}.amazonaws.com`;
  }
  private portal(region: string) {
    return `https://portal.sso.${region}.amazonaws.com`;
  }
  private async call<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; message?: string }> {
    const res = await this.http(url, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, status: res.status, error: String(data.error ?? data.__type ?? res.status), ...(data.error_description || data.message ? { message: String(data.error_description ?? data.message) } : {}) };
  }

  async ssoBegin(startUrlInput: string, ssoRegion: string): Promise<SsoStart> {
    if (!SSO_REGION.test(ssoRegion)) throw new Error('Choose the AWS region your sign-in portal is in.');
    const startUrl = normalizeStartUrl(startUrlInput);
    const reg = await this.call<{ clientId: string; clientSecret: string; clientSecretExpiresAt: number }>(`${this.oidc(ssoRegion)}/client/register`, { method: 'POST', body: { clientName: 'Tandem', clientType: 'public', scopes: ['sso:account:access'] } });
    if (!reg.ok) throw new Error(`AWS didn't accept the sign-in (${reg.message ?? reg.error}). Check the region.`);
    const client = { id: reg.data.clientId, secret: reg.data.clientSecret, expiresAt: reg.data.clientSecretExpiresAt * 1000 };
    const dev = await this.call<{ deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number; interval?: number }>(`${this.oidc(ssoRegion)}/device_authorization`, { method: 'POST', body: { clientId: client.id, clientSecret: client.secret, startUrl } });
    if (!dev.ok) throw new Error(dev.status === 400 ? `That start URL isn't an AWS access portal in ${ssoRegion}. Check the URL and the region.` : `AWS didn't start the sign-in (${dev.message ?? dev.error}).`);
    const flowId = randomUUID();
    const intervalMs = (dev.data.interval ?? 5) * 1000;
    this.pending.set(flowId, { startUrl, ssoRegion, client, deviceCode: dev.data.deviceCode, intervalMs, nextPollAt: this.now(), expiresAt: this.now() + dev.data.expiresIn * 1000 });
    return { flowId, userCode: dev.data.userCode, verificationUri: dev.data.verificationUri, verificationUriComplete: dev.data.verificationUriComplete, expiresInSec: dev.data.expiresIn };
  }

  /** Asks AWS whether the person approved; once they have, lists the accounts and roles they may use. */
  async ssoPoll(flowId: string): Promise<SsoPoll> {
    const p = this.pending.get(flowId);
    if (!p) return { status: 'error', message: 'This sign-in has expired. Start again.' };
    if (this.now() > p.expiresAt) {
      this.pending.delete(flowId);
      return { status: 'error', message: 'The code expired before it was approved. Start again.' };
    }
    if (!p.token) {
      if (this.now() < p.nextPollAt) return { status: 'pending' };
      const t = await this.call<{ accessToken: string; expiresIn: number; refreshToken?: string }>(`${this.oidc(p.ssoRegion)}/token`, {
        method: 'POST',
        body: { clientId: p.client.id, clientSecret: p.client.secret, grantType: 'urn:ietf:params:oauth:grant-type:device_code', deviceCode: p.deviceCode },
      });
      if (!t.ok) {
        if (t.error === 'authorization_pending') {
          p.nextPollAt = this.now() + p.intervalMs;
          return { status: 'pending' };
        }
        if (t.error === 'slow_down') {
          p.intervalMs += 5000;
          p.nextPollAt = this.now() + p.intervalMs;
          return { status: 'pending' };
        }
        this.pending.delete(flowId);
        return { status: 'error', message: t.error === 'access_denied' ? 'The sign-in was declined in the browser.' : t.error === 'expired_token' ? 'The code expired before it was approved. Start again.' : `AWS refused the sign-in (${t.message ?? t.error}).` };
      }
      p.token = { access: t.data.accessToken, expiresAt: this.now() + t.data.expiresIn * 1000, refresh: t.data.refreshToken };
    }
    const accounts = await this.listAccounts(p.ssoRegion, p.token.access);
    if (!accounts.length) return { status: 'error', message: 'This sign-in has no AWS accounts assigned. Ask your AWS admin for access to the account with your repositories.' };
    return { status: 'choose', accounts };
  }

  private async listAccounts(region: string, token: string): Promise<Array<{ id: string; name: string; email?: string; roles: string[] }>> {
    const headers = { 'x-amz-sso_bearer_token': token };
    const out: Array<{ id: string; name: string; email?: string; roles: string[] }> = [];
    let next: string | undefined;
    do {
      const r = await this.call<{ accountList?: Array<{ accountId: string; accountName?: string; emailAddress?: string }>; nextToken?: string }>(`${this.portal(region)}/assignment/accounts?max_result=100${next ? `&next_token=${encodeURIComponent(next)}` : ''}`, { headers });
      if (!r.ok) throw new Error(`Couldn't list your AWS accounts (${r.message ?? r.error}).`);
      for (const a of r.data.accountList ?? []) out.push({ id: a.accountId, name: a.accountName || a.accountId, ...(a.emailAddress ? { email: a.emailAddress } : {}), roles: [] });
      next = r.data.nextToken;
    } while (next && out.length < 500);
    // Roles per account, a few at a time (most people have a handful of accounts).
    for (let i = 0; i < out.length; i += 8) {
      await Promise.all(
        out.slice(i, i + 8).map(async (a) => {
          const r = await this.call<{ roleList?: Array<{ roleName: string }> }>(`${this.portal(region)}/assignment/roles?account_id=${encodeURIComponent(a.id)}&max_result=100`, { headers });
          if (r.ok) a.roles = (r.data.roleList ?? []).map((x) => x.roleName).sort();
        }),
      );
    }
    return out.filter((a) => a.roles.length).sort((a, b) => a.name.localeCompare(b.name));
  }

  async ssoChoose(flowId: string, accountId: string, role: string): Promise<AwsState> {
    const p = this.pending.get(flowId);
    if (!p?.token) throw new Error('This sign-in has expired. Start again.');
    const accounts = await this.listAccounts(p.ssoRegion, p.token.access);
    const account = accounts.find((a) => a.id === accountId);
    if (!account || !account.roles.includes(role)) throw new Error('That account and role are not available to this sign-in.');
    const c: AwsConnection = { kind: 'sso', startUrl: p.startUrl, ssoRegion: p.ssoRegion, client: p.client, token: p.token, account: { id: account.id, name: account.name }, role };
    await this.roleCredentials(c);
    this.pending.delete(flowId);
    await this.save(c);
    return this.state();
  }

  ssoCancel(flowId: string) {
    this.pending.delete(flowId);
  }

  /* ------------------------------------------------------------ keys and profiles */

  async useKeys(accessKeyId: string, secretAccessKey: string, region: string): Promise<AwsState> {
    const id = accessKeyId.trim();
    const secret = secretAccessKey.trim();
    if (!/^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(id)) throw new Error('That access key ID looks wrong: it starts with AKIA.');
    if (id.startsWith('ASIA')) throw new Error('That is a temporary key, which expires within hours. Use a long-term access key, or sign in with AWS IAM Identity Center.');
    if (secret.length < 30) throw new Error('That secret access key looks too short.');
    await this.check(async () => ({ accessKeyId: id, secretAccessKey: secret }), region);
    await this.save({ kind: 'keys', accessKeyId: id, secretAccessKey: secret });
    return this.state();
  }

  async useProfile(profile: string, region: string): Promise<AwsState> {
    const name = profile.trim();
    if (!(this.o.profiles ?? localProfiles)().includes(name)) throw new Error(`There is no AWS profile named ${name} on this computer.`);
    await this.check(this.profileProvider(name), region);
    await this.save({ kind: 'profile', profile: name });
    return this.state();
  }

  async disconnect(): Promise<void> {
    await this.save(undefined);
  }

  private profileProvider(profile: string) {
    return this.o.fromProfile?.(profile) ?? (fromIni({ profile }) as unknown as () => Promise<AwsKeys & { expiration?: Date }>);
  }

  private async check(keys: () => Promise<AwsKeys>, region: string) {
    try {
      if (this.o.verify) return await this.o.verify(keys, region);
      await new STSClient({ region, credentials: async () => sdkKeys(await keys()) }).send(new GetCallerIdentityCommand({}));
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      throw new Error(/expired|sso|token/i.test(msg) ? `That profile's AWS sign-in has expired (${msg.split('\n')[0]}).` : `AWS didn't accept these credentials (${msg.split('\n')[0]}).`, { cause: err });
    }
  }

  /* ------------------------------------------------------------ credentials */

  private async refreshSso(c: Extract<AwsConnection, { kind: 'sso' }>): Promise<Extract<AwsConnection, { kind: 'sso' }>> {
    if (c.token.expiresAt - 60_000 > this.now()) return c;
    if (!c.token.refresh || c.client.expiresAt < this.now()) throw new Error('Your AWS sign-in has expired. Sign in again in Settings › AWS.');
    const t = await this.call<{ accessToken: string; expiresIn: number; refreshToken?: string }>(`${this.oidc(c.ssoRegion)}/token`, { method: 'POST', body: { clientId: c.client.id, clientSecret: c.client.secret, grantType: 'refresh_token', refreshToken: c.token.refresh } });
    if (!t.ok) throw new Error('Your AWS sign-in has expired. Sign in again in Settings › AWS.');
    const next = { ...c, token: { access: t.data.accessToken, expiresAt: this.now() + t.data.expiresIn * 1000, refresh: t.data.refreshToken ?? c.token.refresh } };
    await this.save(next);
    return next;
  }

  private async roleCredentials(c: Extract<AwsConnection, { kind: 'sso' }>): Promise<AwsKeys & { expiration: Date }> {
    const r = await this.call<{ roleCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number } }>(`${this.portal(c.ssoRegion)}/federation/credentials?account_id=${encodeURIComponent(c.account.id)}&role_name=${encodeURIComponent(c.role)}`, { headers: { 'x-amz-sso_bearer_token': c.token.access } });
    if (!r.ok) throw new Error(r.status === 401 ? 'Your AWS sign-in has expired. Sign in again in Settings › AWS.' : `AWS didn't give credentials for ${c.role} (${r.message ?? r.error}).`);
    const k = r.data.roleCredentials;
    return { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, sessionToken: k.sessionToken, expiration: new Date(k.expiration) };
  }

  /** Credentials for AWS calls and for signing git, or undefined when no AWS connection is set up. */
  async credentials(): Promise<(AwsKeys & { expiration?: Date }) | undefined> {
    const c = await this.connection();
    if (!c) return undefined;
    const key = c.kind === 'sso' ? `sso:${c.account.id}:${c.role}` : c.kind === 'keys' ? `keys:${c.accessKeyId}` : `profile:${c.profile}`;
    const hit = this.cached;
    if (hit && hit.key === key && (!hit.keys.expiration || hit.keys.expiration.getTime() - 5 * 60_000 > this.now())) return hit.keys;
    let keys: AwsKeys & { expiration?: Date };
    if (c.kind === 'keys') keys = { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
    else if (c.kind === 'profile') keys = await this.profileProvider(c.profile)();
    else keys = await this.roleCredentials(await this.refreshSso(c));
    this.cached = { key, keys };
    return keys;
  }

  /** As an AWS SDK credential provider. */
  provider() {
    return async () => {
      const k = await this.credentials();
      if (!k) throw new Error('AWS is not connected. Connect it in Settings › AWS.');
      return sdkKeys(k);
    };
  }
}
