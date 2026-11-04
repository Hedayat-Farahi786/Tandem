import type { AccountState, CopilotAccounts, GitHubIdentity, SecretStore, SignInStep } from '@tandem/adapters';
import type { Directory } from './directory.js';

/*
 * What a workspace's cell gets from the hosted app: its secrets (sealed in the directory, not a
 * keychain on the server), and the GitHub identity it works as: the member whose Copilot plan the
 * workspace uses. Their token is renewed with GitHub's refresh token when it nears expiry.
 */

export interface GitHubAppConfig {
  clientId: string;
  clientSecret: string;
  webUrl: string;
  /** The app's public page, for "install on your account or organization". */
  slug?: string | undefined;
}

/** Renews GitHub App user tokens (8 hours) with their refresh token (6 months); one renewal at a time per person. */
export class GitHubTokens {
  private readonly inflight = new Map<string, Promise<GitHubIdentity | undefined>>();
  constructor(
    private readonly directory: Directory,
    private readonly app: GitHubAppConfig,
    private readonly http: typeof fetch = fetch,
  ) {}

  async identity(userId: string): Promise<GitHubIdentity | undefined> {
    const user = this.directory.user(userId);
    const t = this.directory.gitHubTokens(userId);
    if (!user || !t) return undefined;
    const now = Date.now();
    if (!t.accessExpiresAt || t.accessExpiresAt - 10 * 60_000 > now) return { token: t.access, host: 'github.com', login: user.login, expiresAt: t.accessExpiresAt };
    if (!t.refresh || (t.refreshExpiresAt && t.refreshExpiresAt < now)) return undefined;
    let p = this.inflight.get(userId);
    if (!p) {
      p = this.refresh(userId, user.login, t.refresh).finally(() => this.inflight.delete(userId));
      this.inflight.set(userId, p);
    }
    return p;
  }

  private async refresh(userId: string, login: string, refresh: string): Promise<GitHubIdentity | undefined> {
    const res = await this.http(new URL('/login/oauth/access_token', this.app.webUrl), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: 'refresh_token', refresh_token: refresh }),
    }).catch(() => undefined);
    const tok = (await res?.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number } | undefined;
    if (!tok?.access_token) return undefined;
    const now = Date.now();
    this.directory.saveGitHubTokens(userId, { access: tok.access_token, ...(tok.expires_in ? { accessExpiresAt: now + tok.expires_in * 1000 } : {}), refresh: tok.refresh_token ?? refresh, ...(tok.refresh_token_expires_in ? { refreshExpiresAt: now + tok.refresh_token_expires_in * 1000 } : {}) });
    return { token: tok.access_token, host: 'github.com', login, ...(tok.expires_in ? { expiresAt: now + tok.expires_in * 1000 } : {}) };
  }
}

/** A workspace's secrets, sealed in the directory. */
export class WorkspaceSecrets implements SecretStore {
  constructor(
    private readonly directory: Directory,
    private readonly workspaceId: string,
  ) {}
  async available() {
    return { ok: true, message: 'Secrets are encrypted per workspace.' };
  }
  async get(name: Parameters<SecretStore['get']>[0]) {
    return this.directory.secretOf(this.workspaceId, name);
  }
  async set(name: Parameters<SecretStore['set']>[0], value: string) {
    this.directory.setSecret(this.workspaceId, name, value);
  }
  async delete(name: Parameters<SecretStore['delete']>[0]) {
    this.directory.deleteSecret(this.workspaceId, name);
  }
}

const NO_LOCAL_SIGN_IN = 'In the web app, Copilot uses the GitHub account you signed in with. To use your own plan here, choose "Use my Copilot plan".';

/**
 * Copilot accounts in a hosted workspace: the member whose plan it uses. Signing in happens on the
 * web app's own GitHub sign-in; choosing whose plan is a separate, signed-in action of the member.
 */
export class WorkspaceAccounts implements CopilotAccounts {
  constructor(
    private readonly directory: Directory,
    private readonly workspaceId: string,
    private readonly tokens: GitHubTokens,
  ) {}
  async state(): Promise<AccountState> {
    const userId = this.directory.copilotUser(this.workspaceId);
    const user = userId ? this.directory.user(userId) : undefined;
    const id = userId ? await this.tokens.identity(userId) : undefined;
    if (!user) return { signedIn: false, accounts: [], providers: [] };
    const active = { id: user.id, login: user.login, host: 'github.com', active: true, source: 'copilot' as const };
    return { signedIn: Boolean(id), active, accounts: [active], providers: [], ...(id ? {} : { error: `${user.name}'s GitHub sign-in has expired. They need to sign in to Tandem again.` }) };
  }
  async begin(): Promise<{ flowId: string; step: SignInStep }> {
    throw new Error(NO_LOCAL_SIGN_IN);
  }
  async advance(): Promise<SignInStep> {
    return { kind: 'error', message: NO_LOCAL_SIGN_IN };
  }
  async finishWithUrl(): Promise<SignInStep> {
    return { kind: 'error', message: NO_LOCAL_SIGN_IN };
  }
  async cancel(): Promise<void> {}
  async signInWithToken(): Promise<{ login?: string; host: string; saved: boolean }> {
    throw new Error(NO_LOCAL_SIGN_IN);
  }
  async switchTo(): Promise<void> {
    throw new Error(NO_LOCAL_SIGN_IN);
  }
  async signOut(): Promise<void> {
    throw new Error('To stop using your plan here, another member chooses "Use my Copilot plan", or you leave the workspace.');
  }
  async tokenFor(host: string): Promise<string | undefined> {
    if (host !== 'github.com') return undefined;
    const userId = this.directory.copilotUser(this.workspaceId);
    return userId ? (await this.tokens.identity(userId))?.token : undefined;
  }
  async identity(): Promise<GitHubIdentity | undefined> {
    const userId = this.directory.copilotUser(this.workspaceId);
    return userId ? this.tokens.identity(userId) : undefined;
  }
}
