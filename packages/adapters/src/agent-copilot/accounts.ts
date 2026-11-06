/*
 * Connecting a Copilot account: Tandem drives the Copilot runtime's own sign-in (the same one the
 * Copilot CLI uses), so anyone can connect a personal plan (Free, Pro, Pro+) or a work account
 * (Business or Enterprise on github.com, GitHub Enterprise Cloud on *.ghe.com, or Microsoft Entra)
 * from the browser, without a terminal. Tokens stay with the runtime, which keeps them in the
 * system keychain; none of this ever returns a token.
 *
 * Two ways to sign in. With a code (the default): Tandem shows a short code, the person enters it at
 * GitHub's device page from any browser, and nothing has to reach this computer, so it works for a
 * company runner on a server as well as on a laptop. In the browser: GitHub sends the browser back to
 * the runtime's address on this computer (127.0.0.1), which only works when the browser is here too.
 */

/** How to sign in: a code entered at GitHub (works from any browser), or GitHub sending the browser back here. */
export type SignInMethod = 'code' | 'browser';

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
  /** Enter this code at the address (GitHub's device page), from any browser. */
  | { kind: 'device-code'; code: string; url: string; expiresAt: string }
  /** Signed in; `saved: false` when no keychain could keep it past a restart. */
  | { kind: 'done'; login?: string; host?: string; saved?: boolean }
  | { kind: 'error'; message: string };

export interface CopilotAccounts {
  state(): Promise<AccountState>;
  begin(kind: SignInProvider['kind'], method?: SignInMethod): Promise<{ flowId: string; step: SignInStep }>;
  advance(flowId: string, input?: string): Promise<SignInStep>;
  /** For a browser on another machine: the address the sign-in ended on, handed to the local callback. */
  finishWithUrl(flowId: string, url: string): Promise<SignInStep>;
  cancel(flowId: string): Promise<void>;
  /** A fine-grained token (github_pat_…) with the Copilot Requests permission, for machines without a browser. */
  signInWithToken(host: string, token: string): Promise<{ login?: string; host: string; saved: boolean }>;
  switchTo(id: string): Promise<void>;
  signOut(id: string): Promise<void>;
  /**
   * Server-side only: the token of the connected account for a GitHub host (the active one first),
   * which also reaches that account's repositories (the sign-in includes the repo scope).
   */
  tokenFor(host: string): Promise<string | undefined>;
}

