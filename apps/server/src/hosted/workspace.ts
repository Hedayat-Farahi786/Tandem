import type { AccountState, CopilotAccounts, GitHubIdentity, SecretStore, SignInStep } from '@tandem/adapters';
import type { Directory, GitHubTokens as GitHubTokenSet } from './directory.js';

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

/**
 * Renews GitHub App user tokens (8 hours) with their refresh token (6 months). GitHub replaces the
 * refresh token on every use, so a renewal runs once at a time per person, across replicas too.
 */
export class GitHubTokens {
  constructor(
    private readonly directory: Directory,
    private readonly app: GitHubAppConfig,
    private readonly http: typeof fetch = fetch,
  ) {}

  private fresh = (t: { accessExpiresAt?: number | undefined }) => !t.accessExpiresAt || t.accessExpiresAt - 10 * 60_000 > Date.now();

  async identity(userId: string): Promise<GitHubIdentity | undefined> {
    const user = await this.directory.user(userId);
    const t = await this.directory.gitHubTokens(userId);
    if (!user || !t) return undefined;
    if (this.fresh(t)) return { token: t.access, host: 'github.com', login: user.login, expiresAt: t.accessExpiresAt };
    const renewed = await this.directory.renewGitHubTokens(userId, async (current) => {
      // Another replica may have renewed it while this one waited for the lock.
      if (!current || this.fresh(current)) return undefined;
      if (!current.refresh || (current.refreshExpiresAt && current.refreshExpiresAt < Date.now())) return undefined;
      return this.refresh(current.refresh);
    });
    return renewed && this.fresh(renewed) ? { token: renewed.access, host: 'github.com', login: user.login, expiresAt: renewed.accessExpiresAt } : undefined;
  }

  private async refresh(refresh: string): Promise<GitHubTokenSet | undefined> {
    const res = await this.http(new URL('/login/oauth/access_token', this.app.webUrl), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: 'refresh_token', refresh_token: refresh }),
    }).catch(() => undefined);
    const tok = (await res?.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number } | undefined;
    if (!tok?.access_token) return undefined;
    const now = Date.now();
    return { access: tok.access_token, ...(tok.expires_in ? { accessExpiresAt: now + tok.expires_in * 1000 } : {}), refresh: tok.refresh_token ?? refresh, ...(tok.refresh_token_expires_in ? { refreshExpiresAt: now + tok.refresh_token_expires_in * 1000 } : {}) };
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
    await this.directory.setSecret(this.workspaceId, name, value);
  }
  async delete(name: Parameters<SecretStore['delete']>[0]) {
    await this.directory.deleteSecret(this.workspaceId, name);
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
    const userId = await this.directory.copilotUser(this.workspaceId);
    const user = userId ? await this.directory.user(userId) : undefined;
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
    const userId = await this.directory.copilotUser(this.workspaceId);
    return userId ? (await this.tokens.identity(userId))?.token : undefined;
  }
  async identity(): Promise<GitHubIdentity | undefined> {
    const userId = await this.directory.copilotUser(this.workspaceId);
    return userId ? this.tokens.identity(userId) : undefined;
  }
}
