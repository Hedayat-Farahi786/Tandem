import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { STEPS, type TaskState, type VerifyRun } from '@tandem/shared';
import { api } from '../lib/api';
import { plainReason } from '../lib/format';
import { useEvents } from '../lib/events';
import type { TaskDetail } from '../lib/types';
import { describe } from '../ui/agent-steps';
import { cx } from '../ui/kit';
import type { RunActivity } from './TaskActivity';

/*
 * Where a task is, stage by stage: a labelled tracker under the task's title and, beside the
 * conversation, a Progress panel with each stage's status, time and steps (the live one in detail).
 */

/** Runs that belong to a chat, not to the task's own stages. */
const CHAT_RUNS = new Set(['task-chat', 'ask', 'request']);

/** The task's runs with their steps; shared (same query key) with the conversation. */
export function useTaskActivity(taskId: string) {
  return useQuery({
    queryKey: ['task-activity', taskId],
    queryFn: () => api<RunActivity[]>(`/api/tasks/${taskId}/activity`),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 5_000 : 30_000),
  });
}

export const FLOW = ['READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN', 'DONE'] as const;
type FlowState = (typeof FLOW)[number];

const STAGE: Record<FlowState, { short: string; title: string; about: string }> = {
  READINESS: { short: 'Readiness', title: 'Check the request', about: 'Tandem checks the request has what Copilot needs, and sizes the work.' },
  SPEC_DRAFTING: { short: 'Spec', title: 'Write the spec', about: 'Copilot reads the code and writes a spec with acceptance criteria.' },
  SPEC_REVIEW: { short: 'Approval', title: 'Approve the spec', about: 'Nothing is built until the spec is approved.' },
  BUILDING: { short: 'Build', title: 'Build', about: 'Copilot writes the code, and a test for each acceptance criterion, in its own workspace.' },
  VERIFYING: { short: 'Checks', title: 'Run the checks', about: 'Tandem runs each repository’s lint, type check, build and tests. Failures go back to Copilot to fix.' },
  SELF_REVIEW: { short: 'Self-review', title: 'Review the work', about: 'Copilot reviews the change against the spec, then Tandem brings the branch up to date and pushes it.' },
  PR_OPEN: { short: 'Pull request', title: 'Pull requests', about: 'Tandem opens a pull request in each repository and follows it until it is merged.' },
  DONE: { short: 'Done', title: 'Done', about: 'Merged. Tandem cleans up the workspace.' },
};

/** Each runner step: what it is, and a few words for the tracker while it runs. */
const SUB: Record<string, { label: string; now: string; copilot?: boolean }> = {
  'check-ready': { label: 'Check the request has what it needs', now: 'Checking' },
  'check-size': { label: 'Size the work', now: 'Sizing', copilot: true },
  'refresh-refs': { label: 'Read the latest code', now: 'Reading the code' },
  draft: { label: 'Copilot writes the spec', now: 'Copilot writing', copilot: true },
  'await-pm': { label: 'Approval', now: 'Waiting for approval' },
  'prepare-workspace': { label: 'Prepare a workspace', now: 'Preparing' },
  implement: { label: 'Copilot writes the code and tests', now: 'Copilot coding', copilot: true },
  commit: { label: 'Commit the changes', now: 'Committing' },
  verify: { label: 'Run the checks', now: 'Running the checks' },
  review: { label: 'Copilot reviews its work against the spec', now: 'Copilot reviewing', copilot: true },
  'review-fix': { label: 'Copilot fixes what the review found', now: 'Copilot fixing findings', copilot: true },
  'review-verify': { label: 'Run the checks again', now: 'Running the checks again' },
  sync: { label: 'Bring the branch up to date', now: 'Updating the branch' },
  push: { label: 'Push the branch', now: 'Pushing' },
  'open-prs': { label: 'Open the pull requests', now: 'Opening pull requests' },
  report: { label: 'Report to the tracker', now: 'Reporting' },
  poll: { label: 'Wait for review and merge', now: 'Awaiting review' },
  cleanup: { label: 'Clean up the workspace', now: 'Cleaning up' },
};

