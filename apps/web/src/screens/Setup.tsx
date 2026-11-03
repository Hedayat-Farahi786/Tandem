import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project, Repo, RepoRole } from '@tandem/shared';
import type { DoctorReport } from '../lib/types';
import { api, post, put } from '../lib/api';
import { useRouter } from '../lib/router';
import type { Bootstrap } from '../lib/types';
import { ArrowRight, GitBranch, Plus } from 'lucide-react';
import { Button, Callout, Card, Checkbox, ErrorState, Input, Loading, PageHeader, Pill, RadioCards, Select, cx, useToast } from '../ui/kit';
import { DoctorList, DoctorSummary } from './Doctor';
import { RepoCommandsEditor } from './Projects';

const STEPS = ['Welcome', 'Repositories', 'Project', 'Copilot and AWS', 'Jira (optional)', 'Check'] as const;
type Step = (typeof STEPS)[number];

export function SetupScreen() {
  const [step, setStep] = useState<Step>('Welcome');
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const i = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(i + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(i - 1, 0)]!);
  if (!boot.data) return boot.isError ? <ErrorState error={boot.error} /> : null;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Set up Tandem" subtitle="Add your repositories, group them into a project and check that everything is reachable. You can change all of this later." />
      <nav aria-label="Setup progress" className="mb-8">
        <p className="mb-2.5 flex items-baseline gap-2 text-[13px]">
          <span className="text-faint">
            Step {i + 1} of {STEPS.length}
          </span>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <span className="font-medium">{step}</span>
        </p>
        <ol className="grid grid-cols-6 gap-1.5">
          {STEPS.map((s, n) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => n <= i && setStep(s)}
                disabled={n > i}
                aria-current={s === step ? 'step' : undefined}
                aria-label={`${n + 1}. ${s}${n < i ? ' (done)' : ''}`}
                title={s}
                className={cx('block h-1.5 w-full rounded-full transition-colors', n < i ? 'bg-accent/45 hover:bg-accent/70' : n === i ? 'bg-accent' : 'bg-surface-3')}
              />
            </li>
          ))}
        </ol>
      </nav>
      {step === 'Welcome' && <Welcome boot={boot.data} onNext={next} />}
      {step === 'Repositories' && <ReposStep repos={boot.data.repos} onNext={next} onBack={back} />}
      {step === 'Project' && <ProjectStep boot={boot.data} onNext={next} onBack={back} />}
      {step === 'Copilot and AWS' && <ConnectStep boot={boot.data} onNext={next} onBack={back} />}
      {step === 'Jira (optional)' && <JiraStep boot={boot.data} onNext={next} onBack={back} />}
      {step === 'Check' && <CheckStep onBack={back} />}
    </div>
  );
}

function Nav({ onBack, onNext, nextLabel = 'Continue', nextDisabled, busy }: { onBack?: () => void; onNext: () => void; nextLabel?: string; nextDisabled?: boolean; busy?: boolean }) {
  return (
    <div className="mt-6 flex justify-between">
      {onBack ? <Button onClick={onBack}>Back</Button> : <span />}
      <Button variant="primary" onClick={onNext} disabled={nextDisabled} busy={busy}>
        {nextLabel}
        <ArrowRight aria-hidden className="size-4" />
      </Button>
    </div>
  );
}

function Welcome({ boot, onNext }: { boot: Bootstrap; onNext: () => void }) {
  return (
    <Card title="How Tandem works">
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-[13px]">
        <li>Describe what you want in chat. Tandem asks questions until the request is clear and testable.</li>
        <li>Tandem drafts a spec. You approve the how, your PM approves the what.</li>
        <li>Copilot builds it on a separate branch, Tandem runs your checks and reviews the change.</li>
        <li>You get pull requests to review. Agents never merge and never push to your default branch.</li>
      </ol>
      {boot.doctor && !boot.doctor.ok && (
        <div className="mt-4">
          <Callout tone="warn" title="Doctor found problems on first launch">
            You can continue; the last step shows what to fix.
          </Callout>
        </div>
      )}
      <Nav onNext={onNext} nextLabel="Start" />
    </Card>
  );
}

const ROLES: RepoRole[] = ['full-stack', 'backend', 'frontend', 'other'];
export const ROLE_LABEL: Record<RepoRole, string> = { 'full-stack': 'Full-stack', backend: 'Backend', frontend: 'Frontend', other: 'Other' };

