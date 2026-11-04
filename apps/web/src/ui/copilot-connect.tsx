import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Building2, Check, CheckCircle2, ChevronDown, KeyRound, LogOut, Plus } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { BrandLogo } from './brands';
import { isHosted } from './account-menu';
import { Button, Callout, Dialog, Input, Spinner, cx, useToast } from './kit';

/*
 * Connecting GitHub Copilot, for anyone: a personal plan (Free, Pro, Pro+) or a work account
 * (Business or Enterprise on github.com, or GitHub Enterprise Cloud on its own *.ghe.com host).
 * Sign-in happens in the browser through Copilot's own sign-in; Tandem never sees a password, and
 * the sign-in is kept in the system keychain.
 */

type ProviderKind = 'githubDotCom' | 'proxima' | 'entra';
interface Account {
  id: string;
  login: string;
  host: string;
  active: boolean;
  source: 'copilot' | 'gh' | 'token' | 'environment' | 'other';
}
export interface AccountState {
  signedIn: boolean;
  active?: Account;
  accounts: Account[];
  providers: Array<{ kind: ProviderKind; label: string; available: boolean }>;
  error?: string;
  host: string;
}
type Step =
  | { kind: 'open-url'; url: string }
  | { kind: 'input-required'; prompt: string }
  | { kind: 'awaiting' }
  | { kind: 'needs-interaction' }
  | { kind: 'choose-account'; accounts: Array<{ id: string; login: string; host: string }> }
  | { kind: 'done'; login?: string; host?: string }
  | { kind: 'error'; message: string };

const SOURCE: Record<Account['source'], string> = {
  copilot: 'Signed in with Copilot',
  gh: 'From the GitHub CLI',
  token: 'With a token',
  environment: 'From an environment variable',
  other: 'Signed in',
};

export function useCopilotAccounts() {
  return useQuery({ queryKey: ['copilot-accounts'], queryFn: () => api<AccountState>('/api/copilot/accounts'), staleTime: 30_000 });
}

/** After a change of account: the models, prices and checks belong to the new one. */
function useRefreshAfterSwitch() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['copilot-accounts', 'bootstrap', 'settings', 'models', 'doctor']) void qc.invalidateQueries({ queryKey: [key] });
  };
}

const Initials = ({ login, size = 36 }: { login: string; size?: number }) => (
  <span aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} className="grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent-text uppercase">
    {login.replace(/[_-].*$/, '').slice(0, 2)}
  </span>
);

/** The ways to sign in, as buttons: github.com first, then a company host, then Entra when offered. */
function SignInButtons({ state, onPick, compact }: { state?: AccountState | undefined; onPick: (k: ProviderKind) => void; compact?: boolean }) {
  const entra = state?.providers.find((p) => p.kind === 'entra' && p.available);
  return (
    <div className={cx('grid gap-2', !compact && 'sm:grid-cols-2')}>
      <button type="button" onClick={() => onPick('githubDotCom')} className="group flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 text-left shadow-[0_0_0_1px_var(--border)] transition-[box-shadow,background-color] duration-150 hover:bg-surface-2 hover:shadow-[0_0_0_1px_var(--border-strong)]">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-fg text-bg">
          <BrandLogo brand="github" size={18} className="invert dark:invert-0" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium">GitHub.com</span>
          <span className="block text-[12px] leading-snug text-muted">Personal plans, and Business or Enterprise on github.com</span>
        </span>
        <ArrowUpRight aria-hidden className="size-4 shrink-0 text-faint transition-colors group-hover:text-fg" />
      </button>
      <button type="button" onClick={() => onPick('proxima')} className="group flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 text-left shadow-[0_0_0_1px_var(--border)] transition-[box-shadow,background-color] duration-150 hover:bg-surface-2 hover:shadow-[0_0_0_1px_var(--border-strong)]">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg shadow-[0_0_0_1px_var(--border)]">
          <Building2 aria-hidden className="size-[18px]" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium">Your company's GitHub</span>
          <span className="block text-[12px] leading-snug text-muted">GitHub Enterprise Cloud on its own address (*.ghe.com)</span>
        </span>
        <ArrowUpRight aria-hidden className="size-4 shrink-0 text-faint transition-colors group-hover:text-fg" />
      </button>
      {entra && (
        <button type="button" onClick={() => onPick('entra')} className="group flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 text-left shadow-[0_0_0_1px_var(--border)] transition-[box-shadow,background-color] duration-150 hover:bg-surface-2 hover:shadow-[0_0_0_1px_var(--border-strong)] sm:col-span-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 shadow-[0_0_0_1px_var(--border)]">
            <BrandLogo brand="microsoft" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium">{entra.label}</span>
            <span className="block text-[12px] leading-snug text-muted">Sign in with your work Microsoft account</span>
          </span>
          <ArrowUpRight aria-hidden className="size-4 shrink-0 text-faint transition-colors group-hover:text-fg" />
        </button>
      )}
    </div>
  );
}

