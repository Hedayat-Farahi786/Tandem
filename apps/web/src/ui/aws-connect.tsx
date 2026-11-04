import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Building2, KeyRound, LogOut, TerminalSquare } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { BrandLogo } from './brands';
import { Button, Callout, CopyButton, Dialog, Input, Select, Spinner, cx, useToast } from './kit';

/*
 * Connecting AWS for CodeCommit, in the app: the company sign-in (AWS IAM Identity Center, in the
 * browser), an access key, or a profile already on this computer. Kept in the system keychain.
 */

export interface AwsState {
  connected: boolean;
  kind?: 'sso' | 'keys' | 'profile';
  label?: string;
  expiresAt?: string;
  profiles: string[];
  error?: string;
  region: string;
}

export const AWS_REGIONS: ReadonlyArray<{ value: string; label: string }> = [
  ['us-east-1', 'US East (N. Virginia)'],
  ['us-east-2', 'US East (Ohio)'],
  ['us-west-1', 'US West (N. California)'],
  ['us-west-2', 'US West (Oregon)'],
  ['ca-central-1', 'Canada (Central)'],
  ['sa-east-1', 'South America (São Paulo)'],
  ['eu-central-1', 'Europe (Frankfurt)'],
  ['eu-central-2', 'Europe (Zurich)'],
  ['eu-west-1', 'Europe (Ireland)'],
  ['eu-west-2', 'Europe (London)'],
  ['eu-west-3', 'Europe (Paris)'],
  ['eu-north-1', 'Europe (Stockholm)'],
  ['eu-south-1', 'Europe (Milan)'],
  ['me-central-1', 'Middle East (UAE)'],
  ['ap-south-1', 'Asia Pacific (Mumbai)'],
  ['ap-southeast-1', 'Asia Pacific (Singapore)'],
  ['ap-southeast-2', 'Asia Pacific (Sydney)'],
  ['ap-northeast-1', 'Asia Pacific (Tokyo)'],
  ['ap-northeast-2', 'Asia Pacific (Seoul)'],
].map(([value, label]) => ({ value: value!, label: `${label} · ${value}` }));

export function useAws() {
  return useQuery({ queryKey: ['aws'], queryFn: () => api<AwsState>('/api/aws'), staleTime: 30_000 });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['aws', 'aws-repos', 'bootstrap', 'doctor']) void qc.invalidateQueries({ queryKey: [key] });
  };
}

type Poll = { status: 'pending' } | { status: 'choose'; accounts: Array<{ id: string; name: string; email?: string; roles: string[] }> } | { status: 'error'; message: string };

