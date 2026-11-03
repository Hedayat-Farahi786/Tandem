import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ChevronRight, Cloud, FolderGit2, GitBranch, Pencil, Plus, Sparkles } from 'lucide-react';
import type { Project, Repo, RepoCommands, RepoRole, Rule } from '@tandem/shared';
import { api, post, put } from '../lib/api';
import type { Bootstrap, TaskListItem } from '../lib/types';
import { IconTile, LangDot, Monogram } from '../ui/visual';
import { Button, LinkButton, SettingsSection, Dialog, EmptyState, ErrorState, Input, Loading, RadioCards, Select, cx, useToast } from '../ui/kit';
import { ROLE_LABEL } from './Setup';

const COMMANDS: Array<{ key: keyof RepoCommands; label: string; placeholder: string }> = [
  { key: 'install', label: 'Install', placeholder: 'npm ci' },
  { key: 'lint', label: 'Lint', placeholder: 'npm run lint' },
  { key: 'typecheck', label: 'Type-check', placeholder: 'npm run typecheck' },
  { key: 'build', label: 'Build', placeholder: 'npm run build' },
  { key: 'test', label: 'Test', placeholder: 'npm test' },
  { key: 'testSingle', label: 'Single test', placeholder: 'npx vitest run {file} -t {name}' },
];

export function RepoCommandsEditor({ value, onChange }: { value: RepoCommands; onChange: (c: RepoCommands) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {COMMANDS.map((c) => (
        <Input
          key={c.key}
          label={c.label}
          optional
          className="font-mono text-[12.5px]"
          value={value[c.key] ?? ''}
          placeholder={c.placeholder}
          onChange={(e) => {
            const next = { ...value };
            if (e.target.value.trim()) next[c.key] = e.target.value;
            else delete next[c.key];
            onChange(next);
          }}
          {...(c.key === 'testSingle' ? { help: 'Runs one test per acceptance criterion. {file} and {name} are filled in.' } : {})}
        />
      ))}
    </div>
  );
}

