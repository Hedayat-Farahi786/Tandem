/*
 * Connecting a Copilot account: Tandem drives the Copilot runtime's own sign-in (the same one the
 * Copilot CLI uses), so anyone can connect a personal plan (Free, Pro, Pro+) or a work account
 * (Business or Enterprise on github.com, GitHub Enterprise Cloud on *.ghe.com, or Microsoft Entra)
 * from the browser, without a terminal. Tokens stay with the runtime, which keeps them in the
 * system keychain; none of this ever returns a token.
 */

/** A provider the runtime offers for interactive sign-in. */
export interface SignInProvider {
  kind: 'githubDotCom' | 'proxima' | 'entra';
  label: string;
  available: boolean;
}

export interface CopilotAccount {
  /** Opaque id the runtime gives the account (for switching and signing out). */
  id: string;
  login: string;
  /** "github.com" or a GitHub Enterprise host such as "company.ghe.com". */
  host: string;
  active: boolean;
  /** Where the sign-in comes from: Tandem or the Copilot CLI ("copilot"), the GitHub CLI ("gh"), a token. */
  source: 'copilot' | 'gh' | 'token' | 'environment' | 'other';
}

export interface AccountState {
  signedIn: boolean;
  active?: CopilotAccount;
  accounts: CopilotAccount[];
  providers: SignInProvider[];
  error?: string;
}

/** One step of a sign-in as the page shows it. */
export type SignInStep =
  | { kind: 'open-url'; url: string }
  | { kind: 'input-required'; prompt: string }
  | { kind: 'awaiting' }
  | { kind: 'needs-interaction' }
  | { kind: 'choose-account'; accounts: Array<{ id: string; login: string; host: string }> }
  | { kind: 'done'; login?: string; host?: string }
  | { kind: 'error'; message: string };

export interface CopilotAccounts {
  state(): Promise<AccountState>;
  begin(kind: SignInProvider['kind']): Promise<{ flowId: string; step: SignInStep }>;
  advance(flowId: string, input?: string): Promise<SignInStep>;
  /** For a browser on another machine: the address the sign-in ended on, handed to the local callback. */
  finishWithUrl(flowId: string, url: string): Promise<SignInStep>;
  cancel(flowId: string): Promise<void>;
  /** A fine-grained token (github_pat_…) with the Copilot Requests permission, for machines without a browser. */
  signInWithToken(host: string, token: string): Promise<{ login?: string; host: string; saved: boolean }>;
  switchTo(id: string): Promise<void>;
  signOut(id: string): Promise<void>;
}