/** The company sign-in: start URL and region, a code to approve in the browser, then account and role. */
function SsoDialog({ region: defaultRegion, onClose }: { region: string; onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [startUrl, setStartUrl] = useState('');
  const [region, setRegion] = useState(defaultRegion);
  const [flow, setFlow] = useState<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete?: string } | null>(null);
  const [poll, setPoll] = useState<Poll>({ status: 'pending' });
  const [pick, setPick] = useState<{ accountId: string; role: string } | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const begin = useMutation({
    mutationFn: () => post<{ flowId: string; userCode: string; verificationUri: string; verificationUriComplete?: string }>('/api/aws/sso', { startUrl, region }),
    onSuccess: (f) => {
      setFlow(f);
      setPoll({ status: 'pending' });
    },
  });
  // Ask AWS every couple of seconds whether the code was approved.
  useEffect(() => {
    if (!flow || poll.status !== 'pending') return;
    const t = setTimeout(() => {
      void post<Poll>(`/api/aws/sso/${flow.flowId}/poll`)
        .then((p) => {
          if (!live.current) return;
          setPoll(p);
          if (p.status === 'choose' && p.accounts.length === 1 && p.accounts[0]!.roles.length === 1) setPick({ accountId: p.accounts[0]!.id, role: p.accounts[0]!.roles[0]! });
        })
        .catch((err: unknown) => live.current && setPoll({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
    }, 2000);
    return () => clearTimeout(t);
  }, [flow, poll]);
  const choose = useMutation({
    mutationFn: () => post<AwsState>(`/api/aws/sso/${flow!.flowId}/choose`, pick),
    onSuccess: (s) => {
      refresh();
      toast(`AWS is connected: ${s.label}.`, 'ok');
      onClose();
    },
  });
  const close = () => {
    if (flow && poll.status !== 'error') void del(`/api/aws/sso/${flow.flowId}`).catch(() => undefined);
    onClose();
  };
  const accounts = poll.status === 'choose' ? poll.accounts : [];
  return (
    <Dialog open onClose={close} title="Sign in with your company's AWS" description="AWS IAM Identity Center (single sign-on), the sign-in your company uses for AWS. You approve in the browser; Tandem gets short-lived access that renews itself.">
      {!flow ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (startUrl.trim()) begin.mutate();
          }}
        >
          <Input id="sso-url" label="AWS access portal URL" autoFocus value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="https://your-company.awsapps.com/start" help="The address you open to choose an AWS account, often ending in awsapps.com/start." />
          <Select id="sso-region" label="Region of the portal" value={region} onChange={setRegion} options={AWS_REGIONS} help="Where your company set up IAM Identity Center. Ask your AWS admin if you're not sure." />
          {begin.isError && (
            <Callout tone="danger" title="Couldn't start the sign-in">
              {(begin.error as Error).message}
            </Callout>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" busy={begin.isPending} disabled={!startUrl.trim()}>
              Continue
            </Button>
          </div>
        </form>
      ) : poll.status === 'pending' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-surface-2/70 px-4 py-3.5 text-center">
            <p className="text-[12.5px] text-muted">Confirm this code on the AWS page</p>
            <p className="mt-1 font-mono text-[24px] font-semibold tracking-[0.18em]">{flow.userCode}</p>
            <div className="mt-1 flex justify-center">
              <CopyButton text={flow.userCode} label="Copy code" variant="ghost" />
            </div>
          </div>
          <a href={flow.verificationUriComplete ?? flow.verificationUri} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[14px] font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover">
            <BrandLogo brand="aws" size={16} />
            Open the AWS sign-in
            <ArrowUpRight aria-hidden className="size-4" />
          </a>
          <p role="status" className="flex items-center justify-center gap-2 text-[12.5px] text-muted">
            <Spinner className="size-3.5" /> Waiting for you to allow access in the browser…
          </p>
          <div className="flex justify-end">
            <Button onClick={close}>Cancel</Button>
          </div>
        </div>
      ) : poll.status === 'choose' ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13.5px] text-muted">Which AWS account holds your repositories, and which role should Tandem use?</p>
          <ul className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
            {accounts.map((a) => (
              <li key={a.id} className={cx('rounded-xl px-3 py-2.5 shadow-[0_0_0_1px_var(--border)] transition-colors', pick?.accountId === a.id && 'bg-accent-soft/40 shadow-[0_0_0_1.5px_var(--accent)]')}>
                <p className="flex items-center gap-2 text-[13.5px] font-medium">
                  <Building2 aria-hidden className="size-4 text-faint" strokeWidth={1.8} />
                  {a.name}
                  <span className="text-[12px] font-normal text-faint tabular-nums">{a.id}</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.roles.map((r) => (
                    <button key={r} type="button" aria-pressed={pick?.accountId === a.id && pick.role === r} onClick={() => setPick({ accountId: a.id, role: r })} className={cx('rounded-full px-2.5 py-1 text-[12.5px] transition-colors', pick?.accountId === a.id && pick.role === r ? 'bg-accent text-accent-fg' : 'bg-surface text-muted shadow-[0_0_0_1px_var(--border)] hover:text-fg')}>
                      {r}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {choose.isError && (
            <Callout tone="danger" title="Couldn't connect">
              {(choose.error as Error).message}
            </Callout>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!pick} busy={choose.isPending} onClick={() => choose.mutate()}>
              Connect
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Callout tone="danger" title="The sign-in didn't finish">
            {poll.message}
          </Callout>
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Close</Button>
            <Button
              variant="primary"
              onClick={() => {
                setFlow(null);
                setPoll({ status: 'pending' });
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function KeysDialog({ onClose }: { onClose: () => void }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () => post<AwsState>('/api/aws/keys', { accessKeyId: id.trim(), secretAccessKey: secret.trim() }),
    onSuccess: () => {
      refresh();
      toast('AWS is connected.', 'ok');
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Connect with an access key"
      description="For an AWS account without single sign-on. Use an IAM user that may use CodeCommit; the key goes to your system keychain."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={KeyRound} busy={save.isPending} disabled={id.trim().length < 16 || secret.trim().length < 16} onClick={() => save.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input id="aws-key-id" label="Access key ID" autoComplete="off" spellCheck={false} value={id} onChange={(e) => setId(e.target.value)} placeholder="AKIA…" />
        <Input id="aws-key-secret" label="Secret access key" type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
        <p className="text-[12.5px] text-muted">
          The user needs the AWS managed policy <span className="font-medium text-fg">AWSCodeCommitPowerUser</span>, or one that allows reading, pushing and pull requests on your repositories.
        </p>
        {save.isError && (
          <Callout tone="danger" title="AWS didn't accept the key">
            {(save.error as Error).message}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

/** The AWS connection: who Tandem works as for CodeCommit, or the ways to connect. */
export function AwsConnect() {
  const q = useAws();
  const refresh = useRefresh();
  const toast = useToast();
  const [dialog, setDialog] = useState<'sso' | 'keys' | null>(null);
  const [profile, setProfile] = useState('');
  const [changing, setChanging] = useState(false);
  const useProfile = useMutation({
    mutationFn: () => post<AwsState>('/api/aws/profile', { profile }),
    onSuccess: () => {
      refresh();
      setChanging(false);
      toast(`AWS is connected with the profile ${profile}.`, 'ok');
    },
  });
  const disconnect = useMutation({
    mutationFn: () => del<AwsState>('/api/aws'),
    onSuccess: () => {
      refresh();
      toast('AWS is disconnected.', 'ok');
    },
  });
  if (q.isLoading)
    return (
      <p className="flex items-center gap-2.5 py-3 text-[13px] text-muted">
        <Spinner /> Checking the AWS connection…
      </p>
    );
  const s = q.data;
  const dialogs = (
    <>
      {dialog === 'sso' && <SsoDialog region={s?.region ?? 'eu-central-1'} onClose={() => setDialog(null)} />}
      {dialog === 'keys' && <KeysDialog onClose={() => setDialog(null)} />}
    </>
  );

  if (s?.connected && !changing)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3.5 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--border)]">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 shadow-[0_0_0_1px_var(--border)]">
            <BrandLogo brand="aws" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14.5px] font-semibold">{s.label}</span>
              {s.error ? <span className="shrink-0 rounded-full bg-warn-soft px-2 py-px text-[11.5px] font-medium text-warn">Expired</span> : <span className="shrink-0 rounded-full bg-ok-soft px-2 py-px text-[11.5px] font-medium text-ok">Connected</span>}
            </p>
            <p className="mt-0.5 truncate text-[12.5px] text-muted">
              {s.kind === 'sso' ? `IAM Identity Center${s.expiresAt ? ` · renews itself until ${new Date(s.expiresAt).toLocaleDateString()}` : ''}` : s.kind === 'keys' ? 'IAM access key' : 'A profile on this computer'}
            </p>
          </div>
          <Button size="sm" onClick={() => (s.error && s.kind === 'sso' ? setDialog('sso') : setChanging(true))}>
            {s.error ? 'Sign in again' : 'Change'}
          </Button>
          <Button size="sm" variant="ghost" icon={LogOut} busy={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        </div>
        {s.error && <p className="px-1 text-[12.5px] text-warn">{s.error}</p>}
        {dialogs}
      </div>
    );

  const option = (icon: ReactNode, title: string, body: string, onClick: () => void, recommended?: boolean) => (
    <button type="button" onClick={onClick} className="group flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 text-left shadow-[0_0_0_1px_var(--border)] transition-[box-shadow,background-color] duration-150 hover:bg-surface-2 hover:shadow-[0_0_0_1px_var(--border-strong)]">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-fg shadow-[0_0_0_1px_var(--border)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13.5px] font-medium">
          {title}
          {recommended && <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent-text">Recommended</span>}
        </span>
        <span className="block text-[12px] leading-snug text-muted">{body}</span>
      </span>
      <ArrowUpRight aria-hidden className="size-4 shrink-0 text-faint transition-colors group-hover:text-fg" />
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      {option(<BrandLogo brand="aws" size={18} />, "Sign in with your company's AWS", 'IAM Identity Center (single sign-on), in the browser', () => setDialog('sso'), true)}
      {option(<KeyRound aria-hidden className="size-[18px]" strokeWidth={1.8} />, 'Use an access key', 'An IAM user without single sign-on', () => setDialog('keys'))}
      {s && s.profiles.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl bg-surface px-3.5 py-3 shadow-[0_0_0_1px_var(--border)]">
          <span className="grid size-9 shrink-0 place-items-center self-center rounded-lg bg-surface-2 text-fg shadow-[0_0_0_1px_var(--border)]">
            <TerminalSquare aria-hidden className="size-[18px]" strokeWidth={1.8} />
          </span>
          <div className="min-w-[180px] flex-1">
            <Select id="aws-profile" label="Or use a profile on this computer" value={profile} onChange={setProfile} placeholder="Choose a profile" options={s.profiles.map((p) => ({ value: p, label: p }))} />
          </div>
          <Button disabled={!profile} busy={useProfile.isPending} onClick={() => useProfile.mutate()}>
            Use profile
          </Button>
        </div>
      )}
      {useProfile.isError && (
        <Callout tone="danger" title="That profile didn't work">
          {(useProfile.error as Error).message}
        </Callout>
      )}
      {changing && (
        <button type="button" onClick={() => setChanging(false)} className="self-start text-[12.5px] text-muted hover:text-fg">
          Keep the current connection
        </button>
      )}
      {dialogs}
    </div>
  );
}