/** The sign-in, step by step: the company's address if needed, then GitHub in the browser, then done. */
function SignInDialog({ kind, onClose }: { kind: ProviderKind; onClose: (connected: boolean) => void }) {
  const [flow, setFlow] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [host, setHost] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const live = useRef(true);
  const refresh = useRefreshAfterSwitch();

  const begin = async () => {
    setBusy(true);
    setStep(null);
    setOpened(false);
    try {
      const r = await post<{ flowId: string; step: Step }>('/api/copilot/sign-in', { kind });
      setFlow(r.flowId);
      setStep(r.step);
    } catch (err) {
      setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    live.current = true;
    void begin();
    return () => {
      live.current = false;
    };
    // Once per dialog.
  }, []);

  // While GitHub is open in the browser, keep asking for the next step.
  const waiting = step?.kind === 'awaiting' || step?.kind === 'needs-interaction' || (step?.kind === 'open-url' && opened);
  useEffect(() => {
    if (!flow || !waiting) return;
    let stop = false;
    void (async () => {
      while (!stop && live.current) {
        const next = await post<Step>(`/api/copilot/sign-in/${flow}/next`).catch((err: unknown) => ({ kind: 'error' as const, message: err instanceof Error ? err.message : String(err) }));
        if (stop || !live.current) return;
        if (next.kind !== 'awaiting' && next.kind !== 'needs-interaction') {
          setStep(next);
          if (next.kind === 'done') refresh();
          return;
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [flow, waiting]);

  const send = async (input: string) => {
    if (!flow) return;
    setBusy(true);
    try {
      const next = await post<Step>(`/api/copilot/sign-in/${flow}/next`, { input });
      setStep(next);
      if (next.kind === 'done') refresh();
    } catch (err) {
      setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const finishWithUrl = async () => {
    if (!flow || !pasted.trim()) return;
    setBusy(true);
    try {
      const next = await post<Step>(`/api/copilot/sign-in/${flow}/url`, { url: pasted.trim() });
      setStep(next);
      if (next.kind === 'done') refresh();
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    const done = step?.kind === 'done';
    if (flow && !done) void del(`/api/copilot/sign-in/${flow}`).catch(() => undefined);
    onClose(done);
  };

  const title = kind === 'proxima' ? "Sign in to your company's GitHub" : kind === 'entra' ? 'Sign in with Microsoft' : 'Sign in to GitHub';
  return (
    <Dialog open onClose={close} title={title} description="Use the account that has your Copilot plan. Tandem never sees your password; the sign-in is kept in your system keychain.">
      <div className="min-h-[148px]">
        {!step || (busy && step.kind !== 'open-url') ? (
          <p className="flex items-center gap-2.5 py-6 text-[13.5px] text-muted">
            <Spinner /> Preparing the sign-in…
          </p>
        ) : step.kind === 'input-required' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (host.trim()) void send(host.trim().replace(/^(?!https?:\/\/)/, 'https://'));
            }}
            className="flex flex-col gap-3"
          >
            <Input id="ghe-host" label="Your company's GitHub address" autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="your-company.ghe.com" help="The address you open GitHub at for work, for example acme.ghe.com." />
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={!host.trim()} busy={busy}>
                Continue
              </Button>
            </div>
          </form>
        ) : step.kind === 'open-url' || step.kind === 'awaiting' || step.kind === 'needs-interaction' ? (
          <div className="flex flex-col gap-4">
            <ol className="flex flex-col gap-3 text-[13.5px]">
              <li className="flex gap-3">
                <span className={cx('grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold', opened || step.kind !== 'open-url' ? 'bg-ok text-white' : 'bg-accent-soft text-accent-text')}>{opened || step.kind !== 'open-url' ? <Check aria-hidden className="size-3.5" strokeWidth={3} /> : 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Approve in your browser</p>
                  <p className="text-[12.5px] text-muted">GitHub opens in a new tab. Check the account, then choose Authorize.</p>
                  {step.kind === 'open-url' && (
                    <a href={step.url} target="_blank" rel="noreferrer" onClick={() => setOpened(true)} className="mt-2.5 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-[13.5px] font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover">
                      <BrandLogo brand="github" size={15} className="invert dark:invert-0" />
                      {opened ? 'Open GitHub again' : 'Open GitHub'}
                    </a>
                  )}
                </div>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] font-semibold text-muted">2</span>
                <div className="min-w-0 flex-1">
                  <p className={cx('font-medium', !(opened || step.kind !== 'open-url') && 'text-muted')}>Come back here</p>
                  {(opened || step.kind !== 'open-url') && (
                    <p role="status" className="mt-0.5 flex items-center gap-2 text-[12.5px] text-muted">
                      <Spinner className="size-3.5" /> Waiting for GitHub…
                    </p>
                  )}
                </div>
              </li>
            </ol>
            {(opened || step.kind !== 'open-url') && (
              <details className="group rounded-xl bg-surface-2/70 px-3.5 py-2.5 text-[12.5px] text-muted">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-fg [&::-webkit-details-marker]:hidden">
                  <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
                  The browser says it can't reach 127.0.0.1?
                </summary>
                <p className="mt-2">That happens when Tandem runs on another computer. Copy the whole address of that tab and paste it here.</p>
                <div className="mt-2 flex gap-2">
                  <input aria-label="Address of the tab" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://127.0.0.1:…/callback?code=…" className="h-9 min-w-0 flex-1 rounded-lg bg-surface px-3 font-mono text-[12px] text-fg shadow-[0_0_0_1px_var(--border)] outline-none focus:shadow-[0_0_0_2px_var(--accent)]" />
                  <Button size="sm" onClick={() => void finishWithUrl()} disabled={!pasted.trim()} busy={busy}>
                    Finish
                  </Button>
                </div>
              </details>
            )}
          </div>
        ) : step.kind === 'choose-account' ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13.5px] text-muted">Which account should Tandem use?</p>
            {step.accounts.map((a) => (
              <button key={a.id} type="button" onClick={() => void send(a.id)} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left shadow-[0_0_0_1px_var(--border)] transition-colors hover:bg-surface-2">
                <Initials login={a.login} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{a.login}</span>
                  <span className="block truncate text-[12px] text-muted">{a.host}</span>
                </span>
              </button>
            ))}
          </div>
        ) : step.kind === 'done' ? (
          <div className="flex animate-in flex-col items-center gap-2 py-4 text-center">
            <CheckCircle2 aria-hidden className="size-10 text-ok" strokeWidth={1.6} />
            <p className="text-[15px] font-semibold">Copilot is connected</p>
            <p className="text-[13px] text-muted">
              {step.login ? (
                <>
                  Signed in as <span className="font-medium text-fg">{step.login}</span>
                  {step.host && step.host !== 'github.com' ? ` on ${step.host}` : ''}.
                </>
              ) : (
                'You are signed in.'
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Callout tone="danger" title="The sign-in didn't finish">
              {step.message}
            </Callout>
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        {step?.kind === 'error' && (
          <Button variant="primary" onClick={() => void begin()} busy={busy}>
            Try again
          </Button>
        )}
        <Button variant={step?.kind === 'done' ? 'primary' : 'secondary'} onClick={close}>
          {step?.kind === 'done' ? 'Done' : 'Cancel'}
        </Button>
      </div>
    </Dialog>
  );
}

/** For a machine without a browser: a fine-grained token with the Copilot Requests permission. */
function TokenDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshAfterSwitch();
  const [host, setHost] = useState('github.com');
  const [token, setToken] = useState('');
  const h = host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'github.com';
  const save = useMutation({
    mutationFn: () => post<{ login?: string; host: string; saved: boolean }>('/api/copilot/token', { host: h, token: token.trim() }),
    onSuccess: (r) => {
      refresh();
      toast(r.saved ? `Copilot is connected${r.login ? ` as ${r.login}` : ''}.` : 'Connected for now, but the token could not be saved in a keychain: you will need it again after a restart.', r.saved ? 'ok' : 'warn');
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Connect with a token"
      description="For a computer without a browser. The token goes straight to Copilot's keychain; Tandem doesn't keep a copy."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={KeyRound} busy={save.isPending} disabled={token.trim().length < 20} onClick={() => save.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] text-muted marker:text-faint">
          <li>
            On{' '}
            <a className="font-medium text-accent-text underline-offset-2 hover:underline" href={`https://${h}/settings/personal-access-tokens/new`} target="_blank" rel="noreferrer">
              {h} → Fine-grained tokens
            </a>
            , create a token owned by your own account.
          </li>
          <li>
            Under <span className="text-fg">Account permissions</span>, set <span className="text-fg">Copilot Requests</span> to Read-only.
          </li>
          <li>Paste it here. Classic tokens (ghp_…) don't work with Copilot.</li>
        </ol>
        <Input id="tok-host" label="GitHub address" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" help="github.com, or your company's address such as acme.ghe.com." />
        <Input id="tok-value" label="Token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
        {save.isError && (
          <Callout tone="danger" title="Couldn't connect">
            {(save.error as Error).message}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The Copilot account card: who Tandem works as, other signed-in accounts to switch to, and the
 * ways to connect one. Used in setup and in Settings.
 */
export function CopilotConnect({ compact }: { compact?: boolean }) {
  if (isHosted()) return <HostedCopilot />;
  return <LocalCopilotConnect compact={compact} />;
}

/**
 * The web app: Copilot runs on the plan of the member who chose it (the workspace's creator at
 * first), through their GitHub sign-in. Any member can make it their own plan.
 */
function HostedCopilot() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useCopilotAccounts();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: { id: string; name: string } }>('/api/me') });
  const mine = useMutation({
    mutationFn: () => post('/api/copilot/use-mine'),
    onSuccess: () => {
      for (const key of ['copilot-accounts', 'models', 'workspace']) void qc.invalidateQueries({ queryKey: [key] });
      toast('Copilot here now runs on your plan.', 'ok');
    },
    onError: (e) => toast((e as Error).message, 'danger'),
  });
  if (q.isLoading || me.isLoading)
    return (
      <p className="flex items-center gap-2.5 py-3 text-[13px] text-muted">
        <Spinner /> Checking Copilot for this workspace…
      </p>
    );
  const a = q.data?.active;
  const isMe = a && me.data && a.id === me.data.user.id;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3.5 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--border)]">
        <span className="relative">
          <Initials login={a?.login ?? '?'} size={40} />
          {q.data?.signedIn && (
            <span aria-hidden className="absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full bg-ok ring-2 ring-surface">
              <Check className="size-2.5 text-white" strokeWidth={3.5} />
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14.5px] font-semibold">{a ? (isMe ? 'Your Copilot plan' : `${a.login}'s Copilot plan`) : 'No Copilot plan yet'}</span>
            {q.data?.signedIn ? <span className="shrink-0 rounded-full bg-ok-soft px-2 py-px text-[11.5px] font-medium text-ok">Connected</span> : <span className="shrink-0 rounded-full bg-warn-soft px-2 py-px text-[11.5px] font-medium text-warn">Needs sign-in</span>}
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-muted">
            <BrandLogo brand="github" size={12} /> {a ? `github.com/${a.login} · used for Copilot and GitHub in this workspace` : 'Choose whose plan this workspace uses'}
          </p>
        </div>
        {!isMe && (
          <Button size="sm" busy={mine.isPending} onClick={() => mine.mutate()}>
            Use my Copilot plan
          </Button>
        )}
      </div>
      {q.data?.error && <p className="px-1 text-[12.5px] text-warn">{q.data.error}</p>}
      <p className="px-1 text-[12px] text-faint">Every Copilot request in this workspace counts against this plan. Any member can switch it to their own.</p>
    </div>
  );
}

function LocalCopilotConnect({ compact }: { compact?: boolean | undefined }) {
  const q = useCopilotAccounts();
  const toast = useToast();
  const refresh = useRefreshAfterSwitch();
  const [signIn, setSignIn] = useState<ProviderKind | null>(null);
  const [token, setToken] = useState(false);
  const [adding, setAdding] = useState(false);
  const use = useMutation({
    mutationFn: (id: string) => post<AccountState>(`/api/copilot/accounts/${id}/use`),
    onSuccess: (s) => {
      refresh();
      toast(`Tandem now uses ${s.active?.login ?? 'that account'}.`, 'ok');
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'danger'),
  });
  const out = useMutation({
    mutationFn: (id: string) => del<AccountState>(`/api/copilot/accounts/${id}`),
    onSuccess: () => {
      refresh();
      toast('Signed out.', 'ok');
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'danger'),
  });
  const s = q.data;
  const others = s?.accounts.filter((a) => !a.active) ?? [];
  const dialogs = (
    <>
      {signIn && (
        <SignInDialog
          kind={signIn}
          onClose={() => {
            setSignIn(null);
            setAdding(false);
          }}
        />
      )}
      {token && <TokenDialog onClose={() => setToken(false)} />}
    </>
  );

  if (q.isLoading)
    return (
      <p className="flex items-center gap-2.5 py-3 text-[13px] text-muted">
        <Spinner /> Checking your Copilot sign-in…
      </p>
    );

  if (!s?.signedIn)
    return (
      <div className="flex flex-col gap-3">
        {!compact && (
          <div>
            <p className="text-[14px] font-semibold">Connect GitHub Copilot</p>
            <p className="mt-0.5 text-[13px] text-muted">Sign in with the GitHub account that has your Copilot plan: personal (Free, Pro, Pro+) or from work (Business, Enterprise).</p>
          </div>
        )}
        {s?.error && <p className="text-[12.5px] text-warn">{s.error}</p>}
        <SignInButtons state={s} onPick={setSignIn} />
        <button type="button" onClick={() => setToken(true)} className="self-start text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline">
          No browser on this computer? Use a token instead
        </button>
        {dialogs}
      </div>
    );

  const a = s.active!;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3.5 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--border)]">
        <span className="relative">
          <Initials login={a.login} size={40} />
          <span aria-hidden className="absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full bg-ok ring-2 ring-surface">
            <Check className="size-2.5 text-white" strokeWidth={3.5} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14.5px] font-semibold">{a.login}</span>
            <span className="shrink-0 rounded-full bg-ok-soft px-2 py-px text-[11.5px] font-medium text-ok">Connected</span>
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12.5px] text-muted">
            {a.host === 'github.com' ? <BrandLogo brand="github" size={12} /> : <Building2 aria-hidden className="size-3.5" strokeWidth={1.8} />}
            {a.host} · {SOURCE[a.source]}
          </p>
        </div>
        {a.source !== 'environment' && a.source !== 'gh' && (
          <Button size="sm" variant="ghost" icon={LogOut} busy={out.isPending && out.variables === a.id} onClick={() => out.mutate(a.id)}>
            Sign out
          </Button>
        )}
      </div>
      {others.length > 0 && (
        <div>
          <p className="mb-1.5 px-1 text-[12px] font-medium text-faint">Also signed in</p>
          <ul className="flex flex-col gap-1">
            {others.map((o) => (
              <li key={o.id} className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-surface-2/60">
                <Initials login={o.login} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{o.login}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {o.host} · {SOURCE[o.source]}
                  </span>
                </span>
                <Button size="sm" busy={use.isPending && use.variables === o.id} onClick={() => use.mutate(o.id)}>
                  Use this account
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {adding ? (
        <div className="animate-in rounded-xl bg-surface-2/50 p-3">
          <SignInButtons state={s} onPick={setSignIn} />
          <div className="mt-2 flex items-center justify-between">
            <button type="button" onClick={() => setToken(true)} className="text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline">
              Use a token instead
            </button>
            <button type="button" onClick={() => setAdding(false)} className="text-[12.5px] text-muted hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 self-start rounded-lg px-1 text-[13px] font-medium text-accent-text hover:underline">
          <Plus aria-hidden className="size-3.5" /> Add another account
        </button>
      )}
      {dialogs}
    </div>
  );
}