function RepoDialog({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState(repo);
  const save = useMutation({
    mutationFn: () => put<Repo>(`/api/repos/${repo.id}`, { defaultBranch: draft.defaultBranch, role: draft.role, commands: draft.commands, name: draft.name }),
    onSuccess: () => {
      toast(`Saved ${draft.name}.`, 'ok');
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Edit ${repo.name}`}
      description="Tandem runs these commands to verify every change. The build agent may run them too."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Input label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <Input label="Default branch" value={draft.defaultBranch} onChange={(e) => setDraft({ ...draft, defaultBranch: e.target.value })} />
        <Select label="Role" value={draft.role} onChange={(role: RepoRole) => setDraft({ ...draft, role })} options={(Object.keys(ROLE_LABEL) as RepoRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      </div>
      <RepoCommandsEditor value={draft.commands} onChange={(commands) => setDraft({ ...draft, commands })} />
      {save.isError && <ErrorState error={save.error} />}
    </Dialog>
  );
}

function ProjectDialog({ project, repos, jira, onClose }: { project: Project; repos: Repo[]; jira: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState({ ...project, pmNamesText: project.pmNames.join(', '), pmIdsText: project.jiraPmAccountIds.join(', ') });
  const save = useMutation({
    mutationFn: () =>
      put<Project>(`/api/projects/${project.id}`, {
        name: d.name,
        repoIds: d.repoIds,
        contractOrder: d.contractOrder,
        specRepoId: d.specRepoId,
        pmGate: d.pmGate,
        pmNames: d.pmNamesText.split(',').map((s) => s.trim()).filter(Boolean),
        jiraPmAccountIds: d.pmIdsText.split(',').map((s) => s.trim()).filter(Boolean),
        keyPrefix: d.keyPrefix,
        ...(d.integrationCommand?.trim() ? { integrationCommand: d.integrationCommand.trim() } : {}),
        ...(d.jiraJql?.trim() ? { jiraJql: d.jiraJql.trim() } : {}),
      }),
    onSuccess: () => {
      toast('Project saved.', 'ok');
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      onClose();
    },
  });
  const inProject = repos.filter((r) => d.repoIds.includes(r.id));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Edit ${project.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Input label="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <Input label="Task key prefix" value={d.keyPrefix} onChange={(e) => setD({ ...d, keyPrefix: e.target.value.toUpperCase() })} />
        <Select label="Spec is committed to" value={d.specRepoId} onChange={(specRepoId) => setD({ ...d, specRepoId })} options={inProject.map((r) => ({ value: r.id, label: r.name }))} />
        <Input label="Integration command" optional value={d.integrationCommand ?? ''} onChange={(e) => setD({ ...d, integrationCommand: e.target.value })} placeholder="npm run e2e" />
      </div>
      <RadioCards
        label="PM approval"
        value={d.pmGate}
        onChange={(pmGate) => setD({ ...d, pmGate })}
        columns={3}
        options={[
          { value: 'tandem', label: 'Recorded in Tandem', description: 'Share the spec, record the approval.' },
          { value: 'jira', label: 'Via Jira replies', description: jira ? 'Only configured PMs count.' : 'Set up Jira first.', disabled: !jira },
          { value: 'off', label: 'Off', description: 'Owner approval only.' },
        ]}
      />
      {d.pmGate === 'tandem' && <Input label="PM names" value={d.pmNamesText} onChange={(e) => setD({ ...d, pmNamesText: e.target.value })} help="Comma-separated." />}
      {d.pmGate === 'jira' && <Input label="Jira account IDs of PMs" value={d.pmIdsText} onChange={(e) => setD({ ...d, pmIdsText: e.target.value })} help="Only replies from these accounts count as approval." />}
      {jira && <Input label="Import query (JQL)" optional value={d.jiraJql ?? ''} onChange={(e) => setD({ ...d, jiraJql: e.target.value })} placeholder='project = SHOP AND status = "Ready for AI"' />}
      {save.isError && <ErrorState error={save.error} />}
    </Dialog>
  );
}

function RulesSection({ repos }: { repos: Repo[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/api/rules') });
  const [adding, setAdding] = useState(false);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => post<Rule>('/api/rules', { repoId, text, source: 'Added in Tandem' }),
    onSuccess: () => {
      setText('');
      setAdding(false);
      toast('Rule saved. The next task in that repository follows it.', 'ok');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });
  return (
    <>
      <SettingsSection
        icon={<IconTile icon={Sparkles} />}
        title="Agent rules"
        description="Things the agent should always do in a repository, learned from reviews."
        actions={
          repos.length > 0 && (
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setAdding(true)}>
              Add rule
            </Button>
          )
        }
      >
        {rules.isLoading ? (
          <div className="py-3">
            <Loading rows={2} />
          </div>
        ) : !rules.data?.length ? (
          <p className="py-4 text-[13px] text-muted">No rules yet. Save one from a review finding, or add it here.</p>
        ) : (
          rules.data.map((r) => (
            <div key={r.id} className="flex items-baseline justify-between gap-4 py-3 text-[14px]">
              <span className="min-w-0">
                {r.text}
                <span className="text-[13px] text-faint"> · {repos.find((x) => x.id === r.repoId)?.name ?? 'Removed repo'}</span>
              </span>
              <span className={cx('shrink-0 text-[12.5px]', r.status === 'committed' ? 'text-ok' : 'text-faint')}>{r.status === 'committed' ? 'In the repo' : 'Next task'}</span>
            </div>
          ))
        )}
      </SettingsSection>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a rule"
        description="It's added to docs/agent-rules.md on the repository's next task branch, and every later build and review follows it."
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" busy={add.isPending} disabled={!text.trim()} onClick={() => add.mutate()}>
              Add rule
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {repos.length > 1 && <Select label="Repository" value={repoId} onChange={setRepoId} options={repos.map((r) => ({ value: r.id, label: r.name }))} />}
          <Input label="Rule" value={text} onChange={(e) => setText(e.target.value)} placeholder="Validate every query parameter with zod." autoFocus />
          {add.isError && <ErrorState error={add.error} />}
        </div>
      </Dialog>
    </>
  );
}

export function ProjectsScreen() {
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<TaskListItem[]>('/api/tasks') });
  const [editRepo, setEditRepo] = useState<Repo | null>(null);
  const [editProject, setEditProject] = useState<Project | null>(null);
  if (boot.isLoading) return <Loading />;
  if (boot.isError || !boot.data) return <ErrorState error={boot.error} retry={() => void boot.refetch()} />;
  const { projects, repos } = boot.data;
  const pm = (p: Project) => (p.pmGate === 'tandem' ? 'PM approves in Tandem' : p.pmGate === 'jira' ? 'PM approves in Jira' : 'No PM approval');
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] leading-tight">Projects</h1>
          <p className="mt-1 text-[13.5px] text-muted">Repositories grouped into the products you build.</p>
        </div>
        <LinkButton to="/setup" variant="primary" icon={Plus}>
          Add repository
        </LinkButton>
      </div>
      {projects.length === 0 && <EmptyState icon={FolderGit2} title="No projects yet" body="Run the setup wizard to add repositories and group them into a project." action={<LinkButton to="/setup" variant="primary">Open setup</LinkButton>} />}
      {projects.map((p) => {
        const list = p.contractOrder.map((id) => repos.find((x) => x.id === id)).filter((r): r is Repo => Boolean(r));
        const mine = (tasks.data ?? []).filter((t) => t.projectId === p.id);
        const stats = [
          ['Open', mine.filter((t) => !['DONE', 'CANCELLED', 'PR_OPEN'].includes(t.state)).length],
          ['In review', mine.filter((t) => t.state === 'PR_OPEN').length],
          ['Done', mine.filter((t) => t.state === 'DONE').length],
        ] as const;
        return (
          <section key={p.id} aria-label={p.name} className="rounded-2xl bg-surface p-5 shadow-panel">
            <div className="flex items-start gap-4">
              <Monogram name={p.name} size={44} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[17px] font-semibold tracking-tight">{p.name}</h2>
                <p className="mt-0.5 text-[13px] text-muted">
                  {pm(p)} · tasks {p.keyPrefix}-1, {p.keyPrefix}-2…
                </p>
              </div>
              <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditProject(p)} aria-label={`Edit ${p.name}`}>
                Edit
              </Button>
            </div>
            <dl className="mt-5 grid grid-cols-3 divide-x divide-line rounded-xl bg-surface-2/60 py-3">
              {stats.map(([k, v], i) => (
                <div key={k} className="flex items-center gap-2.5 px-4">
                  <span aria-hidden className={cx('size-2 rounded-full', i === 0 ? 'bg-info' : i === 1 ? 'bg-warn' : 'bg-ok')} />
                  <dt className="text-[12.5px] text-muted">{k}</dt>
                  <dd className="ml-auto font-display text-[20px] leading-none tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-4 divide-y divide-line">
              {list.map((r, n) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setEditRepo(r)} title={r.url} className="group flex w-full items-center gap-3 py-3 text-left">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-muted shadow-[0_0_0_1px_var(--border)]">
                      {r.host.kind === 'github' ? <GitBranch aria-hidden className="size-4" /> : <Cloud aria-hidden className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium underline-offset-4 group-hover:underline">{r.name}</span>
                      <span className="mt-0.5 flex items-center gap-2 truncate text-[12.5px] text-muted">
                        <LangDot language={r.language} />
                        {[r.language, r.framework].filter(Boolean).join(' · ') || 'Unknown stack'}
                      </span>
                    </span>
                    <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                      <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-muted">{ROLE_LABEL[r.role]}</span>
                      {p.specRepoId === r.id && list.length > 1 && <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-muted">Specs</span>}
                      {list.length > 1 && <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-muted tabular-nums">Step {n + 1}</span>}
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-fg" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <RulesSection repos={repos} />
      <p className="flex items-center gap-2 text-[12.5px] text-faint">
        <BookOpen aria-hidden className="size-3.5" />
        Tandem also reads each repository's .github/copilot-instructions.md and .github/agents/.
      </p>
      {editRepo && <RepoDialog repo={editRepo} onClose={() => setEditRepo(null)} />}
      {editProject && <ProjectDialog project={editProject} repos={repos} jira={boot.data.jiraConfigured} onClose={() => setEditProject(null)} />}
    </div>
  );
}