/** "https://company.ghe.com/" → "company.ghe.com"; github.com stays "github.com". */
export function hostName(host: string | undefined): string {
  const h = (host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return h || 'github.com';
}

/** The value Tandem keeps in Settings for a host: empty for github.com. */
export const settingsHost = (host: string | undefined) => (hostName(host) === 'github.com' ? '' : hostName(host));

const SOURCE: Record<string, CopilotAccount['source']> = { user: 'copilot', account: 'copilot', 'gh-cli': 'gh', token: 'token', env: 'environment' };

/* Structural views of the runtime's account API (experimental in the SDK). */
interface AuthInfoLike {
  type: string;
  host?: string;
  login?: string;
}
interface LoginStepLike {
  kind: string;
  url?: string;
  prompt?: string;
  message?: string;
  result?: { status: string; host?: string; login?: string; accounts?: Array<{ selectionId: string; host: string; login: string }> };
}
export interface AccountSessionLike {
  rpc: {
    accounts: {
      enumerate(p: { query: { kind: 'providers' } | { kind: 'accounts' } }): Promise<{ kind: string; items: unknown[] }>;
      set(p: { command: { kind: 'switchActive'; selectionId: string } | { kind: 'logout'; selectionId?: string } }): Promise<{ ok: boolean }>;
      login: {
        begin(p: { kind: string }): Promise<{ flowId: string; step: LoginStepLike }>;
        advance(p: { flowId: string; input?: string }): Promise<LoginStepLike>;
        cancel(p: { flowId: string }): Promise<void>;
      };
    };
  };
  disconnect(): Promise<void>;
}
export interface AccountClientLike {
  rpc: {
    account: {
      getAllUsers(): Promise<Array<{ authInfo: AuthInfoLike; selectionId?: string }>>;
      getCurrentAuth(): Promise<{ authInfo?: AuthInfoLike; authErrors?: string[] }>;
      login(p: { host: string; token: string; login?: string }): Promise<{ storedInVault: boolean }>;
    };
  };
  createSession(config: Record<string, unknown>): Promise<unknown>;
}

interface Flow {
  session: AccountSessionLike;
  /** The local address the browser returns to (http://127.0.0.1:<port>), once known. */
  callback?: string;
  pending?: Promise<LoginStepLike> | undefined;
  at: number;
}

const WAIT_MS = 20_000;
const FLOW_TTL = 15 * 60_000;

export class RuntimeAccounts implements CopilotAccounts {
  private readonly flows = new Map<string, Flow>();

  constructor(
    private readonly o: {
      client: () => Promise<AccountClientLike>;
      /** After a sign-in or switch: use this account's host from now on, and start the runtime afresh. */
      useHost: (host: string) => Promise<void>;
    },
  ) {}

  private async session(): Promise<AccountSessionLike> {
    // A bare session: no model, no tools, nothing allowed. It only carries the account calls.
    return (await (await this.o.client()).createSession({ onPermissionRequest: () => ({ kind: 'reject' }) })) as AccountSessionLike;
  }

  async state(): Promise<AccountState> {
    const client = await this.o.client();
    const [users, current] = await Promise.all([client.rpc.account.getAllUsers().catch(() => []), client.rpc.account.getCurrentAuth().catch(() => ({}) as { authInfo?: AuthInfoLike; authErrors?: string[] })]);
    const cur = current.authInfo;
    const accounts: CopilotAccount[] = users
      .filter((u) => u.authInfo.login && u.selectionId)
      .map((u) => ({
        id: u.selectionId!,
        login: u.authInfo.login!,
        host: hostName(u.authInfo.host),
        active: Boolean(cur && cur.login === u.authInfo.login && hostName(cur.host) === hostName(u.authInfo.host)),
        source: SOURCE[u.authInfo.type] ?? 'other',
      }));
    let providers: SignInProvider[] = [];
    const s = await this.session().catch(() => undefined);
    if (s) {
      try {
        const p = await s.rpc.accounts.enumerate({ query: { kind: 'providers' } });
        providers = (p.items as SignInProvider[]).filter((x) => x.kind === 'githubDotCom' || x.kind === 'proxima' || x.kind === 'entra');
      } finally {
        await s.disconnect().catch(() => undefined);
      }
    }
    const active = accounts.find((a) => a.active);
    return { signedIn: Boolean(active), ...(active ? { active } : {}), accounts, providers, ...(current.authErrors?.length ? { error: current.authErrors.join(' ') } : {}) };
  }

  private sweep() {
    for (const [id, f] of this.flows) if (Date.now() - f.at > FLOW_TTL) void this.cancel(id);
  }

  private async toStep(flowId: string, f: Flow, s: LoginStepLike): Promise<SignInStep> {
    f.at = Date.now();
    switch (s.kind) {
      case 'open-url': {
        try {
          const back = new URL(s.url!).searchParams.get('redirect_uri');
          if (back) f.callback = new URL(back).origin;
        } catch {
          // no callback known: the paste fallback stays off
        }
        return { kind: 'open-url', url: s.url! };
      }
      case 'input-required':
        return { kind: 'input-required', prompt: s.prompt ?? 'Enter your GitHub Enterprise host' };
      case 'awaiting':
      case 'needs-interaction':
        return { kind: s.kind };
      case 'completed': {
        const r = s.result;
        if (r?.status === 'needs-account-selection') return { kind: 'choose-account', accounts: (r.accounts ?? []).map((a) => ({ id: a.selectionId, login: a.login, host: hostName(a.host) })) };
        if (r?.status === 'needs-plaintext-consent' || r?.status === 'declined') {
          // Tokens go only in the system keychain: without one, Tandem does not save them in plain text.
          await this.cancel(flowId);
          return { kind: 'error', message: 'This computer has no system keychain to keep the sign-in safe, so it was not saved. Set up the keychain (on Linux, GNOME Keyring or KWallet) and sign in again.' };
        }
        await this.close(flowId);
        if (r?.host) await this.o.useHost(r.host);
        return { kind: 'done', ...(r?.login ? { login: r.login } : {}), ...(r?.host ? { host: hostName(r.host) } : {}) };
      }
      default:
        await this.close(flowId);
        return { kind: 'error', message: s.message ?? 'The sign-in did not finish.' };
    }
  }

  async begin(kind: SignInProvider['kind']): Promise<{ flowId: string; step: SignInStep }> {
    this.sweep();
    const session = await this.session();
    try {
      const b = await session.rpc.accounts.login.begin({ kind });
      const f: Flow = { session, at: Date.now() };
      this.flows.set(b.flowId, f);
      return { flowId: b.flowId, step: await this.toStep(b.flowId, f, b.step) };
    } catch (err) {
      await session.disconnect().catch(() => undefined);
      throw err;
    }
  }

  /** Waits up to 20 seconds for the next step (the browser coming back can take a while); asks again if still waiting. */
  async advance(flowId: string, input?: string): Promise<SignInStep> {
    const f = this.flows.get(flowId);
    if (!f) return { kind: 'error', message: 'This sign-in has expired. Start again.' };
    if (input !== undefined || !f.pending) {
      f.pending = f.session.rpc.accounts.login.advance({ flowId, ...(input !== undefined ? { input } : {}) });
      f.pending.catch(() => undefined);
    }
    const next = await Promise.race([f.pending.then((s) => ({ s }), (e: unknown) => ({ e })), new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS))]);
    if (!next) return { kind: 'awaiting' };
    f.pending = undefined;
    if ('e' in next) {
      await this.close(flowId);
      return { kind: 'error', message: String((next.e as Error)?.message ?? next.e).replace(/^Request \S+ failed with message:\s*/, '') };
    }
    return this.toStep(flowId, f, next.s);
  }

  async finishWithUrl(flowId: string, url: string): Promise<SignInStep> {
    const f = this.flows.get(flowId);
    if (!f?.callback) return { kind: 'error', message: 'This sign-in has expired. Start again.' };
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return { kind: 'error', message: 'That is not an address. Copy the whole address from the browser tab that could not load.' };
    }
    // Only ever the runtime's own local callback for this sign-in: nothing else is fetched.
    const expected = new URL(f.callback);
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname) || u.port !== expected.port || !u.searchParams.get('code')) {
      return { kind: 'error', message: 'That address is not the one this sign-in returns to. Copy the address of the tab that opened after you approved, starting with http://127.0.0.1.' };
    }
    await fetch(`${expected.origin}${u.pathname}${u.search}`).catch(() => undefined);
    return this.advance(flowId);
  }

  private async close(flowId: string) {
    const f = this.flows.get(flowId);
    this.flows.delete(flowId);
    await f?.session.disconnect().catch(() => undefined);
  }

  async cancel(flowId: string): Promise<void> {
    const f = this.flows.get(flowId);
    if (f) await f.session.rpc.accounts.login.cancel({ flowId }).catch(() => undefined);
    await this.close(flowId);
  }

  async signInWithToken(host: string, token: string): Promise<{ login?: string; host: string; saved: boolean }> {
    const t = token.trim();
    if (/^ghp_/.test(t)) throw new Error('Classic tokens (ghp_…) do not work with Copilot. Create a fine-grained token (github_pat_…) with the "Copilot Requests" permission.');
    if (!/^(github_pat_|gho_|ghu_)/.test(t)) throw new Error('That does not look like a GitHub token. Use a fine-grained token (github_pat_…).');
    const h = hostName(host);
    const client = await this.o.client();
    const r = await client.rpc.account.login({ host: `https://${h}`, token: t });
    await this.o.useHost(h);
    const cur = await (await this.o.client()).rpc.account.getCurrentAuth().catch(() => ({}) as { authInfo?: AuthInfoLike });
    return { host: h, saved: r.storedInVault, ...(cur.authInfo?.login ? { login: cur.authInfo.login } : {}) };
  }

  async switchTo(id: string): Promise<void> {
    const target = (await this.state()).accounts.find((a) => a.id === id);
    if (!target) throw new Error('That account is no longer signed in.');
    const s = await this.session();
    try {
      await s.rpc.accounts.set({ command: { kind: 'switchActive', selectionId: id } });
    } finally {
      await s.disconnect().catch(() => undefined);
    }
    await this.o.useHost(target.host);
  }

  async signOut(id: string): Promise<void> {
    const s = await this.session();
    try {
      await s.rpc.accounts.set({ command: { kind: 'logout', selectionId: id } });
    } finally {
      await s.disconnect().catch(() => undefined);
    }
  }
}