function ReposStep({ repos, onNext, onBack }: { repos: Repo[]; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState<(Repo & { evidence?: string[] }) | null>(null);
  const detect = useMutation({
    mutationFn: (u: string) => post<{ repo: Repo; evidence: string[] }>('/api/repos/detect', { url: u }),
    onSuccess: (r) => setDraft({ ...r.repo, evidence: r.evidence }),
  });
  const save = useMutation({
    mutationFn: (r: Repo) => post<Repo>('/api/repos', { url: r.url, name: r.name, defaultBranch: r.defaultBranch, role: r.role, commands: r.commands, language: r.language, framework: r.framework, packageManager: r.packageManager }),
    onSuccess: (r) => {
      toast(`Added ${r.name}.`, 'ok');
      setDraft(null);
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <Card title="Add a repository">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) detect.mutate(url.trim());
          }}
        >
          <Input label="Clone URL" placeholder="codecommit::eu-central-1://my-repo or ssh://git-codecommit.… or git@github.com:org/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} help="CodeCommit (SSH, HTTPS or codecommit::) and GitHub URLs work. Tandem clones it to detect its role and commands." />
          <div>
            <Button type="submit" variant="primary" icon={GitBranch} busy={detect.isPending} disabled={!url.trim()}>
              {detect.isPending ? 'Reading the repository…' : 'Detect'}
            </Button>
          </div>
        </form>
        {detect.isError && (
          <div className="mt-3">
            <ErrorState title="Could not read that repository" error={detect.error} />
          </div>
        )}
      </Card>
      {draft && (
        <Card title={`Confirm ${draft.name}`} actions={<Pill tone="accent">{[draft.language, draft.framework].filter(Boolean).join(' · ') || 'Unknown stack'}</Pill>}>
          <div className="grid gap-3 md:grid-cols-2">
            <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Input label="Default branch" value={draft.defaultBranch} onChange={(e) => setDraft({ ...draft, defaultBranch: e.target.value })} />
            <Select label="Role" value={draft.role} onChange={(role) => setDraft({ ...draft, role })} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
          </div>
          <div className="mt-4">
            <RepoCommandsEditor value={draft.commands} onChange={(commands) => setDraft({ ...draft, commands })} />
          </div>
          {draft.evidence?.length ? <p className="mt-3 text-[12px] text-muted">Detected from: {draft.evidence.join('; ')}.</p> : null}
          {save.isError && (
            <div className="mt-3">
              <ErrorState error={save.error} />
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <Button variant="primary" icon={Plus} busy={save.isPending} onClick={() => save.mutate(draft)}>
              Add repository
            </Button>
            <Button onClick={() => setDraft(null)}>Discard</Button>
          </div>
        </Card>
      )}
      <Card title={`Added (${repos.length})`}>
        {repos.length === 0 ? (
          <p className="text-[13px] text-muted">No repositories yet. Add one full-stack repo, or a frontend and a backend repo.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {repos.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-[13px]">
                <span className="font-medium">{r.name}</span>
                <span className="flex gap-2">
                  <Pill>{ROLE_LABEL[r.role]}</Pill>
                  <Pill>{r.host.kind === 'codecommit' ? `CodeCommit ${r.host.region}` : 'GitHub'}</Pill>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Nav onBack={onBack} onNext={onNext} nextDisabled={repos.length === 0} />
    </div>
  );
}

function ProjectStep({ boot, onNext, onBack }: { boot: Bootstrap; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const existing = boot.projects[0];
  const [name, setName] = useState(existing?.name ?? '');
  const [repoIds, setRepoIds] = useState<string[]>(existing?.repoIds ?? boot.repos.map((r) => r.id));
  const [pmGate, setPmGate] = useState<Project['pmGate']>(existing?.pmGate ?? 'tandem');
  const [pmNames, setPmNames] = useState((existing?.pmNames ?? []).join(', '));
  const [keyPrefix, setKeyPrefix] = useState(existing?.keyPrefix ?? 'TND');
  const [integration, setIntegration] = useState(existing?.integrationCommand ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = { name, repoIds, pmGate, pmNames: pmNames.split(',').map((s) => s.trim()).filter(Boolean), keyPrefix, ...(integration.trim() ? { integrationCommand: integration.trim() } : {}) };
      return existing ? put<Project>(`/api/projects/${existing.id}`, body) : post<Project>('/api/projects', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onNext();
    },
  });
  return (
    <Card title="Group repositories into a project">
      <div className="flex flex-col gap-4">
        <Input label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop" />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-[13px] font-medium">Repositories</legend>
          {boot.repos.map((r) => (
            <Checkbox key={r.id} checked={repoIds.includes(r.id)} onChange={(on) => setRepoIds(on ? [...repoIds, r.id] : repoIds.filter((x) => x !== r.id))} label={r.name} description={ROLE_LABEL[r.role]} />
          ))}
          <p className="mt-1 text-[12.5px] text-muted">For separate repos, Tandem builds the backend first and the frontend against the approved API contract.</p>
        </fieldset>
        <RadioCards
          label="PM approval"
          value={pmGate}
          onChange={setPmGate}
          options={[
            { value: 'tandem', label: 'Recorded in Tandem', description: 'You share the spec and record the PM’s approval with evidence.' },
            { value: 'jira', label: 'Via Jira replies', description: boot.jiraConfigured ? 'Tandem posts the spec and waits for the PM to reply "approve".' : 'Set up Jira first.', disabled: !boot.jiraConfigured },
            { value: 'off', label: 'Off', description: 'Owner approval only.' },
          ]}
          columns={3}
        />
        {pmGate === 'tandem' && <Input label="PM names" value={pmNames} onChange={(e) => setPmNames(e.target.value)} placeholder="Pat Lee" help="Comma-separated; offered when you record an approval." />}
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Task key prefix" value={keyPrefix} onChange={(e) => setKeyPrefix(e.target.value.toUpperCase())} help="Local tasks are numbered TND-1, TND-2, …" />
          <Input label="Integration command (optional)" value={integration} onChange={(e) => setIntegration(e.target.value)} placeholder="npm run e2e" help="Runs in the task folder after each repo's checks." />
        </div>
        {save.isError && <ErrorState error={save.error} />}
      </div>
      <Nav onBack={onBack} onNext={() => save.mutate()} nextLabel={existing ? 'Save and continue' : 'Create project'} busy={save.isPending} nextDisabled={!name.trim() || repoIds.length === 0} />
    </Card>
  );
}

function ConnectStep({ boot, onNext, onBack }: { boot: Bootstrap; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const [host, setHost] = useState(boot.settings.copilot.host);
  const [profile, setProfile] = useState(boot.settings.aws.profile);
  const [owner, setOwner] = useState(boot.settings.ownerName);
  const save = useMutation({
    mutationFn: () => put('/api/settings', { ...boot.settings, ownerName: owner, copilot: { ...boot.settings.copilot, host: host.trim() }, aws: { ...boot.settings.aws, profile: profile.trim() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onNext();
    },
  });
  return (
    <Card title="Copilot and AWS">
      <div className="flex flex-col gap-4">
        <Input label="Your name" value={owner} onChange={(e) => setOwner(e.target.value)} help="Shown on your approvals." />
        <Input label="Copilot host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" help="Leave empty for github.com. If your Copilot comes from a GitHub Enterprise host (for example company.ghe.com), enter it here." />
        <Input label="AWS profile for CodeCommit" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default" help="Used for git over HTTPS and to open pull requests. Without permission to create PRs, Tandem gives you a console link instead." />
        {save.isError && <ErrorState error={save.error} />}
      </div>
      <Nav onBack={onBack} onNext={() => save.mutate()} busy={save.isPending} />
    </Card>
  );
}

function JiraStep({ boot, onNext, onBack }: { boot: Bootstrap; onNext: () => void; onBack: () => void }) {
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(boot.settings.jira.baseUrl);
  const [email, setEmail] = useState(boot.settings.jira.email);
  const [token, setToken] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      await put('/api/settings', { ...boot.settings, jira: { ...boot.settings.jira, baseUrl: baseUrl.trim(), email: email.trim() } });
      if (token.trim()) await put('/api/secrets/jira-token', { value: token.trim() });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onNext();
    },
  });
  return (
    <Card title="Jira (optional)" actions={<Pill>{boot.jiraConfigured ? 'Configured' : 'Not configured'}</Pill>}>
      <p className="mb-4 text-[13px] text-muted">Tandem works fully without Jira. Skip this now and turn it on later in Settings by adding a token.</p>
      <div className="flex flex-col gap-4">
        <Input label="Jira URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-company.atlassian.net" />
        <Input label="Account email (Jira Cloud)" value={email} onChange={(e) => setEmail(e.target.value)} help="Leave empty for Jira Data Center with a personal access token." />
        <Input label="API token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} help="Stored in your OS keychain, never in files or the database." />
        {save.isError && <ErrorState error={save.error} />}
      </div>
      <div className="mt-6 flex justify-between">
        <Button onClick={onBack}>Back</Button>
        <div className="flex gap-2">
          <Button onClick={onNext}>Skip for now</Button>
          <Button variant="primary" busy={save.isPending} disabled={!baseUrl.trim() || !token.trim()} onClick={() => save.mutate()}>
            Save Jira
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CheckStep({ onBack }: { onBack: () => void }) {
  const { navigate } = useRouter();
  const qc = useQueryClient();
  const run = useMutation({ mutationFn: () => post<DoctorReport>('/api/doctor'), onSuccess: () => void qc.invalidateQueries({ queryKey: ['bootstrap'] }) });
  return (
    <Card title="Check your setup" actions={<Button variant="primary" busy={run.isPending} onClick={() => run.mutate()}>{run.data ? 'Run again' : 'Run doctor'}</Button>}>
      {!run.data && !run.isPending && <p className="text-[13px] text-muted">Doctor checks git, your repositories, Copilot (without using any of your Copilot budget), AWS and Jira.</p>}
      {run.isPending && <Loading label="Running checks…" rows={4} />}
      {run.isError && <ErrorState error={run.error} />}
      {run.data && (
        <div className="flex flex-col gap-4">
          <DoctorSummary report={run.data} />
          <DoctorList report={run.data} />
        </div>
      )}
      <div className="mt-6 flex justify-between">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" onClick={() => navigate('/chat')}>
          Finish and open chat
        </Button>
      </div>
    </Card>
  );
}