/** "https://company.ghe.com/" → "company.ghe.com"; github.com stays "github.com". */
export function hostName(host: string | undefined): string {
  const h = (host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return h || 'github.com';
}

/** The value Tandem keeps in Settings for a host: empty for github.com. */
export const settingsHost = (host: string | undefined) => (hostName(host) === 'github.com' ? '' : hostName(host));

/** A sign-in Tandem keeps because the runtime could not (no system keychain on this computer). */
export interface KeptSignIn {
  host: string;
  login?: string | undefined;
  token: string;
}

/**
 * Sign-ins the runtime could not save, kept sealed by Tandem (in the keychain, or sealed with this
 * computer's key when there is none) and handed back to the runtime each time it starts.
 */
export function keptSignIns(store: { get(name: 'copilot-sign-ins'): Promise<string | undefined>; set(name: 'copilot-sign-ins', value: string): Promise<void>; delete(name: 'copilot-sign-ins'): Promise<void> }) {
  const list = async (): Promise<KeptSignIn[]> => {
    try {
      return JSON.parse((await store.get('copilot-sign-ins')) ?? '[]') as KeptSignIn[];
    } catch {
      return [];
    }
  };
  const save = async (all: KeptSignIn[]) => (all.length ? store.set('copilot-sign-ins', JSON.stringify(all)) : store.delete('copilot-sign-ins'));
  const same = (a: KeptSignIn, host: string, login?: string) => hostName(a.host) === hostName(host) && (!login || !a.login || a.login === login);
  return {
    list,
    async add(k: KeptSignIn) {
      await save([...(await list()).filter((a) => !same(a, k.host, k.login)), { ...k, host: hostName(k.host) }]);
    },
    async remove(host: string, login?: string) {
      await save((await list()).filter((a) => !same(a, host, login)));
    },
  };
}
export type KeptSignIns = ReturnType<typeof keptSignIns>;

/**
 * Hands the kept sign-ins back to a runtime that just started: each one it does not know yet, the
 * account on the active host last, so it is the one in use.
 */
export async function restoreSignIns(client: AccountClientLike, kept: KeptSignIns, activeHost: string | undefined, onError?: (host: string, err: unknown) => void): Promise<number> {
  const all = await kept.list();
  if (!all.length) return 0;
  const known = await client.rpc.account.getAllUsers().catch(() => []);
  const active = hostName(activeHost);
  const missing = all.filter((k) => !known.some((u) => hostName(u.authInfo.host) === hostName(k.host) && (!k.login || u.authInfo.login === k.login)));
  missing.sort((a, b) => Number(hostName(a.host) === active) - Number(hostName(b.host) === active));
  let n = 0;
  for (const k of missing) {
    try {
      await client.rpc.account.login({ host: `https://${hostName(k.host)}`, token: k.token, ...(k.login ? { login: k.login } : {}) });
      n++;
    } catch (err) {
      onError?.(k.host, err);
    }
  }
  return n;
}

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
      getAllUsers(): Promise<Array<{ authInfo: AuthInfoLike; selectionId?: string; token?: string }>>;
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
  /** Sign in with a code: once the runtime names its GitHub app, the device flow takes over. */
  wantCode?: boolean;
  code?: { origin: string; clientId: string; deviceCode: string; interval: number; nextAt: number; expiresAt: number; host: string };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WAIT_MS = 20_000;
const FLOW_TTL = 15 * 60_000;

export class RuntimeAccounts implements CopilotAccounts {
  private readonly flows = new Map<string, Flow>();

  constructor(
    private readonly o: {
      client: () => Promise<AccountClientLike>;
      /** After a sign-in or switch: use this account's host from now on, and start the runtime afresh. */
      useHost: (host: string) => Promise<void>;
      fetch?: Fetch;
      /** Where sign-ins go that the runtime cannot save itself (no keychain). */
      kept?: KeptSignIns;
    },
  ) {}

  /** A form POST to GitHub, answered in JSON. */
  private async form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    try {
      const res = await f(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) });
      return ((await res.json()) ?? {}) as Record<string, unknown>;
    } catch (err) {
      return { error: 'unreachable', error_description: String((err as Error)?.message ?? err) };
    }
  }

  /**
   * The runtime is about to send the browser to GitHub: instead, ask GitHub for a code for the same app
   * (its client and scopes, on the same host), and let the person enter it from wherever they are.
   */
  private async toDeviceCode(flowId: string, f: Flow, authorizeUrl: string): Promise<SignInStep> {
    let u: URL;
    try {
      u = new URL(authorizeUrl);
    } catch {
      await this.close(flowId);
      return { kind: 'error', message: 'The sign-in could not start. Try again.' };
    }
    const clientId = u.searchParams.get('client_id') ?? '';
    // The runtime's browser sign-in is not needed any more.
    await f.session.rpc.accounts.login.cancel({ flowId }).catch(() => undefined);
    await f.session.disconnect().catch(() => undefined);
    const r = await this.form(`${u.origin}/login/device/code`, { client_id: clientId, scope: u.searchParams.get('scope') ?? '' });
    if (typeof r.user_code !== 'string' || typeof r.device_code !== 'string') {
      this.flows.delete(flowId);
      return { kind: 'error', message: r.error === 'device_flow_disabled' ? "Signing in with a code isn't offered by this GitHub. Sign in through the browser instead." : 'GitHub did not give a code right now. Try again, or sign in through the browser.' };
    }
    // GitHub sets the pace (at least 5 seconds); asking faster only earns a slow_down.
    const interval = Number(r.interval ?? 5) * 1000;
    const expiresAt = Date.now() + Number(r.expires_in ?? 900) * 1000;
    f.code = { origin: u.origin, clientId, deviceCode: r.device_code, interval, nextAt: Date.now() + interval, expiresAt, host: u.host };
    f.at = Date.now();
    return { kind: 'device-code', code: r.user_code, url: typeof r.verification_uri === 'string' ? r.verification_uri : `${u.origin}/login/device`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Asks GitHub, at the pace it sets, whether the code was entered; waits up to 20 seconds per call. */
  private async pollCode(flowId: string, f: Flow): Promise<SignInStep> {
    const c = f.code!;
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end) {
      if (Date.now() > c.expiresAt) {
        this.flows.delete(flowId);
        return { kind: 'error', message: 'The code expired before it was entered. Start again.' };
      }
      const wait = c.nextAt - Date.now();
      if (wait > 0) await sleep(Math.min(wait, Math.max(0, end - Date.now())));
      if (Date.now() < c.nextAt) continue;
      const t = await this.form(`${c.origin}/login/oauth/access_token`, { client_id: c.clientId, device_code: c.deviceCode, grant_type: DEVICE_GRANT });
      c.nextAt = Date.now() + c.interval;
      f.at = Date.now();
      if (typeof t.access_token === 'string') {
        this.flows.delete(flowId);
        try {
          const r = await this.signInWithToken(c.host, t.access_token);
          return { kind: 'done', ...(r.login ? { login: r.login } : {}), host: r.host, saved: r.saved };
        } catch (err) {
          return { kind: 'error', message: String((err as Error)?.message ?? err).replace(/^Request \S+ failed with message:\s*/, '') };
        }
      }
      if (t.error === 'authorization_pending' || t.error === 'unreachable') continue;
      if (t.error === 'slow_down') {
        c.interval += 5000;
        c.nextAt = Date.now() + c.interval;
        continue;
      }
      this.flows.delete(flowId);
      return { kind: 'error', message: t.error === 'expired_token' ? 'The code expired before it was entered. Start again.' : t.error === 'access_denied' ? 'The sign-in was cancelled at GitHub.' : `GitHub did not finish the sign-in (${String(t.error ?? 'no answer')}). Start again.` };
    }
    return { kind: 'awaiting' };
  }

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
        if (f.wantCode && s.url) return this.toDeviceCode(flowId, f, s.url);
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
          // The runtime would keep this one in plain text: never. A code sign-in is kept sealed by Tandem.
          await this.cancel(flowId);
          return { kind: 'error', message: "This computer has no system keychain, so a browser sign-in can't be kept here. Sign in with a code instead: Tandem keeps that one safely." };
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

  async begin(kind: SignInProvider['kind'], method: SignInMethod = 'code'): Promise<{ flowId: string; step: SignInStep }> {
    this.sweep();
    const session = await this.session();
    try {
      const b = await session.rpc.accounts.login.begin({ kind });
      // Microsoft Entra signs in through its own broker; a code is for GitHub hosts.
      const f: Flow = { session, at: Date.now(), ...(method === 'code' && kind !== 'entra' ? { wantCode: true } : {}) };
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
    if (f.code) return this.pollCode(flowId, f);
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
    const cur = await client.rpc.account.getCurrentAuth().catch(() => ({}) as { authInfo?: AuthInfoLike });
    const login = cur.authInfo && hostName(cur.authInfo.host) === h ? cur.authInfo.login : undefined;
    // No keychain for the runtime: Tandem keeps the sign-in, sealed, and hands it back on each start.
    let saved = r.storedInVault;
    if (!saved && this.o.kept) {
      await this.o.kept.add({ host: h, login, token: t });
      saved = true;
    }
    await this.o.useHost(h);
    return { host: h, saved, ...(login ? { login } : {}) };
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

  async tokenFor(host: string): Promise<string | undefined> {
    const h = hostName(host);
    const client = await this.o.client();
    const [users, current] = await Promise.all([client.rpc.account.getAllUsers().catch(() => []), client.rpc.account.getCurrentAuth().catch(() => ({}) as { authInfo?: AuthInfoLike })]);
    const here = users.filter((u) => u.token && hostName(u.authInfo.host) === h);
    const active = here.find((u) => current.authInfo && u.authInfo.login === current.authInfo.login);
    return (active ?? here[0])?.token;
  }

  async signOut(id: string): Promise<void> {
    const gone = (await (await this.o.client()).rpc.account.getAllUsers().catch(() => [])).find((u) => u.selectionId === id);
    const s = await this.session();
    try {
      await s.rpc.accounts.set({ command: { kind: 'logout', selectionId: id } });
    } finally {
      await s.disconnect().catch(() => undefined);
    }
    if (gone && this.o.kept) await this.o.kept.remove(gone.authInfo.host ?? 'github.com', gone.authInfo.login);
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
  private byCode = new Set<string>();
  private codeStep = (host: string): SignInStep => ({ kind: 'device-code', code: 'WDJB-MJHT', url: `https://${host}/login/device`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  async begin(kind: SignInProvider['kind'], method: SignInMethod = 'code'): Promise<{ flowId: string; step: SignInStep }> {
    const flowId = `f${++this.next}`;
    if (method === 'code') this.byCode.add(flowId);
    if (kind === 'proxima') return { flowId, step: { kind: 'input-required' as const, prompt: 'Enter your GitHub Enterprise Cloud host (e.g. https://your-tenant.ghe.com)' } };
    this.hostFor.set(flowId, 'github.com');
    return { flowId, step: method === 'code' ? this.codeStep('github.com') : { kind: 'open-url' as const, url: 'https://github.com/login/oauth/authorize?client_id=test' } };
  }
  async advance(flowId: string, input?: string): Promise<SignInStep> {
    if (input && !this.hostFor.has(flowId)) {
      this.hostFor.set(flowId, hostName(input));
      return this.byCode.has(flowId) ? this.codeStep(hostName(input)) : { kind: 'open-url', url: `https://${hostName(input)}/login/oauth/authorize?client_id=test` };
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
  async tokenFor(): Promise<string | undefined> {
    return undefined;
  }
}
