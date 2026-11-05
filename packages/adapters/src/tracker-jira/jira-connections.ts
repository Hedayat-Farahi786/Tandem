import { randomBytes } from 'node:crypto';
import { redactor } from '@tandem/core';
import type { Settings } from '@tandem/shared';
import type { SecretStore } from '../secrets/keychain.js';
import { JiraError, JiraTracker, type Fetch } from './jira-tracker.js';
import type { JiraGrant, JiraOAuth, JiraSite } from './jira-oauth.js';

/*
 * The Jira a workspace is connected to, made in the app in one of two ways:
 *
 * - **Atlassian's sign-in** (Jira Cloud): "Connect Jira", sign in at Atlassian, allow Tandem, and
 *   choose the site when the account reaches several. The tokens are kept as one secret and renew
 *   themselves; the newest refresh token is always the one stored.
 * - **A token**, for Jira Data Center, or where no Atlassian app is set up: paste any link from
 *   Jira and a token; Tandem works out the site and checks the token before keeping it.
 *
 * Either way, Tandem checks the connection when it's made and says whose name its comments carry.
 */

interface SignIn {
  access: string;
  refresh?: string;
  expiresAt: number;
  site?: JiraSite;
  /** Signed in, waiting for the person to choose one of these sites. */
  sites?: JiraSite[];
  account?: { id: string; name: string };
}

export interface JiraState {
  connected: boolean;
  method?: 'atlassian' | 'token';
  site?: { name: string; url: string };
  /** Whose name Tandem's comments in Jira carry. */
  account?: string;
  /** Signed in at Atlassian; one of these sites is still to be chosen. */
  sites?: Array<{ id: string; name: string; url: string }>;
  /** "Connect Jira" with Atlassian's sign-in is offered. */
  oauth: boolean;
}

export interface JiraConnectionsOptions {
  secrets: SecretStore;
  settings: () => Promise<Settings>;
  saveJira: (jira: Pick<Settings['jira'], 'baseUrl' | 'email'>) => Promise<void>;
  oauth?: JiraOAuth;
  fetch?: Fetch;
  now?: () => number;
}

/** A link from Jira (an issue, a board, the home page) to the site's address. */
export function jiraSiteOf(input: string): { url: string; cloud: boolean } {
  let text = input.trim();
  if (!text) throw new JiraError('Paste the address of your Jira, or any link from it.', 400);
  // "acme" or "acme.atlassian.net" without a scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = /^[a-z0-9-]+$/i.test(text) ? `https://${text}.atlassian.net` : `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new JiraError(`"${input.trim()}" is not a web address. Paste a link from your Jira, such as an issue.`, 400);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new JiraError('Use the https address of your Jira.', 400);
  const cloud = /\.atlassian\.net$/i.test(u.hostname) || /\.jira\.com$/i.test(u.hostname);
  if (cloud) return { url: `https://${u.hostname.toLowerCase()}`, cloud };
  // Data Center can live under a path (https://company.com/jira/browse/SHOP-1): keep what's before Jira's own pages.
  const path = u.pathname.split(/\/(?:browse|secure|projects|issues|rest|plugins|servicedesk|login\.jsp|jira\/software|jira\/dashboards|jira\/your-work)(?:\/|$)/i)[0]!.replace(/\/+$/, '');
  return { url: `${u.protocol}//${u.host}${path}`, cloud };
}

export class JiraConnections {
  private readonly pending = new Map<string, { exp: number; from: string }>();
  private cached: { key: string; tracker: JiraTracker } | undefined;
  private renewing: Promise<string> | undefined;
  private readonly now: () => number;

  constructor(private readonly o: JiraConnectionsOptions) {
    this.now = o.now ?? Date.now;
  }

  private async signIn(): Promise<SignIn | undefined> {
    const raw = await this.o.secrets.get('jira-oauth');
    if (!raw) return undefined;
    try {
      const s = JSON.parse(raw) as SignIn;
      redactor.register(s.access);
      if (s.refresh) redactor.register(s.refresh);
      return s;
    } catch {
      return undefined;
    }
  }
  private async keep(s: SignIn): Promise<void> {
    redactor.register(s.access);
    if (s.refresh) redactor.register(s.refresh);
    await this.o.secrets.set('jira-oauth', JSON.stringify(s));
  }

  async state(): Promise<JiraState> {
    const oauth = Boolean(this.o.oauth?.available());
    const s = await this.signIn();
    if (s?.site) return { connected: true, method: 'atlassian', site: { name: s.site.name, url: s.site.url }, ...(s.account ? { account: s.account.name } : {}), oauth };
    if (s?.sites?.length) return { connected: false, method: 'atlassian', sites: s.sites.map((x) => ({ id: x.id, name: x.name, url: x.url })), oauth };
    const j = (await this.o.settings()).jira;
    if (j.baseUrl && (await this.o.secrets.get('jira-token'))) return { connected: true, method: 'token', site: { name: new URL(j.baseUrl).host, url: j.baseUrl }, ...(j.email ? { account: j.email } : {}), oauth };
    return { connected: false, oauth };
  }

