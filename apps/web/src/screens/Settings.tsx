import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Gauge, Save, ShieldAlert, ShieldCheck, UserRound, Workflow, type LucideIcon } from 'lucide-react';
import { BrandLogo, BrandTile, type Brand } from '../ui/brands';
import { IconTile, Ring } from '../ui/visual';
import type { Settings } from '@tandem/shared';
import { api, del, put } from '../lib/api';
import type { ModelCatalog } from '../lib/types';
import { formatCredits } from '../ui/model-picker';
import { CreditsInfo, creditsToUsd } from '../ui/credits-info';
import { CopilotConnect } from '../ui/copilot-connect';
import { AWS_REGIONS, AwsConnect } from '../ui/aws-connect';
import { Button, Callout, CopyButton, ErrorState, Input, LinkButton, Loading, Row, Select, SettingsSection, Switch, cx, useToast } from '../ui/kit';
import type { AuditVerification } from '../lib/types';

interface Secrets {
  keychain: { ok: boolean; message: string };
  jiraToken: boolean;
  githubToken: boolean;
}
interface Usage {
  today: number;
  perDay: number;
  perTask: number;
  credits: { today: number; perDay: number; perTask: number };
  last30Days: { prompts: number; modelCalls: number; aiCredits: number };
}

/** A whole-number field: free to clear and retype; commits valid values, restores the last one on blur. */
function Num({ id, value, onChange, min = 1, disabled }: { id: string; value: number; onChange: (n: number) => void; min?: number; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= min;
  return (
    <div className="flex justify-end">
      <div className="w-28 [&_p]:w-48 [&_p]:justify-end [&_p]:self-end">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          step={1}
          disabled={disabled}
          value={text}
          className="text-right tabular-nums"
          onChange={(e) => {
            setText(e.target.value);
            const next = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isInteger(next) && next >= min) onChange(next);
          }}
          onBlur={() => !valid && setText(String(value))}
          error={valid ? undefined : `Use a whole number from ${min}.`}
        />
      </div>
    </div>
  );
}