const CHECK_ORDER = ['install', 'lint', 'typecheck', 'build', 'test'] as const;
const CHECK_NAME: Record<string, string> = { install: 'Install dependencies', lint: 'Lint', typecheck: 'Type check', build: 'Build', test: 'Tests', 'test-single': 'Tests', integration: 'Integration tests' };

export type StageStatus = 'done' | 'active' | 'waiting' | 'blocked' | 'failed' | 'stopped' | 'upcoming';

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "All 5 checks passed" or "4 of 5 passed · 1 already failing · 1 skipped". */
export function checksLine(v: VerifyRun): string {
  const passed = v.results.filter((r) => !r.skipped && !r.preexisting && r.exitCode === 0 && !r.timedOut).length;
  const pre = v.results.filter((r) => r.preexisting).length;
  const skipped = v.results.filter((r) => r.skipped).length;
  const extra = [pre ? `${pre} already failing` : '', skipped ? `${skipped} skipped` : ''].filter(Boolean).join(' · ');
  return passed === v.results.length ? `All ${passed} check${passed === 1 ? '' : 's'} passed` : `${passed} of ${v.results.length} passed${extra ? ` · ${extra}` : ''}`;
}

/** A clock that ticks once a second while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The check running right now (from its live output), per task. */
function useLiveCheck(taskId: string, on: boolean) {
  const [live, setLive] = useState<{ repoId?: string | undefined; kind: string } | null>(null);
  useEvents((e) => {
    if (on && e.type === 'verify.output' && e.taskId === taskId) setLive((l) => (l && l.kind === e.kind && l.repoId === e.repoId ? l : { repoId: e.repoId, kind: e.kind }));
  });
  useEffect(() => {
    if (!on) setLive(null);
  }, [on]);
  return live;
}

export interface Stage {
  state: FlowState;
  index: number;
  status: StageStatus;
  /** Time spent in the stage, over every visit (a fix loop comes back to Build). */
  ms: number;
  visits: number;
}

const WORKING = new Set<TaskState>(['READINESS', 'SPEC_DRAFTING', 'BUILDING', 'VERIFYING', 'SELF_REVIEW']);

/** Which stage the task is at, and whether it is moving, waiting or stopped there. */
function position(d: TaskDetail): { at: number; step: string | undefined } {
  const t = d.task;
  const idx = (s: TaskState | undefined) => (s ? FLOW.indexOf(s as FlowState) : -1);
  // Stopped or cancelled: the stage it was at (where it resumes, or the last one it reached).
  const reached = [...d.transitions].reverse().find((x) => FLOW.includes(x.to as FlowState))?.to;
  if (t.state === 'BLOCKED' || t.state === 'FAILED') return { at: Math.max(0, idx(t.resumeTo?.state ?? reached)), step: t.resumeTo?.step };
  if (t.state === 'CANCELLED') return { at: Math.max(0, idx(reached)), step: undefined };
  return { at: idx(t.state), step: t.step };
}

export function stagesOf(d: TaskDetail, now: number): { stages: Stage[]; at: number; step: string | undefined } {
  const t = d.task;
  const { at, step: raw } = position(d);
  const step = refineStep(d, raw);
  const time = new Map<string, { ms: number; visits: number }>();
  d.transitions.forEach((x, i) => {
    if (x.from === x.to && i > 0) return;
    const end = d.transitions[i + 1]?.at;
    const ms = (end ? Date.parse(end) : t.state === x.to && !['DONE', 'CANCELLED'].includes(t.state) ? now : Date.parse(x.at)) - Date.parse(x.at);
    const prev = time.get(x.to) ?? { ms: 0, visits: 0 };
    time.set(x.to, { ms: prev.ms + Math.max(0, ms), visits: prev.visits + 1 });
  });
  const stages = FLOW.map((state, index): Stage => {
    let status: StageStatus = 'upcoming';
    if (t.state === 'DONE' || index < at) status = 'done';
    else if (index === at)
      status =
        t.state === 'FAILED' ? 'failed'
        : t.state === 'BLOCKED' ? 'blocked'
        : t.state === 'CANCELLED' ? 'stopped'
        : t.needsAttention ? 'blocked'
        : WORKING.has(t.state) ? 'active'
        : 'waiting';
    const tm = time.get(state);
    return { state, index, status, ms: tm?.ms ?? 0, visits: tm?.visits ?? 0 };
  });
  return { stages, at, step };
}