  /** The connected Jira, or none. */
  async tracker(): Promise<JiraTracker | undefined> {
    const s = await this.signIn();
    if (s?.site) {
      const key = `oauth|${s.site.id}`;
      if (this.cached?.key !== key) this.cached = { key, tracker: new JiraTracker({ baseUrl: s.site.url, oauth: { cloudId: s.site.id, accessToken: (renew) => this.accessToken(renew) }, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) }) };
      return this.cached.tracker;
    }
    const j = (await this.o.settings()).jira;
    if (!j.baseUrl) return undefined;
    const token = await this.o.secrets.get('jira-token');
    if (!token) return undefined;
    const key = `token|${j.baseUrl}|${j.email}|${token.length}|${token.slice(-6)}`;
    if (this.cached?.key !== key) this.cached = { key, tracker: new JiraTracker({ baseUrl: j.baseUrl, email: j.email, token, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) }) };
    return this.cached.tracker;
  }

  /** A valid access token for the signed-in site, renewed (once, for everyone waiting) when due. */
  private async accessToken(renew = false): Promise<string> {
    const s = await this.signIn();
    if (!s) throw new JiraError('Jira is not connected any more. Connect Jira again in Settings.', 401);
    if (!renew && s.expiresAt - 60_000 > this.now()) return s.access;
    this.renewing ??= (async () => {
      try {
        if (!s.refresh || !this.o.oauth) throw new JiraError("Jira's sign-in has expired. Connect Jira again in Settings.", 401);
        const t = await this.o.oauth.refresh(s.refresh);
        // Atlassian retires the refresh token just used: keep the new one before anything else.
        await this.keep({ ...s, access: t.access, refresh: t.refresh ?? s.refresh, expiresAt: t.expiresAt });
        return t.access;
      } finally {
        this.renewing = undefined;
      }
    })();
    return this.renewing;
  }

  /** Connects with a token: any link from the Jira, the account email for Jira Cloud, and the token. */
  async useToken(input: { site: string; email?: string; token: string }): Promise<JiraState> {
    const { url, cloud } = jiraSiteOf(input.site);
    const token = input.token.trim();
    const email = cloud ? (input.email ?? '').trim() : '';
    if (!token) throw new JiraError('Paste the token.', 400);
    if (cloud && !/^[^@\s]+@[^@\s]+$/.test(email)) throw new JiraError('Jira Cloud needs the email you sign in to Atlassian with, together with the API token.', 400);
    const me = await new JiraTracker({ baseUrl: url, email, token, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) }).myself().catch((err: unknown) => {
      if (err instanceof JiraError && err.status === 401) throw new JiraError(cloud ? 'Jira did not accept that email and token. Check that the token belongs to this email, and create a new one if in doubt.' : 'Jira did not accept that token. Create a new personal access token and try again.', 400);
      if (err instanceof JiraError && err.status === 404) throw new JiraError(`There is no Jira at ${url}. Paste a link from your Jira, such as an issue.`, 400);
      throw err;
    });
    await this.o.secrets.set('jira-token', token);
    await this.o.secrets.delete('jira-oauth');
    await this.o.saveJira({ baseUrl: url, email });
    this.cached = undefined;
    const s = await this.state();
    return { ...s, ...(me.name ? { account: me.name } : {}) };
  }

  /** Starts Atlassian's sign-in (the local app): the page to open. `from` is where to come back to. */
  startSignIn(from = 'settings'): string {
    if (!this.o.oauth?.authorizeUrl || !this.o.oauth.available()) throw new JiraError("Atlassian's sign-in isn't set up for this Tandem. Connect with a token instead.", 409);
    const state = randomBytes(24).toString('base64url');
    const now = this.now();
    for (const [k, p] of this.pending) if (p.exp < now) this.pending.delete(k);
    this.pending.set(state, { exp: now + 10 * 60_000, from });
    return this.o.oauth.authorizeUrl(state);
  }

  /** Where a sign-in started (to send the person back there), while it is pending. */
  signInFrom(state: string): string {
    return this.pending.get(state)?.from ?? 'settings';
  }

  /** Atlassian sent the person back (the local app): checks the sign-in it started, and connects. */
  async finishSignIn(state: string, code: string): Promise<JiraState> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.exp < this.now()) throw new JiraError('That sign-in is no longer valid. Start "Connect Jira" again.', 400);
    if (!this.o.oauth?.exchange) throw new JiraError("Atlassian's sign-in isn't set up for this Tandem.", 409);
    return this.useGrant(await this.o.oauth.exchange(code));
  }

  /** A completed sign-in: kept, and connected at once when the account reaches one site. */
  async useGrant(g: JiraGrant): Promise<JiraState> {
    if (!g.sites.length) throw new JiraError('This Atlassian account has no Jira site Tandem may use.', 400);
    const s: SignIn = { access: g.access, ...(g.refresh ? { refresh: g.refresh } : {}), expiresAt: g.expiresAt };
    if (g.sites.length === 1) return this.connected({ ...s, site: g.sites[0]! });
    await this.keep({ ...s, sites: g.sites });
    return this.state();
  }

  /** The site to use, of those the sign-in reaches. */
  async chooseSite(id: string): Promise<JiraState> {
    const s = await this.signIn();
    const site = s?.sites?.find((x) => x.id === id);
    if (!s || !site) throw new JiraError('Choose one of the sites shown, or connect Jira again.', 400);
    const { sites: _sites, ...rest } = s;
    return this.connected({ ...rest, site });
  }

  private async connected(s: SignIn & { site: JiraSite }): Promise<JiraState> {
    await this.keep(s);
    await this.o.secrets.delete('jira-token');
    await this.o.saveJira({ baseUrl: s.site.url, email: '' });
    this.cached = undefined;
    const me = await (await this.tracker())?.myself().catch(() => undefined);
    if (me?.name) await this.keep({ ...((await this.signIn()) ?? s), account: me });
    return this.state();
  }

  async disconnect(): Promise<void> {
    await this.o.secrets.delete('jira-oauth');
    await this.o.secrets.delete('jira-token');
    await this.o.saveJira({ baseUrl: '', email: '' });
    this.cached = undefined;
  }
}
