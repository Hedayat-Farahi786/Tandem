import type { Fetch } from './jira-tracker.js';
import { JiraError } from './jira-tracker.js';

/*
 * "Connect Jira": Atlassian's own sign-in (OAuth 2.0 with three parties, "3LO"). The person signs in
 * at Atlassian, allows Tandem, and comes back; Tandem then reaches their Jira Cloud site through
 * api.atlassian.com with a token that renews itself. Nobody copies an address, an email or a token.
 *
 * Atlassian needs the app's client secret for every exchange (no PKCE), so the secret stays on the
 * server that registered the app: the web app, or a local app given its own Atlassian app. Refresh
 * tokens rotate: each renewal returns a new one and retires the old, so the newest is always stored.
 */

export const ATLASSIAN_AUTH = 'https://auth.atlassian.com';
export const ATLASSIAN_API = 'https://api.atlassian.com';
/** Read and search issues and projects, comment and move issues, find people; renew without asking again. */
export const JIRA_SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'] as const;

export interface JiraTokens {
  access: string;
  /** Present with offline_access; replaced on every renewal. */
  refresh?: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}
export interface JiraSite {
  /** Atlassian's cloud ID of the site. */
  id: string;
  name: string;
  url: string;
}
export interface JiraGrant extends JiraTokens {
  /** The Jira sites this sign-in reaches. */
  sites: JiraSite[];
}

/** What a Tandem has of Atlassian's sign-in. */
export interface JiraOAuth {
  /** Whether "Connect Jira" with Atlassian's sign-in is offered here. */
  available(): boolean;
  /** The local app starts the sign-in itself; in the web app the front server does, so cells have none. */
  authorizeUrl?(state: string): string;
  exchange?(code: string): Promise<JiraGrant>;
  /** A new access token (and the next refresh token) for a refresh token. */
  refresh(refreshToken: string): Promise<JiraTokens>;
}

export interface AtlassianApp {
  clientId: string;
  clientSecret: string;
  /** Exactly the callback URL registered for the app in Atlassian's developer console. */
  redirectUri: string;
  fetch?: Fetch;
}

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

/** Atlassian's sign-in for one registered app. */
export function atlassianOAuth(app: AtlassianApp): Required<JiraOAuth> {
  const f = app.fetch ?? (globalThis.fetch as unknown as Fetch);
  const call = async <T>(url: string, init: Parameters<Fetch>[1]): Promise<{ status: number; body: T }> => {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await f(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new JiraError(`Could not reach Atlassian: ${(err as Error).message}`, 502);
    }
    const text = await res.text();
    let body: T;
    try {
      body = (text ? JSON.parse(text) : {}) as T;
    } catch {
      body = {} as T;
    }
    return { status: res.status, body };
  };
  const token = async (grant: Record<string, string>): Promise<JiraTokens> => {
    const r = await call<TokenAnswer>(`${ATLASSIAN_AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...grant, client_id: app.clientId, client_secret: app.clientSecret }),
    });
    if (!r.body.access_token) {
      if (r.body.error === 'invalid_grant' || r.status === 403 || r.status === 401)
        throw new JiraError(grant.grant_type === 'refresh_token' ? "Jira's sign-in has expired. Connect Jira again in Settings." : 'Atlassian did not accept the sign-in. Please try again.', 401);
      throw new JiraError(`Atlassian's sign-in failed (${r.status}). Please try again.`, 502);
    }
    return { access: r.body.access_token, ...(r.body.refresh_token ? { refresh: r.body.refresh_token } : {}), expiresAt: Date.now() + (r.body.expires_in ?? 3600) * 1000 };
  };
  return {
    available: () => true,
    authorizeUrl(state) {
      const u = new URL('/authorize', ATLASSIAN_AUTH);
      u.searchParams.set('audience', 'api.atlassian.com');
      u.searchParams.set('client_id', app.clientId);
      u.searchParams.set('scope', JIRA_SCOPES.join(' '));
      u.searchParams.set('redirect_uri', app.redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('prompt', 'consent');
      return u.toString();
    },
    async exchange(code) {
      const t = await token({ grant_type: 'authorization_code', code, redirect_uri: app.redirectUri });
      const r = await call<Array<{ id: string; name: string; url: string; scopes?: string[] }>>(`${ATLASSIAN_API}/oauth/token/accessible-resources`, { headers: { Authorization: `Bearer ${t.access}`, Accept: 'application/json' } });
      if (r.status !== 200 || !Array.isArray(r.body)) throw new JiraError('Atlassian did not say which Jira sites you can reach. Please try again.', 502);
      // Jira sites only (an Atlassian account can also reach Confluence and others).
      const sites = r.body.filter((x) => !x.scopes || x.scopes.some((s) => s.endsWith(':jira-work'))).map((x) => ({ id: x.id, name: x.name, url: x.url.replace(/\/+$/, '') }));
      if (!sites.length) throw new JiraError('This Atlassian account has no Jira site Tandem may use. Sign in with the account you use for Jira.', 400);
      return { ...t, sites };
    },
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}
