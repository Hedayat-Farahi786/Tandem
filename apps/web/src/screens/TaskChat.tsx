import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, MessageSquareText, ThumbsUp, X, type LucideIcon } from 'lucide-react';
import type { TaskState } from '@tandem/shared';
import { api } from '../lib/api';
import { STATE_LABEL, relativeTime } from '../lib/format';
import { useEvents } from '../lib/events';
import type { TaskDetail } from '../lib/types';
import { BrandLogo, hostBrand } from '../ui/brands';
import { Button, ErrorState, IconButton, Loading, Pill, Spinner, TabPanel, Tabs, cx } from '../ui/kit';
import { StatusIcon } from '../ui/visual';
import { ThreadPanel, type TimelineItem } from './Chat';
import { RunCard, type RunActivity } from './TaskActivity';
import { SkipCheckButton } from './SkipCheck';

/** The parts of a task that open beside its conversation. */
export type PanelTab = 'overview' | 'spec' | 'changes' | 'checks' | 'prs' | 'trace';

/** Runs that already show as chat answers (or belong to the request chat) are not repeated. */
const CHAT_RUNS = new Set(['task-chat', 'ask', 'request']);
const SPEC_SOURCE: Record<string, string> = { draft: 'Drafted by Copilot', redraft: 'Redrafted with your feedback', edit: 'Edited by you' };
const PR_STATUS: Record<string, { label: string; tone: 'ok' | 'neutral' | 'accent' | 'warn' }> = {
  open: { label: 'Open', tone: 'accent' },
  merged: { label: 'Merged', tone: 'ok' },
  closed: { label: 'Closed', tone: 'neutral' },
  'manual-pending': { label: 'To create', tone: 'warn' },
};

/** Which round of checks: fix attempts count up; later rounds have fixed numbers for their moment. */
const roundLabel = (n: number) => (n < 100 ? `attempt ${n + 1}` : n === 100 ? 'after review fixes' : n === 150 ? 'after an interrupted run' : n === 200 ? 'after the rebase' : n === 300 ? 'on the pull request' : 'again');

const When = ({ at }: { at: string }) => (
  <time dateTime={at} title={new Date(at).toLocaleString()} className="shrink-0 text-[12px] text-faint tabular-nums">
    {relativeTime(at)}
  </time>
);

/** A quiet line for something that happened: a state change, an approval. */
function Milestone({ icon, title, body, at }: { icon: ReactNode; title: string; body?: string; at: string }) {
  return (
    <div className="flex items-start gap-2.5 px-1 text-[13px]">
      <span aria-hidden className="mt-[3px] grid size-4 shrink-0 place-items-center">
        {icon}
      </span>
      <p className="min-w-0 flex-1 leading-relaxed">
        <span className="font-medium text-fg">{title}</span>
        {body && <span className="text-muted"> · {body}</span>}
      </p>
      <span className="mt-px">
        <When at={at} />
      </span>
    </div>
  );
}

