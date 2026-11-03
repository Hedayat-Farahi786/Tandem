import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Save } from 'lucide-react';
import type { Settings } from '@tandem/shared';
import { api, del, put } from '../lib/api';
import type { ModelCatalog } from '../lib/types';
import { formatCredits } from '../ui/model-picker';
import { Button, Callout, Card, ErrorState, Input, Loading, PageHeader, Pill, Select, useToast , Switch } from '../ui/kit';

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
function Num({ label, value, onChange, help, min = 1 }: { label: string; value: number; onChange: (n: number) => void; help?: string; min?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= min;
  return (
    <Input
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      step={1}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isInteger(next) && next >= min) onChange(next);
      }}
      onBlur={() => !valid && setText(String(value))}
      error={valid ? undefined : `Use a whole number from ${min}.`}
      {...(help ? { help } : {})}
    />
  );
}

function SecretField({ name, label, present, help, disabled }: { name: 'jira-token' | 'github-token'; label: string; present: boolean; help: string; disabled: boolean }) {
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
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input label={label} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={present ? '•••••••• (saved)' : 'Paste a token'} help={help} disabled={disabled} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" icon={KeyRound} busy={save.isPending} disabled={!value.trim() || disabled} onClick={() => save.mutate()}>
          Save token
        </Button>
        {present && (
          <Button size="sm" variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        )}
        <Pill tone={present ? 'ok' : 'neutral'} dot>
          {present ? 'Saved in keychain' : 'Not set'}
        </Pill>
      </div>
      {(save.isError || remove.isError) && <ErrorState error={save.error ?? remove.error} />}
    </div>
  );
}