function SecretField({ id, name, present, disabled }: { id: string; name: 'jira-token' | 'github-token'; present: boolean; disabled: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: () => put(`/api/secrets/${name}`, { value }),
    onSuccess: () => {
      setValue('');
      toast('Saved to the OS keychain.', 'ok');
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/secrets/${name}`),
    onSuccess: () => {
      toast('Removed from the OS keychain.', 'ok');
      void qc.invalidateQueries({ queryKey: ['secrets'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Input id={id} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={present ? '•••••••• saved' : 'Paste a token'} disabled={disabled} />
        </div>
        <Button variant="primary" busy={save.isPending} disabled={!value.trim() || disabled} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <span className={cx('size-1.5 rounded-full', present ? 'bg-ok' : 'bg-faint')} aria-hidden />
        {present ? 'Saved in your OS keychain' : 'Not set'}
        {present && (
          <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="ml-1 font-medium text-danger hover:underline">
            Remove
          </button>
        )}
      </p>
      {(save.isError || remove.isError) && <ErrorState error={save.error ?? remove.error} />}
    </div>
  );
}

/** The tamper-evident record of changes, for audits: its check, and exports. */
function AuditSection() {
  const v = useQuery({ queryKey: ['audit-verify'], queryFn: () => api<AuditVerification>('/api/audit/verify') });
  return (
    <SettingsSection id="audit" icon={<IconTile icon={ShieldCheck} />} title="Audit log" description="Tandem records every change to settings, approvals, commits and pull requests, with who made it. Each entry is sealed, so a change made later shows.">
      <Row label="Integrity" description={v.data && !v.data.ok ? v.data.reason : v.data?.count ? `${v.data.count} entries, all intact.` : 'Nothing recorded yet.'}>
        {v.data && (
          <span className={cx('inline-flex items-center gap-1.5 text-[13px] font-medium', v.data.ok ? 'text-ok' : 'text-danger')}>
            {v.data.ok ? <ShieldCheck aria-hidden className="size-4" /> : <ShieldAlert aria-hidden className="size-4" />}
            {v.data.ok ? 'Verified' : 'Failed verification'}
          </span>
        )}
      </Row>
      {v.data?.ok && v.data.count > 0 && (
        <Row label="Head hash" description="Write it down (for example in a ticket). If an earlier entry ever changes, this no longer matches.">
          <span className="flex items-center justify-end gap-2">
            <code className="font-mono text-[12px] text-muted" title={v.data.head}>
              {v.data.head.slice(0, 12)}…
            </code>
            <CopyButton text={v.data.head} label="Copy" />
          </span>
        </Row>
      )}
      <Row label="Export" description="Everything Tandem and Copilot did: tasks, approvals, commits, pull requests, Copilot runs, checks and settings changes.">
        <span className="flex gap-2">
          <LinkButton to="/api/activity?format=csv" size="sm" download>
            CSV
          </LinkButton>
          <LinkButton to="/api/activity?format=json" size="sm" download>
            JSON
          </LinkButton>
        </span>
      </Row>
    </SettingsSection>
  );
}

const NAV = [
  ['general', 'General', UserRound],
  ['copilot', 'Copilot', 'copilot'],
  ['budget', 'Budget', Gauge],
  ['workflow', 'Workflow', Workflow],
  ['aws', 'AWS', 'aws'],
  ['jira', 'Jira', 'jira'],
  ['github', 'GitHub', 'github'],
  ['audit', 'Audit log', ShieldCheck],
] as const satisfies ReadonlyArray<readonly [string, string, LucideIcon | Brand]>;

/** The section menu beside Settings, following the section in view. */
function SectionNav() {
  const [active, setActive] = useState<string>('general');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id);
    }, { rootMargin: '-15% 0px -70% 0px' });
    for (const [id] of NAV) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return (
    <nav aria-label="Settings sections" className="hidden lg:block">
      <ul className="sticky top-8 flex flex-col gap-px">
        {NAV.map(([id, label, Icon]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              onClick={(e) => {
                e.preventDefault();
                setActive(id);
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              aria-current={active === id ? 'true' : undefined}
              className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors', active === id ? 'bg-surface-3/80 font-medium text-fg' : 'text-muted hover:bg-surface-3/50 hover:text-fg')}
            >
              {typeof Icon === 'string' ? <BrandLogo brand={Icon} size={16} className={cx('transition-opacity', active !== id && 'opacity-80')} /> : <Icon aria-hidden className={cx('size-4', active === id ? 'text-fg' : 'text-faint')} strokeWidth={1.9} />}
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SettingsScreen() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  // Values fixed by environment variables at start can't be changed here: say so instead of pretending.
  const locked = useQuery({ queryKey: ['settings-locked'], queryFn: () => api<Record<string, string>>('/api/settings/locked') });
  const lock = (path: string) => locked.data?.[path];
  const note = (path: string, base?: string) => (lock(path) ? `Set by ${lock(path)} when Tandem started. Change it there and restart Tandem.` : base);
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => api<Secrets>('/api/secrets') });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/api/usage') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelCatalog>('/api/copilot/models'), retry: false });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data && !s) setS(settings.data);
  }, [settings.data, s]);
  // The Copilot address follows the connected account (set by signing in), not this form.
  const serverHost = settings.data?.copilot.host;
  useEffect(() => {
    if (serverHost !== undefined) setS((prev) => (prev && prev.copilot.host !== serverHost ? { ...prev, copilot: { ...prev.copilot, host: serverHost } } : prev));
  }, [serverHost]);
  const save = useMutation({
    mutationFn: async (next: Settings) => {
      const fresh = await api<Settings>('/api/settings');
      return put<Settings>('/api/settings', { ...next, copilot: { ...next.copilot, host: fresh.copilot.host } });
    },
    onSuccess: (next) => {
      setS(next);
      qc.setQueryData(['settings'], next);
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      void qc.invalidateQueries({ queryKey: ['models'] });
      toast('Settings saved.', 'ok');
    },
  });
  if (settings.isLoading || !s) return settings.isError ? <ErrorState error={settings.error} retry={() => void settings.refetch()} /> : <Loading />;
  const dirty = JSON.stringify(s) !== JSON.stringify(settings.data);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const modelOptions = (empty: string) => [
    { value: '', label: empty },
    ...(models.data?.models ?? []).map((m) => ({
      value: m.id,
      label: m.name,
      description: [m.estimate !== undefined ? `≈ ${formatCredits(m.estimate)} credits per task` : null, m.price ? `in ${m.price.input} · out ${m.price.output} per 1M tokens` : m.multiplier !== undefined ? `${m.multiplier}× premium requests` : null].filter(Boolean).join(' · '),
    })),
  ];
  const kcOk = secrets.data?.keychain.ok ?? false;

  const jiraOn = Boolean(secrets.data?.jiraToken && s.jira.baseUrl);

  return (
    <div className="mx-auto w-full max-w-[1000px] pb-24">
      <div className="mb-10">
        <h1 className="font-display text-[26px] leading-tight">Settings</h1>
        <p className="mt-1 text-[14px] text-muted">Stored on this machine. Tokens go only to your OS keychain.</p>
      </div>
      <div className="grid gap-10 lg:grid-cols-[180px_minmax(0,1fr)]">
      <SectionNav />
      <div className="flex min-w-0 flex-col gap-14">

      <SettingsSection id="general" icon={<IconTile icon={UserRound} />} title="General">
        <Row label="Your name" htmlFor="set-name" description="Shown on the specs you approve.">
          <Input id="set-name" value={s.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
        </Row>
      </SettingsSection>

      <SettingsSection id="copilot" icon={<BrandTile brand="copilot" />} title="Copilot" description="The GitHub account whose Copilot plan Tandem uses: personal (Free, Pro, Pro+) or from work (Business, Enterprise). The sign-in stays in your system keychain.">
        <div className="py-4">
          <CopilotConnect />
        </div>
        <Row label="Default model for code" htmlFor="set-build" description={note('copilot.buildModel', "Builds and fixes, when a task's model is Auto.")} wide>
          <Select id="set-build" disabled={Boolean(lock('copilot.buildModel'))} value={s.copilot.buildModel} onChange={(buildModel) => set('copilot', { ...s.copilot, buildModel })} options={modelOptions("Copilot's own choice")} />
        </Row>
        <Row label="Default model for chat, specs and reviews" htmlFor="set-light" description={note('copilot.lightModel', 'Read-only steps, when the model is Auto.')} wide>
          <Select id="set-light" disabled={Boolean(lock('copilot.lightModel'))} value={s.copilot.lightModel} onChange={(lightModel) => set('copilot', { ...s.copilot, lightModel })} options={modelOptions('Cheapest available')} />
        </Row>
        {models.isError && (
          <div className="py-4">
            <Callout tone="warn" title="Could not list your Copilot models">
              {(models.error as Error).message}
            </Callout>
          </div>
        )}
      </SettingsSection>

      <SettingsSection id="budget" icon={<IconTile icon={Gauge} />} title="Copilot budget" description="Plans are often shared. A run that reaches a limit stops at once, and the task waits until you raise it.">
        {usage.data && (
          <div className="grid gap-4 py-5 sm:grid-cols-3">
            {(
              [
                ['AI credits today', usage.data.credits.today, usage.data.credits.perDay, formatCredits(usage.data.credits.today)],
                ['Prompts today', usage.data.today, usage.data.perDay, String(usage.data.today)],
              ] as const
            ).map(([label, used, of, shown]) => (
              <div key={label} className="flex items-center gap-3.5">
                <Ring value={used / of} size={52} stroke={5} tone={used / of >= 0.9 ? 'warn' : 'fg'} label={`${label}: ${shown} of ${of}`}>
                  <span className="text-[11px] font-medium tabular-nums">{Math.round((used / of) * 100)}%</span>
                </Ring>
                <div>
                  <p className="flex items-center gap-1 text-[13px] text-muted">
                    {label}
                    {label === 'AI credits today' && <CreditsInfo />}
                  </p>
                  <p className="text-[15px] font-medium tabular-nums">
                    {shown} <span className="text-muted">of {of}</span>
                  </p>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-3.5">
              <span className="grid size-[52px] shrink-0 place-items-center rounded-full bg-surface-2">
                <CalendarDays aria-hidden className="size-5 text-muted" />
              </span>
              <div>
                <p className="text-[13px] text-muted">Last 30 days</p>
                <p className="text-[15px] font-medium tabular-nums">
                  {formatCredits(usage.data.last30Days.aiCredits)} <span className="text-muted">credits</span>
                </p>
                <p className="text-[12px] text-faint tabular-nums">
                  {usage.data.last30Days.prompts} prompts · about {creditsToUsd(usage.data.last30Days.aiCredits)}
                </p>
              </div>
            </div>
          </div>
        )}
        <Row label="AI credits per task" htmlFor="set-ctask" description={note('budget.perTaskCredits', `About ${creditsToUsd(s.budget.perTaskCredits)} per task. A task that reaches it stops and waits for you; the model menu warns when a model is likely to need more.`)}>
          <Num id="set-ctask" disabled={Boolean(lock('budget.perTaskCredits'))} value={s.budget.perTaskCredits} onChange={(n) => set('budget', { ...s.budget, perTaskCredits: n })} />
        </Row>
        <Row label="AI credits per day" htmlFor="set-cday" description={note('budget.perDayCredits', `About ${creditsToUsd(s.budget.perDayCredits)} a day, for all of Tandem together.`)}>
          <Num id="set-cday" disabled={Boolean(lock('budget.perDayCredits'))} value={s.budget.perDayCredits} onChange={(n) => set('budget', { ...s.budget, perDayCredits: n })} />
        </Row>
        <Row label="Prompts per task" htmlFor="set-ptask" description={note('budget.perTaskPrompts', 'Messages Tandem sends Copilot for one task, across all its runs.')}>
          <Num id="set-ptask" disabled={Boolean(lock('budget.perTaskPrompts'))} value={s.budget.perTaskPrompts} onChange={(n) => set('budget', { ...s.budget, perTaskPrompts: n })} />
        </Row>
        <Row label="Prompts per day" htmlFor="set-pday" description={note('budget.perDayPrompts', 'For all of Tandem together, chats included.')}>
          <Num id="set-pday" disabled={Boolean(lock('budget.perDayPrompts'))} value={s.budget.perDayPrompts} onChange={(n) => set('budget', { ...s.budget, perDayPrompts: n })} />
        </Row>
        <Row label="Model calls per run" htmlFor="set-calls" description="Stops a runaway agent loop.">
          <Num id="set-calls" min={5} value={s.budget.perRunModelCalls} onChange={(n) => set('budget', { ...s.budget, perRunModelCalls: n })} />
        </Row>
      </SettingsSection>

      <SettingsSection id="workflow" icon={<IconTile icon={Workflow} />} title="Workflow">
        <Row label="Fix conflicts in open pull requests" description="When the base branch changes and a pull request no longer merges cleanly, Tandem merges it in, resolves the conflicts, runs every check and pushes, never with force. Branches someone else pushed to are left to them.">
          <div className="flex justify-end">
            <Switch checked={s.polling.fixConflicts} onChange={(v) => set('polling', { ...s.polling, fixConflicts: v })} label="Fix conflicts in open pull requests" hideLabel />
          </div>
        </Row>
        <Row label="Fix attempts" htmlFor="set-fix" description="When checks fail, before the pull request is marked “needs attention”.">
          <Num id="set-fix" min={0} value={s.limits.maxFixAttempts} onChange={(n) => set('limits', { ...s.limits, maxFixAttempts: Math.min(5, n) })} />
        </Row>
        <Row label="Size limit (lines)" htmlFor="set-size" description="Bigger tasks get a proposed split.">
          <Num id="set-size" min={50} value={s.limits.sizeLineLimit} onChange={(n) => set('limits', { ...s.limits, sizeLineLimit: n })} />
        </Row>
        <Row label="Builds at a time" htmlFor="set-builds">
          <Num id="set-builds" value={s.limits.maxConcurrentBuilds} onChange={(n) => set('limits', { ...s.limits, maxConcurrentBuilds: Math.min(8, n) })} />
        </Row>
        <Row label="Build timeout (minutes)" htmlFor="set-btime">
          <Num id="set-btime" value={s.limits.buildTimeoutMin} onChange={(n) => set('limits', { ...s.limits, buildTimeoutMin: n })} />
        </Row>
        <Row label="Command timeout (minutes)" htmlFor="set-ctime">
          <Num id="set-ctime" value={s.limits.commandTimeoutMin} onChange={(n) => set('limits', { ...s.limits, commandTimeoutMin: n })} />
        </Row>
        <Row label="PR check interval (minutes)" htmlFor="set-poll" description="How often open pull requests are checked for merges and conflicts.">
          <Num id="set-poll" value={s.polling.prPollIntervalMin} onChange={(n) => set('polling', { ...s.polling, prPollIntervalMin: n })} />
        </Row>
      </SettingsSection>

      <SettingsSection id="aws" icon={<BrandTile brand="aws" />} title="AWS" description="For CodeCommit repositories: reading and pushing code, and opening pull requests. The connection stays in your system keychain.">
        <div className="py-4">
          <AwsConnect />
        </div>
        <Row label="Usual region" htmlFor="set-region" description={note('aws.region', 'Where your CodeCommit repositories are, to list them first. Each repository keeps its own region.')}>
          <Select id="set-region" disabled={Boolean(lock('aws.region'))} value={s.aws.region} onChange={(region) => set('aws', { ...s.aws, region })} placeholder="Choose a region" options={AWS_REGIONS} />
        </Row>
      </SettingsSection>

      <SettingsSection
        id="jira"
        icon={<BrandTile brand="jira" />}
        title="Jira"
        description="Optional. Import tasks, post specs and report pull requests."
        actions={
          <span className="flex items-center gap-1.5 text-[13px] text-muted">
            <span aria-hidden className={cx('size-1.5 rounded-full', jiraOn ? 'bg-ok' : 'bg-faint')} />
            {jiraOn ? 'Enabled' : 'Not configured'}
          </span>
        }
      >
        {!kcOk && secrets.data && (
          <div className="py-4">
            <Callout tone="warn" title="No OS keychain on this machine">
              {secrets.data.keychain.message}
            </Callout>
          </div>
        )}
        <Row label="Jira URL" htmlFor="set-jira">
          <Input id="set-jira" value={s.jira.baseUrl} onChange={(e) => set('jira', { ...s.jira, baseUrl: e.target.value })} placeholder="https://company.atlassian.net" />
        </Row>
        <Row label="Account email" htmlFor="set-jmail" description="Jira Cloud only. Leave empty for Data Center.">
          <Input id="set-jmail" value={s.jira.email} onChange={(e) => set('jira', { ...s.jira, email: e.target.value })} />
        </Row>
        <Row label="Jira API token" htmlFor="set-jtoken" description="Jira Cloud: create one at id.atlassian.com. Data Center: a personal access token." wide>
          <SecretField id="set-jtoken" name="jira-token" present={secrets.data?.jiraToken ?? false} disabled={!kcOk} />
        </Row>
        <Row label="Ready query (JQL)" htmlFor="set-jql" description="Issues Tandem imports. A project's own query wins." wide>
          <Input id="set-jql" value={s.jira.readyJql} onChange={(e) => set('jira', { ...s.jira, readyJql: e.target.value })} className="font-mono text-[13px]" />
        </Row>
        <Row label="Move to status after PRs" htmlFor="set-jstatus">
          <Input id="set-jstatus" value={s.jira.inReviewStatus} onChange={(e) => set('jira', { ...s.jira, inReviewStatus: e.target.value })} />
        </Row>
      </SettingsSection>

      <SettingsSection id="github" icon={<BrandTile brand="github" />} title="GitHub" description="GitHub repositories use the GitHub account you connected for Copilot: it reads, pushes and opens pull requests. Add a token only for repositories that account can't reach.">
        <Row label="Extra GitHub token" htmlFor="set-gtoken" description="Optional. A fine-grained token with Contents and Pull requests (read and write) on those repositories." wide>
          <SecretField id="set-gtoken" name="github-token" present={secrets.data?.githubToken ?? false} disabled={!kcOk} />
        </Row>
      </SettingsSection>

      <AuditSection />

      </div>
      </div>
      {(dirty || save.isPending) && (
        <div className="sticky bottom-5 z-10 flex justify-center">
          <div role="region" aria-label="Unsaved changes" className="flex animate-pop items-center gap-4 rounded-2xl border border-line bg-surface/95 py-2 pr-2 pl-4 shadow-lg backdrop-blur">
            <span className="text-[13px] text-muted">You have unsaved changes.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (settings.data) setS(settings.data);
              }}
            >
              Discard
            </Button>
            <Button size="sm" variant="primary" icon={Save} busy={save.isPending} onClick={() => save.mutate(s)}>
              Save settings
            </Button>
          </div>
        </div>
      )}
      {save.isError && <ErrorState error={save.error} />}
    </div>
  );
}
