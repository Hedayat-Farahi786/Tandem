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

/** A work Copilot account (a company's GitHub, or another github.com account), kept for the workspace. */
interface WorkAccount {
  host: string;
  login?: string | undefined;
  token: string;
}

const hostOf = (h: string) => h.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase() || 'github.com';
const apiOf = (host: string) => (host === 'github.com' ? 'https://api.github.com' : `https://api.${host}`);

/**
 * Copilot accounts in a hosted workspace. By default Copilot runs on the plan of a member, through
 * their sign-in to Tandem. When that plan isn't the one to use (Copilot from work, on a company's
 * GitHub), a member signs in to their work account with a code, right in the browser: its token is
 * kept sealed for this workspace and Copilot works as that account until it is disconnected.
 */
export class WorkspaceAccounts implements CopilotAccounts {
  private signIn: CopilotAccounts | undefined;
  constructor(
    private readonly directory: Directory,
    private readonly workspaceId: string,
    private readonly tokens: GitHubTokens,
    private readonly secrets: SecretStore = new WorkspaceSecrets(directory, workspaceId),
    private readonly http: typeof fetch = fetch,
  ) {}

  /** The runtime's code sign-in, once the workspace's runtime exists. */
  useCodeSignIn(signIn: CopilotAccounts) {
    this.signIn = signIn;
  }

  private async work(): Promise<WorkAccount | undefined> {
    try {
      const v = await this.secrets.get('copilot-work');
      return v ? (JSON.parse(v) as WorkAccount) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A code sign-in finished: keep the work account, named as its GitHub names it. */
  async keepWork(host: string, token: string): Promise<{ login?: string; host: string; saved: boolean }> {
    const h = hostOf(host);
    const me = await this.http(`${apiOf(h)}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tandem' } })
      .then((r): Promise<{ login?: string }> | { login?: string } => (r.ok ? (r.json() as Promise<{ login?: string }>) : {}))
      .catch((): { login?: string } => ({}));
    await this.secrets.set('copilot-work', JSON.stringify({ host: h, ...(me.login ? { login: me.login } : {}), token } satisfies WorkAccount));
    return { host: h, ...(me.login ? { login: me.login } : {}), saved: true };
  }

  async state(): Promise<AccountState> {
    const providers = this.signIn ? [{ kind: 'proxima' as const, label: "Your company's GitHub", available: true }, { kind: 'githubDotCom' as const, label: 'Another GitHub.com account', available: true }] : [];
    const work = await this.work();
    if (work) {
      const active = { id: 'work', login: work.login ?? 'Work account', host: work.host, active: true, source: 'copilot' as const };
      return { signedIn: true, active, accounts: [active], providers };
    }
    const userId = await this.directory.copilotUser(this.workspaceId);
    const user = userId ? await this.directory.user(userId) : undefined;
    const id = userId ? await this.tokens.identity(userId) : undefined;
    if (!user) return { signedIn: false, accounts: [], providers };
    const active = { id: user.id, login: user.login, host: 'github.com', active: true, source: 'copilot' as const };
    return { signedIn: Boolean(id), active, accounts: [active], providers, ...(id ? {} : { error: `${user.name}'s GitHub sign-in has expired. They need to sign in to Tandem again.` }) };
  }
  private need(): CopilotAccounts {
    if (!this.signIn) throw new Error('Signing in to a work account needs the Copilot runtime, which this Tandem does not run.');
    return this.signIn;
  }
  async begin(kind: Parameters<CopilotAccounts['begin']>[0]): Promise<{ flowId: string; step: SignInStep }> {
    if (kind === 'entra') throw new Error('Sign in with your company\'s GitHub instead.');
    // Always with a code: the browser may be anywhere, and nothing has to reach this server.
    return this.need().begin(kind, 'code');
  }
  async advance(flowId: string, input?: string): Promise<SignInStep> {
    return this.signIn ? this.signIn.advance(flowId, input) : { kind: 'error', message: 'This sign-in has expired. Start again.' };
  }
  async finishWithUrl(): Promise<SignInStep> {
    return { kind: 'error', message: 'Sign in with a code instead.' };
  }
  async cancel(flowId: string): Promise<void> {
    await this.signIn?.cancel(flowId);
  }
  async signInWithToken(): Promise<{ login?: string; host: string; saved: boolean }> {
    throw new Error('Sign in with a code instead: it works from any browser.');
  }
  async switchTo(): Promise<void> {
    throw new Error('Disconnect the work account to use a member\'s plan again.');
  }
  async signOut(id: string): Promise<void> {
    if (id === 'work') {
      await this.secrets.delete('copilot-work');
      return;
    }
    throw new Error('To stop using your plan here, another member chooses "Use my Copilot plan", or you leave the workspace.');
  }
  async tokenFor(host: string): Promise<string | undefined> {
    const work = await this.work();
    if (work && hostOf(host) === work.host) return work.token;
    if (hostOf(host) !== 'github.com') return undefined;
    const userId = await this.directory.copilotUser(this.workspaceId);
    return userId ? (await this.tokens.identity(userId))?.token : undefined;
  }
  async identity(): Promise<GitHubIdentity | undefined> {
    const work = await this.work();
    if (work) return { token: work.token, host: work.host, ...(work.login ? { login: work.login } : {}) };
    const userId = await this.directory.copilotUser(this.workspaceId);
    return userId ? this.tokens.identity(userId) : undefined;
  }
}