/** Something Copilot produced (a spec, checks, a pull request): opens beside the conversation. */
function ArtifactCard({ icon: Icon, logo, title, sub, at, badge, open, openLabel, extra }: { icon?: LucideIcon; logo?: ReactNode; title: string; sub?: ReactNode; at: string; badge?: ReactNode; open: () => void; openLabel: string; extra?: ReactNode }) {
  return (
    <div className="flex animate-in items-center gap-3 rounded-xl bg-surface px-3.5 py-3 shadow-panel">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-muted shadow-[0_0_0_1px_var(--border)]">
        {logo ?? (Icon && <Icon className="size-4" strokeWidth={1.9} />)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium">{title}</span>
          {badge}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
          <span className="min-w-0 truncate">{sub}</span>
          <span aria-hidden className="text-faint">·</span>
          <When at={at} />
        </p>
      </div>
      {extra}
      <Button size="sm" onClick={open}>
        {openLabel}
      </Button>
    </div>
  );
}

/** States in which Tandem itself (not only Copilot) is busy with the task. */
const WORKING = new Set<TaskState>(['READINESS', 'SPEC_DRAFTING', 'BUILDING', 'VERIFYING', 'SELF_REVIEW']);
const DOING: Partial<Record<TaskState, string>> = {
  READINESS: 'Checking the request',
  SPEC_DRAFTING: 'Getting the spec ready',
  BUILDING: 'Preparing the workspace',
  VERIFYING: 'Running the checks',
  SELF_REVIEW: 'Bringing the branch up to date',
};
const CHECK_KIND: Record<string, string> = { install: 'installing dependencies', lint: 'lint', typecheck: 'type check', build: 'build', test: 'tests', 'test-single': 'one test', integration: 'integration tests' };
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * What Tandem is doing when Copilot isn't (installing, building, running the tests): a live line at
 * the end of the conversation, with the latest output, so a long step never looks stuck.
 */
function TandemWorking({ taskId, state, since, repos }: { taskId: string; state: TaskState; since: string; repos: TaskDetail['repos'] }) {
  const [now, setNow] = useState(() => Date.now());
  const [out, setOut] = useState<{ kind: string; repoId?: string | undefined; line: string; from: number } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEvents((e) => {
    if (e.type === 'verify.output' && e.taskId === taskId && e.line.trim()) setOut((o) => ({ kind: e.kind, repoId: e.repoId, line: e.line.trim(), from: o && o.kind === e.kind && o.repoId === e.repoId ? o.from : Date.now() }));
  });
  return (
    <div role="status" className="flex animate-in items-start gap-3 rounded-xl px-1 py-1">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted">
        <Spinner className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-[13.5px]">
          <span className="shimmer-text font-medium">{DOING[state] ?? STATE_LABEL[state]}</span>
          {out && state === 'VERIFYING' && <span className="text-[13px] text-muted">· {CHECK_KIND[out.kind] ?? out.kind}</span>}
          <span className="ml-auto shrink-0 text-[12px] text-faint tabular-nums">{clock(now - Date.parse(since))}</span>
        </p>
        {out && <p className="mt-0.5 truncate font-mono text-[12px] text-faint" title={out.line}>{out.line}</p>}
        {/* A check that runs on and on (a test runner waiting for changes, say) can be skipped. */}
        {out && state === 'VERIFYING' && now - out.from > 60_000 && (
          <div className="mt-2 flex animate-in items-center gap-2 text-[12px] text-muted">
            <span>Taking long?</span>
            <SkipCheckButton taskId={taskId} repoId={out.repoId} repoName={repos.length > 1 ? repos.find((r) => r.id === out.repoId)?.name : undefined} kind={out.kind} variant="secondary" label={`Skip ${out.kind === 'test-single' ? 'tests' : out.kind === 'typecheck' ? 'type check' : out.kind === 'test' ? 'tests' : out.kind}`} />
          </div>
        )}
      </div>
    </div>
  );
}

function RunItem({ run }: { run: RunActivity }) {
  const [open, setOpen] = useState(run.status === 'running');
  return (
    <ol className="list-none">
      <RunCard run={run} open={open} onToggle={() => setOpen(!open)} />
    </ol>
  );
}

/** Everything that happened on a task, as one conversation. */
function useTimeline(d: TaskDetail, threadId: string | undefined, openPanel: (t: PanelTab) => void): { items: TimelineItem[]; copilotWorking: boolean } {
  const activity = useQuery({
    queryKey: ['task-activity', d.task.id],
    queryFn: () => api<RunActivity[]>(`/api/tasks/${d.task.id}/activity`),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 5_000 : 30_000),
  });
  const items = useMemo(() => {
    const t = d.task;
    const items: TimelineItem[] = [];
    // The request that started it all, as your first message.
    items.push({ at: t.createdAt, key: 'request', message: { id: 'request', threadId: threadId ?? '', role: 'user', content: t.description.trim() || t.requirement.goal.trim() || t.title, refs: [], createdAt: t.createdAt } });
    for (const [i, x] of d.transitions.entries()) {
      if (x.from === x.to && i > 0) continue;
      // The spec and pull request cards already say these.
      if ((x.to === 'SPEC_REVIEW' && d.specs.length) || (x.to === 'PR_OPEN' && d.prs.length)) continue;
      items.push({ at: x.at, key: `tr-${i}`, node: <Milestone icon={<StatusIcon state={x.to as TaskState} className="size-3.5" />} title={STATE_LABEL[x.to]} body={x.reason} at={x.at} /> });
    }
    for (const r of activity.data ?? []) if (!CHAT_RUNS.has(r.kind)) items.push({ at: r.startedAt, key: `run-${r.id}`, node: <RunItem run={r} /> });
    for (const s of d.specs)
      items.push({
        at: s.createdAt,
        key: `spec-${s.version}`,
        node: <ArtifactCard icon={FileText} title={`Spec v${s.version}`} sub={s.feedback ? `${SPEC_SOURCE[s.source] ?? 'Updated'}: “${s.feedback}”` : (SPEC_SOURCE[s.source] ?? 'Updated')} at={s.createdAt} open={() => openPanel('spec')} openLabel="Open spec" />,
      });
    for (const a of d.approvals)
      items.push({ at: a.createdAt, key: `ap-${a.id}`, node: <Milestone icon={<ThumbsUp className="size-3.5 text-ok" strokeWidth={2} />} title={`${a.name} approved spec v${a.specVersion}`} body={a.role === 'pm' ? `as PM${a.method === 'jira' ? ', in Jira' : ''}` : 'as owner'} at={a.createdAt} /> });
    for (const v of d.verifyRuns) {
      const passed = v.results.filter((r) => !r.skipped && !r.preexisting && r.exitCode === 0 && !r.timedOut).length;
      const extra = [v.results.filter((r) => r.preexisting).length ? `${v.results.filter((r) => r.preexisting).length} failing before this change too` : '', v.results.filter((r) => r.skipped).length ? `${v.results.filter((r) => r.skipped).length} skipped` : ''].filter(Boolean).join(', ');
      items.push({
        at: v.createdAt,
        key: `vr-${v.id}`,
        node: (
          <ArtifactCard
            icon={v.passed ? CheckCircle2 : AlertTriangle}
            title={v.passed ? 'Checks passed' : 'Checks failed'}
            badge={v.attempt > 0 ? <span className="text-[12px] text-faint">{roundLabel(v.attempt)}</span> : undefined}
            sub={`${passed} of ${v.results.length} command${v.results.length === 1 ? '' : 's'} passed${extra ? ` · ${extra}` : ''}`}
            at={v.createdAt}
            open={() => openPanel('checks')}
            openLabel="View checks"
          />
        ),
      });
    }
    for (const pr of d.prs) {
      const repo = d.repos.find((r) => r.id === pr.repoId);
      const st = PR_STATUS[pr.status] ?? { label: pr.status, tone: 'neutral' as const };
      items.push({
        at: pr.createdAt,
        key: `pr-${pr.id}`,
        node: (
          <ArtifactCard
            logo={repo ? <BrandLogo brand={hostBrand(repo.host.kind)} size={17} /> : undefined}
            title={pr.title || 'Pull request'}
            badge={<Pill tone={st.tone}>{st.label}</Pill>}
            sub={repo?.name ?? 'repo'}
            at={pr.createdAt}
            open={() => openPanel('prs')}
            openLabel="View"
            extra={
              pr.url && !pr.manual ? (
                <a href={pr.url} target="_blank" rel="noreferrer" aria-label={`Open the pull request in ${repo?.name ?? 'the repository'}`} className="grid size-8 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg">
                  <ExternalLink aria-hidden className="size-4" />
                </a>
              ) : undefined
            }
          />
        ),
      });
    }
    for (const c of d.comments) items.push({ at: c.createdAt, key: `c-${c.id}`, node: <Milestone icon={<MessageSquareText className="size-3.5 text-muted" strokeWidth={2} />} title={c.authorName} body={c.body} at={c.createdAt} /> });
    return items;
  }, [d, threadId, activity.data, openPanel]);
  return { items, copilotWorking: Boolean(activity.data?.some((r) => r.status === 'running' && !CHAT_RUNS.has(r.kind))) };
}