/* ------------------------------------------------------------------ marks */

/** A stage's mark: a check when done, a moving arc while it works, its number before it starts. */
export function StageMark({ status, n, size = 20 }: { status: StageStatus; n: number; size?: number }) {
  const box = { width: size, height: size };
  if (status === 'done')
    return (
      <svg viewBox="0 0 20 20" style={box} className="shrink-0 text-ok" aria-hidden>
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path d="M6.2 10.3 8.7 12.8 13.8 7.4" fill="none" stroke="var(--surface)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === 'active')
    return (
      <span style={box} className="relative grid shrink-0 place-items-center text-accent-text" aria-hidden>
        <svg viewBox="0 0 20 20" style={box} className="absolute inset-0 animate-spin [animation-duration:1.1s] motion-reduce:animate-none">
          <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <path d="M10 1.75a8.25 8.25 0 0 1 8.25 8.25" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="size-[30%] rounded-full bg-current" />
      </span>
    );
  if (status === 'waiting')
    return (
      <span style={box} className="relative grid shrink-0 place-items-center text-warn" aria-hidden>
        <svg viewBox="0 0 20 20" style={box} className="absolute inset-0">
          <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span className="size-[34%] animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      </span>
    );
  if (status === 'blocked' || status === 'failed')
    return (
      <svg viewBox="0 0 20 20" style={box} className={cx('shrink-0', status === 'failed' ? 'text-danger' : 'text-warn')} aria-hidden>
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path d="M10 5.6v5.2" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="10" cy="14" r="1.2" fill="var(--surface)" />
      </svg>
    );
  if (status === 'stopped')
    return (
      <svg viewBox="0 0 20 20" style={box} className="shrink-0 text-faint" aria-hidden>
        <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.4" />
        <path d="M7.2 7.2 12.8 12.8M12.8 7.2 7.2 12.8" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  return (
    <span style={{ ...box, fontSize: Math.round(size * 0.52) }} className="grid shrink-0 place-items-center rounded-full font-medium text-faint tabular-nums shadow-[inset_0_0_0_1.5px_var(--border-strong,var(--border))]" aria-hidden>
      {n}
    </span>
  );
}

const STATUS_WORD: Record<StageStatus, string> = { done: 'done', active: 'in progress', waiting: 'waiting', blocked: 'needs you', failed: 'stopped', stopped: 'cancelled', upcoming: 'not started' };

/** The steps of a stage as people see them: the self-review's fix and re-check show once they happen. */
function stepsOf(d: TaskDetail, state: FlowState): string[] {
  const steps = (STEPS[state] as readonly string[]).filter((s) => s !== 'cleanup' || state === 'DONE');
  if (state !== 'SELF_REVIEW' || d.task.progress.reviewFixStarted !== true) return steps;
  return steps.flatMap((s) => (s === 'review' ? ['review', 'review-fix', 'review-verify'] : [s]));
}

/** The runner's step, split where one step does several things (the review: review, fix, check again). */
export function refineStep(d: TaskDetail, step: string | undefined): string | undefined {
  const p = d.task.progress;
  if (step !== 'review' || p.reviewed !== true) return step;
  if (p.reviewFixDone === true) return 'review-verify';
  if (p.reviewFixStarted === true) return 'review-fix';
  return step;
}

/** What the current stage is doing, in a few words: "Copilot coding", "Running tests", "Waiting for you". */
function nowWords(d: TaskDetail, s: Stage, step: string | undefined, liveCheck: { kind: string } | null): string {
  if (s.status === 'failed') return 'Stopped';
  if (s.status === 'blocked') return 'Needs you';
  if (s.status === 'stopped') return 'Cancelled';
  if (s.state === 'SPEC_REVIEW') return d.approvalState?.owner ? 'Waiting for the PM' : 'Waiting for you';
  if (s.state === 'PR_OPEN') return 'Awaiting review';
  if (liveCheck && (s.state === 'VERIFYING' || step === 'review-verify')) return `Running ${(CHECK_NAME[liveCheck.kind] ?? liveCheck.kind).toLowerCase()}`;
  if (s.state === 'BUILDING' && step === 'implement' && Number(d.task.progress.fixAttempts ?? 0) > 0) return 'Copilot fixing';
  return (step && SUB[step]?.now) || 'Working';
}

/** What Tandem is doing right now, for the conversation's live line. */
export function doingNow(d: TaskDetail, liveKind: string | undefined): string {
  const { stages, at, step } = stagesOf(d, Date.now());
  const cur = at >= 0 ? stages[at] : undefined;
  if (!cur) return 'Working';
  if (step && SUB[step]?.copilot && !(step === 'review-verify')) return 'Getting Copilot started';
  return nowWords(d, cur, step, liveKind ? { kind: liveKind } : null);
}

/* ------------------------------------------------------------------ tracker */

/**
 * Where the task is, in one quiet line and a thin bar: the stage, what is happening now and for how
 * long. Click it for every stage, its time and the live steps.
 */
export function StageTracker({ d }: { d: TaskDetail }) {
  const running = WORKING.has(d.task.state) || d.task.state === 'SPEC_REVIEW' || d.task.state === 'PR_OPEN';
  const now = useNow(running);
  const liveCheck = useLiveCheck(d.task.id, d.task.state === 'VERIFYING' || d.task.state === 'SELF_REVIEW');
  const { stages, at, step } = stagesOf(d, now);
  const cur = at >= 0 ? stages[at] : undefined;
  const done = d.task.state === 'DONE';
  const words = cur ? nowWords(d, cur, step, liveCheck) : 'Not started';
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const live = cur && (cur.status === 'active' || cur.status === 'waiting');
  const tone = !cur ? 'text-faint' : cur.status === 'failed' ? 'text-danger' : cur.status === 'blocked' || cur.status === 'waiting' ? 'text-warn' : cur.status === 'active' ? 'text-accent-text' : 'text-muted';
  const summary = done ? 'All stages done' : cur ? `Step ${at + 1} of ${FLOW.length}: ${STAGE[cur.state].short}, ${words}` : 'Not started yet';
  return (
    <div ref={box} className="relative shrink-0 pb-3 lg:border-b lg:border-line lg:px-4 lg:pt-2 lg:pb-2.5">
      <button ref={trigger} type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} className="group flex w-full flex-col gap-1.5 rounded-lg text-left outline-offset-2">
        <span className="sr-only">{summary}. Show all stages</span>
        <span aria-hidden className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-5">
          <span className="shrink-0 font-medium text-fg">{done ? 'Done' : cur ? STAGE[cur.state].short : 'Not started'}</span>
          {cur && !done && (
            <>
              <span className="text-faint">·</span>
              <span key={words} className={cx('min-w-0 animate-in truncate', tone)}>{words}</span>
              {live && cur.ms >= 1000 && <span className="shrink-0 text-faint tabular-nums">{duration(cur.ms)}</span>}
            </>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-faint tabular-nums transition-colors group-hover:text-muted">
            {done ? `${FLOW.length} of ${FLOW.length}` : `${Math.max(at, 0) + 1} of ${FLOW.length}`}
            <ChevronDown className={cx('size-3.5 transition-transform duration-200', open && 'rotate-180')} />
          </span>
        </span>
        <span aria-hidden className="flex gap-[3px]">
          {stages.map((s) => (
            <span
              key={s.state}
              className={cx(
                'h-[3px] flex-1 rounded-full transition-colors duration-500',
                s.status === 'done' ? 'bg-ok' : s.status === 'active' ? 'animate-pulse bg-accent/45 motion-reduce:animate-none' : s.status === 'failed' ? 'bg-danger' : s.status === 'blocked' || s.status === 'waiting' ? 'bg-warn' : s.status === 'stopped' ? 'bg-line-strong' : 'bg-surface-3',
              )}
            />
          ))}
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Task stages" className="absolute top-full left-0 z-40 mt-1.5 w-[min(420px,calc(100vw-16px))] animate-pop rounded-2xl bg-surface p-4 shadow-lg ring-1 ring-line lg:left-4">
          <StageList d={d} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

type Sub = { key: string; label: string; status: StageStatus; detail?: string | undefined; live?: boolean };

function SubRow({ s }: { s: Sub }) {
  return (
    <li className="flex items-start gap-2 py-[3px]">
      <span className="mt-[3px]">
        {s.status === 'upcoming' ? (
          <span aria-hidden className="grid size-[14px] place-items-center">
            <span className="size-[7px] rounded-full shadow-[inset_0_0_0_1.5px_var(--border-strong,var(--border))]" />
          </span>
        ) : (
          <StageMark status={s.status} n={0} size={14} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx('block text-[12.5px] leading-5', s.status === 'upcoming' ? 'text-muted' : s.status === 'active' ? 'font-medium text-fg' : 'text-fg')}>
          {s.label}
          <span className="sr-only">, {STATUS_WORD[s.status]}</span>
        </span>
        {s.detail && <span key={s.detail} className={cx('block truncate text-[12px] leading-5', s.live ? 'shimmer-text animate-in' : 'text-muted')} title={s.detail}>{s.detail}</span>}
      </span>
    </li>
  );
}

/** The steps of the stage the task is at, each with its status; the live one says what is happening. */
function subStepsOf(d: TaskDetail, stage: Stage, step: string | undefined, liveCheck: { repoId?: string | undefined; kind: string } | null, copilotNow: string | undefined): Array<{ title?: string; items: Sub[] }> {
  const all = stepsOf(d, stage.state);
  const at = step ? all.indexOf(step) : -1;
  const here = stage.status;
  if (stage.state === 'SPEC_REVIEW') {
    const a = d.approvalState;
    const pm = d.project.pmGate !== 'off';
    return [{ items: [
      { key: 'owner', label: a?.owner ? `Approved by ${a.owner.name}` : 'Your approval', status: a?.owner ? 'done' : 'waiting', detail: a?.owner ? undefined : 'Open the spec to approve it or ask for changes' },
      ...(pm ? [{ key: 'pm', label: a?.pm ? `Approved by ${a.pm.name} (PM)` : d.project.pmGate === 'jira' ? 'PM approval in Jira' : 'PM approval', status: (a?.pm ? 'done' : a?.owner ? 'waiting' : 'upcoming') as StageStatus }] : []),
    ] }];
  }
  if (stage.state === 'VERIFYING') {
    const repos = d.repos.filter((r) => CHECK_ORDER.some((k) => r.commands[k]));
    const liveRepo = liveCheck ? repos.findIndex((r) => r.id === liveCheck.repoId) : -1;
    return repos.map((r, ri) => {
      const kinds = CHECK_ORDER.filter((k) => r.commands[k]);
      const liveKind = liveCheck ? CHECK_ORDER.indexOf((liveCheck.kind === 'test-single' ? 'test' : liveCheck.kind) as (typeof CHECK_ORDER)[number]) : -1;
      return {
        ...(repos.length > 1 ? { title: r.name } : {}),
        items: kinds.map((k): Sub => {
          const ki = CHECK_ORDER.indexOf(k);
          if (stage.status !== 'active') {
            // Stopped here: how each check came out the last time it ran.
            const res = d.verifyRuns.at(-1)?.results.find((x) => x.kind === k && (x.repoId ?? r.id) === r.id);
            if (!res) return { key: k, label: CHECK_NAME[k]!, status: 'upcoming' };
            if (res.skipped) return { key: k, label: CHECK_NAME[k]!, status: 'stopped', detail: 'Skipped' };
            if (res.preexisting) return { key: k, label: CHECK_NAME[k]!, status: 'done', detail: `Already failing on ${res.preexisting.base}` };
            return { key: k, label: CHECK_NAME[k]!, status: res.exitCode === 0 && !res.timedOut ? 'done' : 'failed', ...(res.timedOut ? { detail: 'Timed out' } : {}) };
          }
          const status: StageStatus = !liveCheck ? 'upcoming' : ri < liveRepo || (ri === liveRepo && ki < liveKind) ? 'done' : ri === liveRepo && ki === liveKind ? 'active' : 'upcoming';
          return { key: k, label: CHECK_NAME[k]!, status, ...(status === 'active' ? { detail: liveCheck?.kind === 'test-single' ? 'Running the tests linked to each criterion' : `$ ${r.commands[k]}` } : {}) };
        }),
      };
    });
  }
  return [{ items: all.map((s, i): Sub => {
    const status: StageStatus = stage.status === 'done' ? 'done' : at < 0 ? 'upcoming' : i < at ? 'done' : i === at ? here : 'upcoming';
    const fixing = s === 'implement' && Number(d.task.progress.fixAttempts ?? 0) > 0;
    return {
      key: s,
      label: fixing ? `Copilot fixes the failing checks (attempt ${Number(d.task.progress.fixAttempts)})` : (SUB[s]?.label ?? s),
      status,
      ...(i === at && stage.status === 'active' && SUB[s]?.copilot && copilotNow
        ? { detail: `${copilotNow}…`, live: true }
        : i === at && stage.status === 'active' && s === 'review-verify' && liveCheck
          ? { detail: `Running ${(CHECK_NAME[liveCheck.kind] ?? liveCheck.kind).toLowerCase()}…`, live: true }
          : {}),
    };
  }) }];
}

/** A done stage in a few words: what came out of it. */
function outcome(d: TaskDetail, s: FlowState): string | undefined {
  switch (s) {
    case 'READINESS':
      return 'The request had what Copilot needs';
    case 'SPEC_DRAFTING': {
      const v = d.specs.at(-1);
      return v ? `Spec v${v.version}` : undefined;
    }
    case 'SPEC_REVIEW': {
      const a = d.approvalState;
      return a?.owner ? `Approved by ${a.owner.name}${a.pm ? ` and ${a.pm.name} (PM)` : ''}` : undefined;
    }
    case 'BUILDING': {
      // Fix runs before the self-review fixed failing checks; the ones after it fixed review findings.
      const review = d.runs.find((r) => r.kind === 'review')?.startedAt;
      const fixes = d.runs.filter((r) => r.kind === 'fix' && (!review || r.startedAt < review)).length;
      return fixes ? `Built, then fixed failing checks ${fixes === 1 ? 'once' : `${fixes} times`}` : 'Built by Copilot';
    }
    case 'VERIFYING': {
      const v = d.verifyRuns.at(-1);
      return v ? checksLine(v) : undefined;
    }
    case 'SELF_REVIEW': {
      const n = d.findings.length;
      const open = d.findings.filter((f) => f.status === 'open').length;
      return n === 0 ? 'No findings' : open ? `${n} finding${n === 1 ? '' : 's'}, ${open} still open` : `${n} finding${n === 1 ? '' : 's'}, all resolved`;
    }
    case 'PR_OPEN':
      return d.prs.length ? `${d.prs.length} pull request${d.prs.length === 1 ? '' : 's'}${d.prs.every((p) => p.status === 'merged') ? ', merged' : ''}` : undefined;
    case 'DONE':
      return 'Merged and cleaned up';
  }
}

/** Every stage of the task in order, with its status and time; the current one shows its steps. */
export function StageList({ d }: { d: TaskDetail }) {
  const ticking = WORKING.has(d.task.state) || d.task.state === 'SPEC_REVIEW' || d.task.state === 'PR_OPEN';
  const now = useNow(ticking);
  const liveCheck = useLiveCheck(d.task.id, d.task.state === 'VERIFYING' || d.task.state === 'SELF_REVIEW');
  const activity = useTaskActivity(d.task.id);
  const run = activity.data?.find((r) => r.status === 'running' && !CHAT_RUNS.has(r.kind));
  const lastStep = run ? [...run.steps].reverse().find((s) => s.kind !== 'prompt' && s.kind !== 'message' && s.kind !== 'intent') : undefined;
  const intent = run ? [...run.steps].reverse().find((s) => s.kind === 'intent')?.text : undefined;
  const copilotNow = run ? (lastStep ? describe(lastStep, true) : (intent ?? 'Getting started')) : undefined;
  const { stages, at, step } = stagesOf(d, now);
  const cur = at >= 0 ? stages[at] : undefined;
  const subs = cur ? subStepsOf(d, cur, step, liveCheck, copilotNow) : [];
  const total = stages.reduce((n, s) => n + (s.state === 'SPEC_REVIEW' || s.state === 'PR_OPEN' || s.state === 'DONE' ? 0 : s.ms), 0);
  const reason = d.task.state === 'BLOCKED' || d.task.state === 'FAILED' ? plainReason(d.transitions.at(-1)?.reason ?? '') : '';
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium">Stages</p>
        {total >= 1000 && <p className="shrink-0 text-[12px] text-faint tabular-nums" title="Time Tandem and Copilot spent working, without the waits for approval and review">{duration(total)} of work</p>}
      </div>
      <ol aria-label="Stages" className="flex flex-col">
        {stages.map((s, i) => {
          const isCur = s.index === at && d.task.state !== 'DONE';
          const last = i === stages.length - 1;
          const out = s.status === 'done' ? outcome(d, s.state) : undefined;
          return (
            <li key={s.state} className="relative flex gap-3" aria-current={isCur ? 'step' : undefined}>
              {!last && <span aria-hidden className={cx('absolute top-[22px] bottom-0.5 left-[8.5px] w-px', s.status === 'done' ? 'bg-ok/40' : 'bg-line')} />}
              <span className="mt-px">
                <StageMark status={s.status} n={i + 1} size={18} />
              </span>
              <div className={cx('min-w-0 flex-1', last ? '' : 'pb-3')}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className={cx('text-[13px] leading-5', s.status === 'upcoming' ? 'text-muted' : 'font-medium text-fg')}>
                    {STAGE[s.state].title}
                    {s.state === 'VERIFYING' && s.visits > 1 && <span className="font-normal text-faint"> · ran {s.visits} times</span>}
                    <span className="sr-only">, {STATUS_WORD[s.status]}</span>
                  </p>
                  {s.status !== 'upcoming' && s.ms >= 1000 && <span className={cx('shrink-0 text-[12px] tabular-nums', isCur && s.status === 'active' ? 'text-accent-text' : 'text-faint')}>{duration(s.ms)}</span>}
                </div>
                {out && <p className="text-[12.5px] leading-5 text-muted">{out}</p>}
                {isCur && reason && <p className={cx('text-[12.5px] leading-5', d.task.state === 'FAILED' ? 'text-danger' : 'text-warn')}>{reason}</p>}
                {isCur && !reason && <p className="text-[12.5px] leading-5 text-muted">{STAGE[s.state].about}</p>}
                {isCur && s.status !== 'stopped' && subs.some((g) => g.items.length) && (
                  <div className="mt-1.5">
                    {subs.map((g, gi) => (
                      <div key={g.title ?? gi} className={cx(gi > 0 && 'mt-1')}>
                        {g.title && <p className="pt-0.5 text-[12px] font-medium text-muted">{g.title}</p>}
                        <ol>
                          {g.items.map((it) => (
                            <SubRow key={it.key} s={it} />
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
