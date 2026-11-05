import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Clock3, FolderGit2, MessageSquarePlus, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { BrandLogo, TechStack, hostBrand } from '../ui/brands';
import { Link } from '../lib/router';
import type { Project, Repo, RepoCommands, RepoRole, Rule } from '@tandem/shared';
import { api, del, post, put } from '../lib/api';
import type { Bootstrap, TaskListItem } from '../lib/types';
import { ProjectAvatar } from '../ui/visual';
import { JiraPeoplePicker, useJiraProjects } from '../ui/jira-connect';
import { Button, IconButton, LinkButton, Dialog, EmptyState, ErrorState, Input, Loading, RadioCards, Select, Textarea, cx, useToast } from '../ui/kit';
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
          className="font-mono text-[13px]"
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
  const [d, setD] = useState({ ...project, pmNamesText: project.pmNames.join(', '), ownQuery: Boolean(project.jiraJql?.trim()) });
  const jiraProjects = useJiraProjects(jira);
  const save = useMutation({
    mutationFn: () =>
      put<Project>(`/api/projects/${project.id}`, {
        name: d.name,
        repoIds: d.repoIds,
        contractOrder: d.contractOrder,
        specRepoId: d.specRepoId,
        pmGate: d.pmGate,
        pmNames: d.pmNamesText.split(',').map((s) => s.trim()).filter(Boolean),
        jiraPmAccountIds: d.jiraPmAccountIds,
        jiraPmNames: d.jiraPmNames,
        ...(d.jiraProjectKey ? { jiraProjectKey: d.jiraProjectKey } : {}),
        keyPrefix: d.keyPrefix,
        ...(d.integrationCommand?.trim() ? { integrationCommand: d.integrationCommand.trim() } : {}),
        ...(d.ownQuery && d.jiraJql?.trim() ? { jiraJql: d.jiraJql.trim() } : {}),
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
      {d.pmGate === 'jira' && <JiraPeoplePicker ids={d.jiraPmAccountIds} names={d.jiraPmNames} onChange={(ids, names) => setD({ ...d, jiraPmAccountIds: ids, jiraPmNames: names })} />}
      {jira && (
        <div className="flex flex-col items-start gap-1.5">
          {d.ownQuery ? (
            <Input label="Issues for this project (JQL)" value={d.jiraJql ?? ''} onChange={(e) => setD({ ...d, jiraJql: e.target.value })} placeholder='project = SHOP AND status = "Ready for AI"' className="font-mono text-[13px]" />
          ) : (
            <Select
              label="Jira project"
              value={d.jiraProjectKey ?? ''}
              onChange={(key) => setD({ ...d, jiraProjectKey: key || undefined })}
              placeholder={jiraProjects.isLoading ? 'Loading Jira projects…' : 'Choose the Jira project'}
              help="Its issues in the status chosen in Settings › Jira become tasks of this project."
              options={[{ value: '', label: 'Any Jira project' }, ...(jiraProjects.data?.projects ?? []).map((p) => ({ value: p.key, label: p.name, description: p.key }))]}
            />
          )}
          <button type="button" onClick={() => setD({ ...d, ownQuery: !d.ownQuery })} className="text-[12.5px] font-medium text-muted hover:text-fg hover:underline">
            {d.ownQuery ? 'Choose a Jira project instead' : 'Write the query yourself (JQL)'}
          </button>
          {jiraProjects.isError && <ErrorState error={jiraProjects.error} />}
        </div>
      )}
      {save.isError && <ErrorState error={save.error} />}
    </Dialog>
  );
}

/** Starting points that read naturally to anyone; picking one fills the rule in. */
const RULE_EXAMPLES = [
  'Show a friendly message when something fails to load.',
  'Every new page needs a loading state.',
  'Write a test for every bug fix.',
  "Don't change the database structure without asking first.",
];

function RuleDialog({ repos, initial, onClose }: { repos: Repo[]; initial: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(initial);
  const [repoId, setRepoId] = useState(repos.length > 1 ? 'all' : (repos[0]?.id ?? ''));
  const targets = repoId === 'all' ? repos.map((r) => r.id) : [repoId];
  const add = useMutation({
    mutationFn: async () => {
      for (const id of targets) await post<Rule>('/api/rules', { repoId: id, text: text.trim(), source: 'Added in Tandem' });
    },
    onSuccess: () => {
      toast('Rule added. Copilot follows it from the next task.', 'ok');
      void qc.invalidateQueries({ queryKey: ['rules'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a rule"
      description="Write it the way you'd brief a new teammate. Copilot follows it every time it changes the code."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={add.isPending} disabled={!text.trim() || !targets.length} onClick={() => add.mutate()}>
            Add rule
          </Button>
        </>
      }
    >
      <Textarea id="rule-text" label="Rule" value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: show prices with the currency symbol, like €12.50." rows={3} className="min-h-0" autoFocus />
      <div>
        <p className="mb-2 text-[13px] text-muted">Or start from an example</p>
        <div className="flex flex-wrap gap-1.5">
          {RULE_EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => setText(ex)} className={cx('rounded-full px-3 py-1 text-left text-[13px] shadow-[0_0_0_1px_var(--border)] transition-colors duration-150 hover:bg-surface-2 hover:text-fg', text === ex ? 'bg-surface-2 text-fg' : 'text-muted')}>
              {ex}
            </button>
          ))}
        </div>
      </div>
      {repos.length > 1 && (
        <Select
          label="Where does it apply?"
          value={repoId}
          onChange={setRepoId}
          options={[{ value: 'all', label: 'All repositories' }, ...repos.map((r) => ({ value: r.id, label: r.name, description: ROLE_LABEL[r.role] }))]}
        />
      )}
      {add.isError && <ErrorState error={add.error} />}
    </Dialog>
  );
}

function RulesSection({ repos }: { repos: Repo[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/api/rules') });
  const [adding, setAdding] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/rules/${id}`),
    onSuccess: () => {
      toast('Rule removed.', 'ok');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'danger'),
  });
  const repoOf = (id: string) => repos.find((x) => x.id === id);
  return (
    <>
      <section aria-labelledby="rules-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="rules-title" className="text-[17px] font-semibold tracking-[-0.01em]">
              Rules for Copilot
            </h2>
            <p className="mt-0.5 text-[13px] text-muted">Short instructions Copilot follows every time it changes your code.</p>
          </div>
          {repos.length > 0 && (
            <Button size="sm" icon={Plus} onClick={() => setAdding('')}>
              Add rule
            </Button>
          )}
        </div>
        <div className="overflow-hidden rounded-2xl bg-surface shadow-panel">
        <div className="divide-y divide-line px-5">
        {rules.isLoading ? (
          <div className="py-4">
            <Loading rows={2} />
          </div>
        ) : !rules.data?.length ? (
          <div className="py-5">
            <p className="text-[13px] text-muted">No rules yet. Write them in plain words, or start from one of these:</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {RULE_EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setAdding(ex)} disabled={!repos.length} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-left text-[13px] text-muted shadow-[0_0_0_1px_var(--border)] transition-colors duration-150 hover:bg-surface-2 hover:text-fg">
                  <Plus aria-hidden className="size-3" />
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          rules.data.map((r) => {
            const repo = repoOf(r.repoId);
            return (
              <div key={r.id} className="group flex items-start gap-3 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-snug break-words">{r.text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      {repo && <BrandLogo brand={hostBrand(repo.host.kind)} size={12} />}
                      {repo?.name ?? 'A removed repository'}
                    </span>
                    <span aria-hidden className="text-faint">·</span>
                    {r.status === 'committed' ? (
                      <span className="inline-flex items-center gap-1 text-ok">
                        <CheckCircle2 aria-hidden className="size-3" /> Saved in the repository
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Clock3 aria-hidden className="size-3" /> Starts with the next task
                      </span>
                    )}
                  </p>
                </div>
                {r.status !== 'committed' && (
                  <IconButton icon={Trash2} label="Remove rule" size="sm" onClick={() => remove.mutate(r.id)} disabled={remove.isPending} className="opacity-70 group-hover:opacity-100" />
                )}
              </div>
            );
          })
        )}
        </div>
        </div>
        <p className="mt-3 px-1 text-[12px] text-faint">Copilot also follows the instruction files already in your repositories: .github/copilot-instructions.md and .github/agents/.</p>
      </section>
      {adding !== null && <RuleDialog repos={repos} initial={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

/** How a project's specs get approved, in a few words. */
const GATE: Record<string, string> = { off: 'Your approval', tandem: 'You and a PM approve', jira: 'You and a PM approve in Jira' };

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'accent' | 'ok' }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-5 last:pr-5">
      <p className={cx('text-[19px] leading-tight font-semibold tracking-[-0.01em] tabular-nums', value === 0 ? 'text-faint' : tone === 'accent' ? 'text-accent-text' : tone === 'ok' ? 'text-ok' : 'text-fg')}>{value}</p>
      <p className="mt-0.5 truncate text-[12px] text-muted">{label}</p>
    </div>
  );
}

/** One project as a card: who it is, how its work is going, and the repositories Copilot works in. */
function ProjectCard({ p, repos, tasks, onEdit, onRepo }: { p: Project; repos: Repo[]; tasks: TaskListItem[]; onEdit: () => void; onRepo: (r: Repo) => void }) {
  // The project's repositories, in the order Tandem builds them.
  const rank = (id: string) => (p.contractOrder.includes(id) ? p.contractOrder.indexOf(id) : p.contractOrder.length);
  const list = p.repoIds
    .map((id) => repos.find((x) => x.id === id))
    .filter((r): r is Repo => Boolean(r))
    .sort((a, b) => rank(a.id) - rank(b.id));
  const mine = tasks.filter((t) => t.projectId === p.id);
  const open = mine.filter((t) => !['DONE', 'CANCELLED', 'PR_OPEN'].includes(t.state)).length;
  const review = mine.filter((t) => t.state === 'PR_OPEN').length;
  const done = mine.filter((t) => t.state === 'DONE').length;
  return (
    <article aria-labelledby={`project-${p.id}`} className="flex min-w-0 flex-col rounded-2xl bg-surface shadow-panel transition-shadow duration-200 hover:shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_rgb(0_0_0/0.04)]">
      <header className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <ProjectAvatar name={p.name} projectId={p.id} size={42} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 id={`project-${p.id}`} className="truncate text-[16px] font-semibold tracking-[-0.01em]">
              {p.name}
            </h2>
            <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-px text-[11px] font-medium tracking-wide text-muted tabular-nums" title={`Task keys start with ${p.keyPrefix}`}>
              {p.keyPrefix}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12.5px] text-muted">
            <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-faint" />
            {GATE[p.pmGate] ?? 'Your approval'}
          </p>
        </div>
        <IconButton icon={Pencil} label={`Edit ${p.name}`} size="sm" onClick={onEdit} />
      </header>
      <div className="mx-5 grid grid-cols-3 divide-x divide-line rounded-xl bg-surface-2/60 [&>div]:!px-3.5">
        <Stat value={open} label="In progress" tone="accent" />
        <Stat value={review} label="In review" />
        <Stat value={done} label="Done" tone="ok" />
      </div>
      <div className="flex-1 px-5 pt-4 pb-2">
        <p className="mb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">{list.length === 1 ? 'Repository' : `${list.length} repositories`}</p>
        <ul className="-mx-2.5">
          {list.map((r, n) => (
            <li key={r.id}>
              <button type="button" onClick={() => onRepo(r)} title={r.url} className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface shadow-[0_0_0_1px_var(--border)]">
                  <BrandLogo brand={hostBrand(r.host.kind)} size={16} title={r.host.kind === 'github' ? 'GitHub' : 'AWS CodeCommit'} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{r.name}</span>
                  <TechStack language={r.language} framework={r.framework} className="mt-0.5 text-[12px] text-muted" />
                </span>
                <span className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                  <span className="rounded-full px-2 py-px text-[11.5px] text-muted shadow-[0_0_0_1px_var(--border)]">{ROLE_LABEL[r.role]}</span>
                  {list.length > 1 && <span className="text-[11px] text-faint">{n === 0 ? 'Builds first' : 'Builds next'}</span>}
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-faint opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
        <span className="text-[12px] text-faint">{mine.length ? `${mine.length} task${mine.length === 1 ? '' : 's'} in all` : 'No tasks yet'}</span>
        <LinkButton to={`/chat?project=${p.id}`} size="sm" variant="ghost" icon={MessageSquarePlus}>
          New chat
        </LinkButton>
      </footer>
    </article>
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
  return (
    <div className="mx-auto w-full max-w-[1040px]">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[28px] leading-tight">Projects</h1>
          <p className="mt-1 text-[14px] text-muted">Your products, and the repositories Copilot works in.</p>
        </div>
        <LinkButton to="/setup" icon={Plus} variant="primary">
          Add repository
        </LinkButton>
      </div>
      {projects.length === 0 ? (
        <EmptyState icon={FolderGit2} title="No projects yet" body="Run the setup wizard to add repositories and group them into a project." action={<LinkButton to="/setup" variant="primary">Open setup</LinkButton>} />
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} repos={repos} tasks={tasks.data ?? []} onEdit={() => setEditProject(p)} onRepo={setEditRepo} />
          ))}
          <Link to="/setup" className="group grid min-h-[120px] place-items-center rounded-2xl border border-dashed md:min-h-[200px] border-line-strong p-6 text-center transition-colors duration-150 hover:border-fg/30 hover:bg-surface/60">
            <span>
              <span className="mx-auto grid size-10 place-items-center rounded-full bg-surface text-muted shadow-[0_0_0_1px_var(--border)] transition-colors group-hover:text-fg">
                <Plus aria-hidden className="size-4.5" />
              </span>
              <span className="mt-3 block text-[14px] font-medium">New project</span>
              <span className="mt-0.5 block text-[12.5px] text-muted">Group repositories that ship together</span>
            </span>
          </Link>
        </div>
      )}
      <div className="mt-12">
        <RulesSection repos={repos} />
      </div>
      {editRepo && <RepoDialog repo={editRepo} onClose={() => setEditRepo(null)} />}
      {editProject && <ProjectDialog project={editProject} repos={repos} jira={boot.data.jiraConfigured} onClose={() => setEditProject(null)} />}
    </div>
  );
}