/** Test mode: a pretend account and a sign-in that completes at once, so the screens can be shown and tested. */
export class ScriptedAccounts implements CopilotAccounts {
  private accounts: CopilotAccount[] = [{ id: 'a1', login: 'octocat', host: 'github.com', active: true, source: 'copilot' }];
  private next = 0;
  async state(): Promise<AccountState> {
    const active = this.accounts.find((a) => a.active);
    return { signedIn: Boolean(active), ...(active ? { active } : {}), accounts: this.accounts, providers: [
      { kind: 'githubDotCom', label: 'GitHub.com', available: true },
      { kind: 'proxima', label: 'GitHub Enterprise Cloud (*.ghe.com)', available: true },
      { kind: 'entra', label: 'Your organization (Microsoft Entra)', available: false },
    ] };
  }
  private hostFor = new Map<string, string>();
  async begin(kind: SignInProvider['kind']) {
    const flowId = `f${++this.next}`;
    if (kind === 'proxima') return { flowId, step: { kind: 'input-required' as const, prompt: 'Enter your GitHub Enterprise Cloud host (e.g. https://your-tenant.ghe.com)' } };
    this.hostFor.set(flowId, 'github.com');
    return { flowId, step: { kind: 'open-url' as const, url: 'https://github.com/login/oauth/authorize?client_id=test' } };
  }
  async advance(flowId: string, input?: string): Promise<SignInStep> {
    if (input && !this.hostFor.has(flowId)) {
      this.hostFor.set(flowId, hostName(input));
      return { kind: 'open-url', url: `https://${hostName(input)}/login/oauth/authorize?client_id=test` };
    }
    const host = this.hostFor.get(flowId) ?? 'github.com';
    this.accounts = [...this.accounts.map((a) => ({ ...a, active: false })), { id: `a${this.accounts.length + 1}`, login: host === 'github.com' ? 'mona' : 'mona_work', host, active: true, source: 'copilot' }];
    return { kind: 'done', login: this.accounts.at(-1)!.login, host };
  }
  async finishWithUrl(flowId: string): Promise<SignInStep> {
    return this.advance(flowId);
  }
  async cancel(): Promise<void> {}
  async signInWithToken(host: string): Promise<{ login?: string; host: string; saved: boolean }> {
    return { login: 'mona', host: hostName(host), saved: true };
  }
  async switchTo(id: string): Promise<void> {
    this.accounts = this.accounts.map((a) => ({ ...a, active: a.id === id }));
  }
  async signOut(id: string): Promise<void> {
    this.accounts = this.accounts.filter((a) => a.id !== id);
  }
}