export function SettingsScreen() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') });
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: () => api<Secrets>('/api/secrets') });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/api/usage') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api<ModelCatalog>('/api/copilot/models'), retry: false });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data && !s) setS(settings.data);
  }, [settings.data, s]);
  const save = useMutation({
    mutationFn: (next: Settings) => put<Settings>('/api/settings', next),
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

  return (
    <div className="flex flex-col gap-6 pb-20">
      <PageHeader title="Settings" subtitle="Stored on this machine. Tokens go only to your OS keychain, never to files or the database." />

      <Card title="You">
        <Input label="Your name" value={s.ownerName} onChange={(e) => set('ownerName', e.target.value)} help="Shown on your spec approvals." />
      </Card>

      <Card title="Copilot" description="Tandem uses your existing Copilot CLI sign-in. No token is stored.">
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Copilot host" value={s.copilot.host} onChange={(e) => set('copilot', { ...s.copilot, host: e.target.value })} placeholder="github.com" help="For GitHub Enterprise with data residency, enter your company host (company.ghe.com)." />
          <div />
          <Select label="Default model for code" value={s.copilot.buildModel} onChange={(buildModel) => set('copilot', { ...s.copilot, buildModel })} options={modelOptions("Copilot's own choice")} help="Builds and fixes, when a task's model is Auto." />
          <Select label="Default model for chat, specs and reviews" value={s.copilot.lightModel} onChange={(lightModel) => set('copilot', { ...s.copilot, lightModel })} options={modelOptions('Cheapest available')} help="Read-only steps, when the model is Auto." />
        </div>
        {models.isError && (
          <div className="mt-4">
            <Callout tone="warn" title="Could not list your Copilot models">
              {(models.error as Error).message}
            </Callout>
          </div>
        )}
      </Card>

      <Card title="Copilot budget" description="Copilot plans are often shared. A run that reaches a limit stops at once, and the task waits until you raise the limit and resume.">
        {usage.data && (
          <div className="mb-5 grid gap-3 md:grid-cols-3">
            {[
              ['AI credits today', `${formatCredits(usage.data.credits.today)} of ${usage.data.credits.perDay}`],
              ['Prompts today', `${usage.data.today} of ${usage.data.perDay}`],
              ['Last 30 days', `${formatCredits(usage.data.last30Days.aiCredits)} credits · ${usage.data.last30Days.prompts} prompts`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-surface-2 px-4 py-3">
                <p className="text-[12px] text-muted">{k}</p>
                <p className="mt-0.5 text-[15px] font-medium tabular-nums">{v}</p>
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <Num label="AI credits per task" value={s.budget.perTaskCredits} onChange={(n) => set('budget', { ...s.budget, perTaskCredits: n })} help="The model picker warns when a model is likely to need more." />
          <Num label="AI credits per day" value={s.budget.perDayCredits} onChange={(n) => set('budget', { ...s.budget, perDayCredits: n })} help="For all of Tandem together." />
          <Num label="Model calls per run" min={5} value={s.budget.perRunModelCalls} onChange={(n) => set('budget', { ...s.budget, perRunModelCalls: n })} help="Stops a runaway agent loop." />
          <Num label="Prompts per task" value={s.budget.perTaskPrompts} onChange={(n) => set('budget', { ...s.budget, perTaskPrompts: n })} />
          <Num label="Prompts per day" value={s.budget.perDayPrompts} onChange={(n) => set('budget', { ...s.budget, perDayPrompts: n })} />
        </div>
      </Card>

      <Card title="AWS" description="For CodeCommit: git over HTTPS and opening pull requests.">
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="AWS profile" value={s.aws.profile} onChange={(e) => set('aws', { ...s.aws, profile: e.target.value })} placeholder="default" help="Repos whose codecommit:: URL names a profile use that one." />
          <Input label="Region" optional value={s.aws.region} onChange={(e) => set('aws', { ...s.aws, region: e.target.value })} placeholder="From the repo URL" />
        </div>
      </Card>

      <Card title="Limits">
        <div className="grid gap-4 md:grid-cols-3">
          <Num label="Builds at a time" value={s.limits.maxConcurrentBuilds} onChange={(n) => set('limits', { ...s.limits, maxConcurrentBuilds: Math.min(8, n) })} />
          <Num label="Fix attempts" min={0} value={s.limits.maxFixAttempts} onChange={(n) => set('limits', { ...s.limits, maxFixAttempts: Math.min(5, n) })} help="When checks fail, before “needs attention”." />
          <Num label="Size limit (lines)" min={50} value={s.limits.sizeLineLimit} onChange={(n) => set('limits', { ...s.limits, sizeLineLimit: n })} help="Bigger tasks get a proposed split." />
          <Num label="Build timeout (minutes)" value={s.limits.buildTimeoutMin} onChange={(n) => set('limits', { ...s.limits, buildTimeoutMin: n })} />
          <Num label="Command timeout (minutes)" value={s.limits.commandTimeoutMin} onChange={(n) => set('limits', { ...s.limits, commandTimeoutMin: n })} />
          <Num label="PR check interval (minutes)" value={s.polling.prPollIntervalMin} onChange={(n) => set('polling', { ...s.polling, prPollIntervalMin: n })} />
        </div>
        <div className="mt-5 border-t border-line pt-5">
          <Switch
            checked={s.polling.fixConflicts}
            onChange={(v) => set('polling', { ...s.polling, fixConflicts: v })}
            label="Fix conflicts in open pull requests"
            description="When the base branch changes and a PR no longer merges cleanly, Tandem merges the base in, resolves the conflicts, runs every check and pushes, never with force. Branches someone else has pushed to are left to them."
          />
        </div>
      </Card>

      <Card title="Jira" description="Optional. Add the URL and a token to import tasks, post specs and report PRs." actions={<Pill tone={secrets.data?.jiraToken && s.jira.baseUrl ? 'ok' : 'neutral'} dot>{secrets.data?.jiraToken && s.jira.baseUrl ? 'Enabled' : 'Not configured'}</Pill>}>
        {!kcOk && secrets.data && (
          <div className="mb-4">
            <Callout tone="warn" title="No OS keychain on this machine">
              {secrets.data.keychain.message}
            </Callout>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Jira URL" value={s.jira.baseUrl} onChange={(e) => set('jira', { ...s.jira, baseUrl: e.target.value })} placeholder="https://company.atlassian.net" />
          <Input label="Account email" optional value={s.jira.email} onChange={(e) => set('jira', { ...s.jira, email: e.target.value })} help="Jira Cloud. Leave empty for Data Center." />
          <Input label="Ready query (JQL)" value={s.jira.readyJql} onChange={(e) => set('jira', { ...s.jira, readyJql: e.target.value })} />
          <Input label="Move to status after PRs" value={s.jira.inReviewStatus} onChange={(e) => set('jira', { ...s.jira, inReviewStatus: e.target.value })} />
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <SecretField name="jira-token" label="Jira API token" present={secrets.data?.jiraToken ?? false} disabled={!kcOk} help="Jira Cloud: create one at id.atlassian.com. Data Center: a personal access token." />
        </div>
      </Card>

      <Card title="GitHub" description="Only for GitHub repositories. Without a token Tandem uses the GitHub CLI's login, or gives you a compare link.">
        <SecretField name="github-token" label="GitHub token" present={secrets.data?.githubToken ?? false} disabled={!kcOk} help="Needs permission to open pull requests on your repositories." />
      </Card>

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