/**
 * A task as a conversation: the request, Copilot's work, the spec, checks and pull requests in
 * order, with the composer at the bottom. The details (spec, changes, checks...) open beside it.
 */
export function TaskChatView({ d, panel, setPanel, tabs, renderPanel, banner }: { d: TaskDetail; panel: PanelTab | null; setPanel: (t: PanelTab | null) => void; tabs: Array<{ id: PanelTab; label: string; badge?: ReactNode }>; renderPanel: (t: PanelTab) => ReactNode; banner: ReactNode }) {
  const thread = useQuery({ queryKey: ['task-thread', d.task.id], queryFn: () => api<{ id: string }>(`/api/tasks/${d.task.id}/thread`) });
  const { items: timeline, copilotWorking } = useTimeline(d, thread.data?.id, setPanel);
  const since = d.transitions.at(-1)?.at ?? d.task.updatedAt;
  // Escape closes the panel when it covers the conversation (narrow screens).
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !window.matchMedia('(min-width: 1024px)').matches) setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, setPanel]);
  return (
    <div data-layout={panel ? 'split' : 'single'} className={cx('grid gap-6', panel && 'lg:grid-cols-[minmax(380px,1fr)_minmax(0,1.25fr)]')}>
      <section aria-label="Conversation" className={cx('flex min-w-0 flex-col', !panel && 'mx-auto w-full max-w-[780px]')}>
        {thread.isLoading ? (
          <Loading />
        ) : thread.isError || !thread.data ? (
          <ErrorState error={thread.error} retry={() => void thread.refetch()} />
        ) : (
          <ThreadPanel
            threadId={thread.data.id}
            repos={d.repos}
            placeholder="Ask about the spec, the build or the checks, or tell Copilot what to change…"
            compact
            task={{ id: d.task.id, state: d.task.state, needsAttention: d.task.needsAttention }}
            timeline={timeline}
            tail={
              <>
                {WORKING.has(d.task.state) && !copilotWorking && <TandemWorking taskId={d.task.id} state={d.task.state} since={since} repos={d.repos} />}
                <div className="empty:hidden">{banner}</div>
              </>
            }
          />
        )}
      </section>
      {panel && (
        <>
          <button type="button" aria-label="Close details" tabIndex={-1} onClick={() => setPanel(null)} className="fixed inset-0 z-30 animate-in bg-[rgb(0_0_0/0.25)] lg:hidden" />
          <aside
            aria-label="Task details"
            className="fixed inset-y-2 right-2 left-2 z-40 flex animate-in flex-col overflow-hidden rounded-2xl bg-bg shadow-lg sm:left-auto sm:w-[min(680px,calc(100vw-1rem))] lg:sticky lg:inset-auto lg:top-6 lg:z-auto lg:h-[calc(100dvh-5.5rem)] lg:w-auto lg:self-start lg:bg-surface lg:shadow-panel"
          >
            <div className="flex items-center gap-2 pr-2 pl-5">
              <div className="min-w-0 flex-1">
                <Tabs label="Task details" value={panel} onChange={setPanel} tabs={tabs} />
              </div>
              <IconButton icon={X} label="Close details" size="sm" onClick={() => setPanel(null)} />
            </div>
            <div className="@container min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <TabPanel id={panel}>{renderPanel(panel)}</TabPanel>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
