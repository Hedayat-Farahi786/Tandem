import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Download, GitPullRequest, Hand, ListTodo, Loader, MessageSquare, Plus, Search, Trash2 } from 'lucide-react';
import { IconTile, StatusIcon } from '../ui/visual';
import type { Criterion, Requirement } from '@tandem/shared';
import { api, post } from '../lib/api';
import { STATE_LABEL, STATE_TONE, relativeTime, stepLabel } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import type { Bootstrap, Readiness, TaskListItem } from '../lib/types';
import { Button, Checkbox, LinkButton, Dialog, EmptyState, ErrorState, Input, Loading, Pill, Select, Textarea, controlBase, cx } from '../ui/kit';
import { InlineText } from '../ui/text';
import { NEEDS_YOU, RUNNING, groupOf } from '../lib/tasks';


export function ReadinessChecklist({ readiness, compact }: { readiness: Readiness; compact?: boolean }) {
  return (
    <ul aria-label="Definition of Ready" className="flex flex-col gap-2">
      {readiness.items.map((i) => (
        <li key={i.id} className="flex gap-2.5 text-[13px]">
          {i.ok ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-faint" />}
          <span className="min-w-0">
            <span className={cx('font-medium', !i.ok && 'text-fg')}>{i.label}</span>
            <span className="sr-only">{i.ok ? ' — done' : ' — missing'}</span>
            {!compact && (
              <span className="block text-[12.5px] break-words text-muted">
                <InlineText text={i.detail} />
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CriteriaEditor({ value, onChange }: { value: Criterion[]; onChange: (c: Criterion[]) => void }) {
  const set = (i: number, k: keyof Criterion, v: string) => onChange(value.map((c, n) => (n === i ? { ...c, [k]: v } : c)));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[13px] font-medium">Acceptance criteria</legend>
      {value.map((c, i) => (
        <div key={i} className="rounded-xl border border-line bg-surface-2/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-muted">Criterion {i + 1}</span>
            <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove criterion ${i + 1}`} onClick={() => onChange(value.filter((_, n) => n !== i))}>
              Remove
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <Input label="Given" value={c.given} onChange={(e) => set(i, 'given', e.target.value)} placeholder="the backend is running" />
            <Input label="When" value={c.when} onChange={(e) => set(i, 'when', e.target.value)} placeholder="GET /health is called" />
            <Input label="Then" value={c.then} onChange={(e) => set(i, 'then', e.target.value)} placeholder="it returns 200 {status: 'ok'}" />
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" icon={Plus} onClick={() => onChange([...value, { given: '', when: '', then: '' }])}>
          Add criterion
        </Button>
      </div>
    </fieldset>
  );
}

const EMPTY: Requirement = { goal: '', userStory: '', criteria: [{ given: '', when: '', then: '' }, { given: '', when: '', then: '' }], exampleData: '', affectedAreas: '', outOfScope: '', openQuestions: [] };

/** Jira: import issues by key, or everything the project's query (or the Settings query) finds. */
function ImportDialog({ boot, onClose }: { boot: Bootstrap; onClose: () => void }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(boot.projects[0]?.id ?? '');
  const [keys, setKeys] = useState('');
  const list = keys.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean);
  const run = useMutation({
    mutationFn: () => post<{ imported: Array<{ id: string; key: string }> }>(`/api/projects/${projectId}/import`, list.length ? { keys: list } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const done = run.data?.imported;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import from Jira"
      description="Each issue becomes a task and goes to the readiness check. Issues already imported are skipped."
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={run.isPending} disabled={!projectId} onClick={() => run.mutate()}>
              {list.length ? `Import ${list.length} issue${list.length > 1 ? 's' : ''}` : 'Import ready issues'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-[13.5px]">{done.length ? `Imported ${done.map((t) => t.key).join(', ')}.` : 'Nothing new to import.'}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {boot.projects.length > 1 && <Select label="Project" value={projectId} onChange={setProjectId} options={boot.projects.map((p) => ({ value: p.id, label: p.name }))} />}
          <Input label="Issue keys" optional value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="SHOP-12, SHOP-15" help="Leave empty to import every issue the project's query finds (or the ready query from Settings)." autoFocus />
          {run.isError && <ErrorState error={run.error} />}
        </div>
      )}
    </Dialog>
  );
}

function NewTaskDialog({ boot, onClose }: { boot: Bootstrap; onClose: () => void }) {
  const qc = useQueryClient();
  const { navigate } = useRouter();
  const [projectId, setProjectId] = useState(boot.projects[0]?.id ?? '');
  const project = boot.projects.find((p) => p.id === projectId);
  const [title, setTitle] = useState('');
  const [req, setReq] = useState<Requirement>(EMPTY);
  const [questions, setQuestions] = useState('');
  const [repoIds, setRepoIds] = useState<string[]>(project?.repoIds ?? []);
  useEffect(() => {
    setRepoIds(project?.repoIds ?? []);
  }, [project]);
  const requirement = useMemo(() => ({ ...req, criteria: req.criteria.filter((c) => c.given || c.when || c.then), openQuestions: questions.split('\n').map((q) => q.trim()).filter(Boolean) }), [req, questions]);
  const readiness = useQuery({ queryKey: ['readiness', requirement], queryFn: () => post<Readiness>('/api/readiness', requirement), placeholderData: (p) => p });
  const create = useMutation({
    mutationFn: (submit: boolean) => post<{ id: string }>('/api/tasks', { projectId, title, requirement, affectedRepoIds: repoIds, submit }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      navigate(`/tasks/${t.id}`);
    },
  });
  const set = (k: keyof Requirement, v: string) => setReq({ ...req, [k]: v });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New task"
      description="Prefer chat? Request mode asks the questions for you. Here you fill in the Definition of Ready yourself."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button busy={create.isPending && create.variables === false} disabled={!title.trim() || !projectId} onClick={() => create.mutate(false)}>
            Save as draft
          </Button>
          <Button variant="primary" busy={create.isPending && create.variables === true} disabled={!title.trim() || !projectId} onClick={() => create.mutate(true)}>
            Create and check readiness
          </Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-[1fr_260px]">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a GET /health endpoint" autoFocus />
            <Select label="Project" value={projectId} onChange={setProjectId} options={boot.projects.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <Textarea label="Goal" value={req.goal} onChange={(e) => set('goal', e.target.value)} placeholder="What should be true when this is done?" />
          <Input label="User story" optional value={req.userStory} onChange={(e) => set('userStory', e.target.value)} placeholder="As a …, I want … so that …" />
          <CriteriaEditor value={req.criteria} onChange={(criteria) => setReq({ ...req, criteria })} />
          <Textarea label="Example data" value={req.exampleData} onChange={(e) => set('exampleData', e.target.value)} placeholder='GET /health → 200 {"status":"ok"}' />
          <div className="grid gap-4 md:grid-cols-2">
            <Textarea label="Affected areas" value={req.affectedAreas} onChange={(e) => set('affectedAreas', e.target.value)} placeholder="API routes, main page" />
            <Textarea label="Out of scope" value={req.outOfScope} onChange={(e) => set('outOfScope', e.target.value)} placeholder="Authentication, metrics" />
          </div>
          <Textarea label="Open questions" optional value={questions} onChange={(e) => setQuestions(e.target.value)} help="One per line. A task is ready only when this is empty." />
          {project && project.repoIds.length > 1 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-[13px] font-medium">Repositories this changes</legend>
              {project.repoIds.map((id) => {
                const r = boot.repos.find((x) => x.id === id);
                return r ? <Checkbox key={id} label={r.name} description={r.role} checked={repoIds.includes(id)} onChange={(on) => setRepoIds(on ? [...repoIds, id] : repoIds.filter((x) => x !== id))} /> : null;
              })}
            </fieldset>
          )}
          {create.isError && <ErrorState error={create.error} />}
        </div>
        <aside className="h-fit rounded-xl border border-line bg-surface-2/60 p-4 md:sticky md:top-0">
          <p className="mb-3 flex items-center justify-between text-[13px] font-semibold">
            Definition of Ready
            {readiness.data && <Pill tone={readiness.data.ready ? 'ok' : 'neutral'}>{readiness.data.ready ? 'Ready' : `${readiness.data.missing.length} missing`}</Pill>}
          </p>
          {readiness.data ? <ReadinessChecklist readiness={readiness.data} compact /> : <Loading rows={3} />}
        </aside>
      </div>
    </Dialog>
  );
}

type Filter = 'all' | 'needs-you' | 'active' | 'finished';

export function TasksScreen() {
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<TaskListItem[]>('/api/tasks'), refetchInterval: 15_000 });
  const [filter, setFilter] = useState<Filter>('all');
  const [projectId, setProjectId] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const list = (tasks.data ?? []).filter(
    (t) =>
      (!projectId || t.projectId === projectId) &&
      (!query.trim() || `${t.title} ${t.key}`.toLowerCase().includes(query.trim().toLowerCase())) &&
      (filter === 'all' || (filter === 'needs-you' && NEEDS_YOU.has(t.state)) || (filter === 'active' && !['DONE', 'CANCELLED'].includes(t.state) && !NEEDS_YOU.has(t.state)) || (filter === 'finished' && ['DONE', 'CANCELLED'].includes(t.state))),
  );
  const counts = {
    all: tasks.data?.length ?? 0,
    'needs-you': tasks.data?.filter((t) => NEEDS_YOU.has(t.state)).length ?? 0,
    active: tasks.data?.filter((t) => !['DONE', 'CANCELLED'].includes(t.state) && !NEEDS_YOU.has(t.state)).length ?? 0,
    finished: tasks.data?.filter((t) => ['DONE', 'CANCELLED'].includes(t.state)).length ?? 0,
  };
  const projectName = (id: string) => boot.data?.projects.find((p) => p.id === id)?.name ?? '';
  return (
    <div className="mx-auto w-full max-w-[760px]">
      <div className="mb-7 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] leading-tight">Tasks</h1>
          <p className="mt-1 text-[13.5px] text-muted">Every request, from spec to pull request.</p>
        </div>
        <div className="flex items-center gap-2">
          {boot.data?.jiraConfigured && (
            <Button variant="ghost" icon={Download} onClick={() => setImporting(true)} disabled={!boot.data.projects.length}>
              Import from Jira
            </Button>
          )}
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!boot.data?.projects.length}>
            New task
          </Button>
        </div>
      </div>
      <div role="group" aria-label="Filter tasks" className="mb-6 grid grid-cols-3 gap-3">
        {(
          [
            ['needs-you', 'Needs you', Hand, 'warn'],
            ['active', 'In progress', Loader, 'neutral'],
            ['finished', 'Finished', CheckCircle2, 'ok'],
          ] as const
        ).map(([id, label, icon, tone]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(filter === id ? 'all' : id)}
            className={cx(
              'group relative flex flex-col items-start gap-4 overflow-hidden rounded-2xl bg-surface p-4 text-left transition-[box-shadow,transform] duration-200 hover:-translate-y-px',
              filter === id ? 'shadow-[0_0_0_1.5px_var(--accent),0_8px_24px_-8px_rgb(0_0_0/0.18)]' : 'shadow-panel hover:shadow-[var(--shadow-panel),0_8px_24px_-10px_rgb(0_0_0/0.14)]',
            )}
          >
            <IconTile icon={icon} tone={counts[id] > 0 ? tone : 'neutral'} />
            <span className="flex w-full items-end justify-between gap-2">
              <span className="text-[13px] font-medium text-muted">{label}</span>
              <span className="font-display text-[30px] leading-none tabular-nums">{counts[id]}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mb-3 flex items-center gap-3">
        <label className="relative block flex-1">
          <span className="sr-only">Search tasks</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your tasks…" className={cx(controlBase, 'h-10 rounded-xl pl-10 text-[14px]')} />
        </label>
        {(boot.data?.projects.length ?? 0) > 1 && (
          <div className="w-48">
            <Select label="Project" hideLabel value={projectId} onChange={setProjectId} options={[{ value: '', label: 'All projects' }, ...(boot.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          </div>
        )}
      </div>
      {tasks.isLoading ? (
        <Loading rows={4} />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} retry={() => void tasks.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title={tasks.data?.length ? 'Nothing here' : 'No tasks yet'}
          body={tasks.data?.length ? (query ? 'No task matches your search.' : 'No task matches this filter.') : 'Describe what you want in chat, and Tandem turns it into a task with a spec and pull requests.'}
          action={!tasks.data?.length && <LinkButton to="/chat" variant="primary" icon={MessageSquare}>Start in chat</LinkButton>}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {(
            [
              ['needs-you', 'Needs you'],
              ['active', 'In progress'],
              ['finished', 'Finished'],
            ] as const
          )
            .map(([id, label]) => [id, label, list.filter((t) => groupOf(t.state) === id)] as const)
            .filter(([, , items]) => items.length > 0)
            .map(([id, label, items]) => (
              <section key={id} aria-label={label} className="overflow-hidden rounded-2xl bg-surface shadow-panel">
                <h2 className="flex h-10 items-center gap-2 border-b border-line bg-surface-2/50 px-4 text-[12.5px] font-semibold text-muted">
                  <span aria-hidden className={cx('size-1.5 rounded-full', id === 'needs-you' ? 'bg-warn' : id === 'active' ? 'bg-info' : 'bg-ok')} />
                  {label}
                  <span className="rounded-full bg-surface-3/70 px-1.5 text-[11px] leading-[18px] font-medium text-muted tabular-nums">{items.length}</span>
                </h2>
                <ul className="flex flex-col divide-y divide-line">
                  {items.map((t) => {
                    const note = t.state === 'BLOCKED' || t.state === 'FAILED' ? t.blockedMessage?.split('\n')[0] : t.needsAttention ? 'Needs attention' : undefined;
                    return (
                      <li key={t.id}>
                        <Link to={`/tasks/${t.id}`} className="group flex items-center gap-3.5 px-4 py-3 transition-colors duration-150 hover:bg-surface-2/70">
                          <StatusIcon state={t.state} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-medium">{t.title}</p>
                            <p className="mt-0.5 truncate text-[12.5px] text-muted">
                              <span className={cx(STATE_TONE[t.state] === 'warn' && 'text-warn', STATE_TONE[t.state] === 'danger' && 'text-danger')}>{RUNNING.has(t.state) && t.step ? stepLabel(t.step) : STATE_LABEL[t.state]}</span>
                              {note && <span> · {note}</span>}
                            </p>
                          </div>
                          <div className="hidden shrink-0 items-center gap-3 text-[12px] text-faint sm:flex">
                            {(boot.data?.projects.length ?? 0) > 1 && projectName(t.projectId) && <span className="max-w-32 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-muted">{projectName(t.projectId)}</span>}
                            {t.prCount > 0 && (
                              <span className="flex items-center gap-1">
                                <GitPullRequest aria-hidden className="size-3.5" />
                                {t.prCount}
                              </span>
                            )}
                            <span className="w-14 font-mono text-[11.5px]">{t.key}</span>
                          </div>
                          <span className="w-16 shrink-0 text-right text-[12px] text-faint tabular-nums">{relativeTime(t.updatedAt)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      )}
      {creating && boot.data && <NewTaskDialog boot={boot.data} onClose={() => setCreating(false)} />}
      {importing && boot.data && <ImportDialog boot={boot.data} onClose={() => setImporting(false)} />}
    </div>
  );
}
