import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentRun, AgentStep } from '@tandem/shared';
import { Brain, ChevronRight, CircleAlert, FileText, FlaskConical, Pencil, Search, ShieldAlert, Terminal, Wrench, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { BrandLogo, providerOf } from '../ui/brands';
import { Collapse, StepTimeline, describe } from '../ui/agent-steps';
import { ProjectAvatar } from '../ui/visual';
import { EmptyState, ErrorState, Loading, Markdown, cx } from '../ui/kit';
import { CreditsInfo } from '../ui/credits-info';

export type RunActivity = AgentRun & { model?: string; prompts: number; modelCalls: number; aiCredits: number; steps: AgentStep[] };

/** What each kind of run is, in plain words. */
const RUN_TITLE: Record<string, string> = {
  extract: 'Read the request',
  size: 'Estimated the size',
  spec: 'Wrote the spec',
  build: 'Built the change',
  fix: 'Fixed failing checks',
  review: 'Reviewed its own work',
  conflict: 'Resolved merge conflicts',
  'task-chat': 'Replied in the task chat',
  request: 'Shaped the request',
  ask: 'Answered a question',
};

const duration = (from: string, to?: string) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const ms = (n?: number) => (n === undefined ? '' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

/** How a tool call reads: an icon and a verb, from the tool's name. */
function toolLook(s: AgentStep): { icon: LucideIcon; text: string } {
  const name = (s.tool ?? '').toLowerCase();
  const what = s.input ? s.input.split('\n')[0] : '';
  if (name === 'tandem_record_test') return { icon: FlaskConical, text: 'Linked a test to an acceptance criterion' };
  if (name.startsWith('tandem_')) return { icon: Wrench, text: s.title ?? name.replace(/^tandem_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) };
  if (s.title) return { icon: /edit|create|write|replace|patch/.test(name) ? Pencil : /bash|shell|powershell|run|exec/.test(name) ? Terminal : /grep|glob|search|find/.test(name) ? Search : FileText, text: s.title };
  if (/edit|create|write|replace|patch/.test(name)) return { icon: Pencil, text: `Edited ${what}` };
  if (/bash|shell|powershell|run|exec/.test(name)) return { icon: Terminal, text: `Ran ${what}` };
  if (/grep|glob|search|find/.test(name)) return { icon: Search, text: `Searched for ${what}` };
  if (/view|read|cat|open|list/.test(name)) return { icon: FileText, text: `Read ${what}` };
  return { icon: Wrench, text: `${s.tool}${what ? ` ${what}` : ''}` };
}

/** A line that opens to show more, like "Thinking" in a chat. */
function Fold({ icon: Icon, label, meta, tone = 'muted', children, defaultOpen = false }: { icon: LucideIcon; label: ReactNode; meta?: ReactNode; tone?: 'muted' | 'danger' | 'warn' | 'ok'; children?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const color = { muted: 'text-muted', danger: 'text-danger', warn: 'text-warn', ok: 'text-ok' }[tone];
  const head = (
    <>
      <Icon aria-hidden className={cx('size-3.5 shrink-0', color)} strokeWidth={2} />
      <span className={cx('min-w-0 flex-1 truncate text-left', tone === 'muted' ? 'text-muted' : color)}>{label}</span>
      {meta && <span className="shrink-0 text-[12px] text-faint tabular-nums">{meta}</span>}
      {children && <ChevronRight aria-hidden className={cx('size-3.5 shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />}
    </>
  );
  return (
    <div className="text-[13px]">
      {children ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 px-2 py-1.5">{head}</div>
      )}
      {open && children && <div className="mt-1 mb-2 ml-8 animate-in">{children}</div>}
    </div>
  );
}

const Pre = ({ text }: { text: string }) => <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-muted">{text}</pre>;

function Message({ text }: { text: string }) {
  const long = text.length > 900;
  const [more, setMore] = useState(false);
  return (
    <div className="px-2 py-1.5">
      <div className={cx('relative', long && !more && 'max-h-56 overflow-hidden')}>
        <Markdown source={text} className="text-[13.5px]" />
        {long && !more && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setMore(!more)} className="mt-1 text-[13px] font-medium text-muted hover:text-fg">
          {more ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

/** What Copilot said between its steps ("Now I'll add the tests…"): quiet, in line with the steps. */
function Narration({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 320;
  return (
    <div className="relative my-1 ml-[11.5px] border-l border-line py-0.5 pl-[23px]">
      <div className={cx('text-[13px] leading-relaxed text-muted [&_.prose-tandem]:text-[13px] [&_.prose-tandem]:text-muted', long && !more && 'line-clamp-3')}>
        <Markdown source={text} />
      </div>
      {long && (
        <button type="button" onClick={() => setMore(!more)} className="mt-0.5 text-[12px] font-medium text-faint transition-colors hover:text-fg">
          {more ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function Step({ s }: { s: AgentStep }) {
  switch (s.kind) {
    case 'prompt':
      // What Tandem told Copilot stays out of the conversation (its fingerprint is in the Trace).
      return null;
    case 'intent':
      return (
        <p className="flex items-center gap-2.5 px-2 py-1 text-[13px] text-muted">
          <span aria-hidden className="grid size-3.5 place-items-center">
            <span className="size-1.5 rounded-full bg-faint" />
          </span>
          {s.text}
        </p>
      );
    case 'reasoning':
      return (
        <Fold icon={Brain} label={<span className="italic">Thinking: {s.text?.split('\n')[0]}</span>}>
          <p className="border-l-2 border-line pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted italic">{s.text}</p>
        </Fold>
      );
    case 'tool': {
      const look = toolLook(s);
      return (
        <Fold
          icon={look.icon}
          label={
            <span className="inline-flex items-center gap-2">
              <span className="truncate">{look.text}</span>
              {s.ok === false && <XCircle aria-label="failed" className="size-3.5 shrink-0 text-danger" />}
            </span>
          }
          meta={ms(s.durationMs)}
          {...(s.ok === false ? { tone: 'danger' as const } : {})}
        >
          {s.output || s.input || s.files?.length ? (
            <div className="flex flex-col gap-2">
              {s.input && !look.text.includes(s.input) && !s.files?.some((f) => f.path === s.input) && <Pre text={s.input} />}
              {s.files?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {s.files.map((f) => (
                    <span key={f.path} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-muted">
                      {f.kind === 'create' ? '+ ' : f.kind === 'delete' ? '− ' : ''}
                      {f.path}
                    </span>
                  ))}
                </div>
              ) : null}
              {s.output && <Pre text={s.output} />}
            </div>
          ) : undefined}
        </Fold>
      );
    }
    case 'blocked':
      return (
        <Fold icon={ShieldAlert} tone="warn" label={`Tandem blocked: ${s.text ?? s.tool}`}>
          {s.output && <p className="text-[13px] text-muted">{s.output}</p>}
        </Fold>
      );
    case 'error':
      return <Fold icon={CircleAlert} tone="danger" label={s.text ?? 'Something went wrong'} />;
    case 'message':
      return <Message text={s.text ?? ''} />;
    default:
      return null;
  }
}

/** While a run works: what it is doing now, in the present tense. */
const RUN_LIVE: Record<string, string> = {
  extract: 'Reading the request',
  size: 'Estimating the size',
  spec: 'Writing the spec',
  build: 'Building the change',
  fix: 'Fixing failing checks',
  review: 'Reviewing its own work',
  conflict: 'Resolving merge conflicts',
  'task-chat': 'Replying in the task chat',
  request: 'Shaping the request',
  ask: 'Answering a question',
};

/** A clock that ticks while something runs. */
function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** The run's status, as a small mark on the corner of its avatar. */
function StatusMark({ status }: { status: RunActivity['status'] }) {
  const look =
    status === 'running'
      ? { cls: 'bg-accent', label: 'working', icon: null }
      : status === 'succeeded'
        ? { cls: 'bg-ok', label: 'done', icon: <svg viewBox="0 0 10 10" className="size-2 text-white" aria-hidden><path d="M2.5 5.2 4.3 7l3.2-3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> }
        : status === 'failed'
          ? { cls: 'bg-danger', label: 'failed', icon: <svg viewBox="0 0 10 10" className="size-2 text-white" aria-hidden><path d="m3 3 4 4M7 3 3 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg> }
          : { cls: 'bg-faint', label: 'stopped', icon: null };
  return (
    <span role="img" aria-label={look.label} className={cx('absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full ring-2 ring-surface', look.cls)}>
      {status === 'running' && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-accent opacity-40 motion-reduce:hidden" />}
      {look.icon}
    </span>
  );
}

/**
 * One Copilot run: who it worked for (the project), what it did or is doing, and, opened, its steps
 * as one flat list (the current one live at the bottom), its final message and Tandem's instructions.
 */
export function RunCard({ run, open, onToggle, dense, project, afterReview }: { run: RunActivity; open: boolean; onToggle: () => void; /** Tighter, for the task conversation. */ dense?: boolean; project?: { id: string; name: string }; /** A fix run after the self-review fixes its findings, not failing checks. */ afterReview?: boolean }) {
  const running = run.status === 'running';
  useTick(running);
  const [all, setAll] = useState(false);
  const shown = run.steps.filter((s) => s.kind !== 'prompt' && s.kind !== 'message' && s.kind !== 'intent');
  const lastIntent = [...run.steps].reverse().find((s) => s.kind === 'intent')?.text;
  const current = [...shown].reverse()[0];
  const edited = new Set(shown.filter((s) => s.kind === 'tool').flatMap((t) => t.files?.map((f) => f.path) ?? []));
  const actions = shown.filter((s) => s.kind === 'tool').length;
  const summary = running
    ? (current ? describe(current, true) : (lastIntent ?? 'Getting started'))
    : [actions ? `${actions} action${actions === 1 ? '' : 's'}` : null, edited.size ? `${edited.size} file${edited.size === 1 ? '' : 's'} changed` : null, run.error ? run.error.split('\n')[0] : null].filter(Boolean).join(' · ') || 'No actions';
  const brand = run.model ? providerOf(run.model) : undefined;
  // Old runs (before steps were recorded) have nothing to open.
  const empty = run.steps.length === 0;
  // Its steps and what it said between them, in order; the last thing it said, once done, is its answer.
  const entries = run.steps.filter((s) => s.kind !== 'prompt' && s.kind !== 'intent');
  const answer = running ? undefined : [...entries].reverse().find((s) => s.kind === 'message');
  const log = answer ? entries.filter((s) => s !== answer) : entries;
  const LIMIT = 8;
  const visible = all || log.length <= LIMIT ? log : log.slice(-LIMIT);
  const hidden = log.length - visible.length;
  const chunks: Array<{ key: string; message?: AgentStep; steps: AgentStep[] }> = [];
  for (const s of visible) {
    if (s.kind === 'message') chunks.push({ key: s.id, message: s, steps: [] });
    else if (chunks.at(-1) && !chunks.at(-1)!.message) chunks.at(-1)!.steps.push(s);
    else chunks.push({ key: s.id, steps: [s] });
  }
  const size = dense ? 28 : 32;
  return (
    <li className={cx('@container overflow-hidden bg-surface shadow-panel', dense ? 'rounded-xl' : 'rounded-2xl')}>
      <button type="button" aria-expanded={open} disabled={empty} onClick={onToggle} className={cx('flex w-full items-center text-left transition-colors enabled:hover:bg-surface-2/50 disabled:cursor-default', dense ? 'gap-3 px-3 py-2.5' : 'gap-3.5 px-4 py-3.5')}>
        <span className="relative shrink-0">
          {project ? (
            <ProjectAvatar name={project.name} projectId={project.id} size={size} />
          ) : (
            <span className="grid place-items-center rounded-lg bg-surface text-fg shadow-[0_0_0_1px_var(--border)]" style={{ width: size, height: size }}>
              <BrandLogo brand="copilot" size={16} />
            </span>
          )}
          <StatusMark status={run.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate font-medium', dense ? 'text-[13.5px]' : 'text-[14px]')}>{afterReview && run.kind === 'fix' ? (running ? 'Fixing review findings' : 'Fixed review findings') : running ? (RUN_LIVE[run.kind] ?? run.kind) : (RUN_TITLE[run.kind] ?? run.kind)}</span>
          <span key={running ? summary : undefined} className={cx('mt-0.5 block truncate text-[12.5px]', running ? 'shimmer-text animate-in' : run.status === 'failed' ? 'text-danger' : 'text-muted')}>
            {summary}
            {running && '…'}
          </span>
        </span>
        {/* The details give way to the title when the card is narrow: the model first, then the credits. */}
        <span className="hidden shrink-0 items-center gap-2.5 text-[12px] text-faint @xs:flex">
          {run.model && (
            <span className="hidden max-w-36 items-center gap-1.5 truncate @[34rem]:inline-flex">
              {brand && <BrandLogo brand={brand} size={12} />}
              {run.model}
            </span>
          )}
          <span className="tabular-nums" title={new Date(run.startedAt).toLocaleString()}>
            {duration(run.startedAt, run.endedAt)}
          </span>
          {run.aiCredits > 0 && <span className="hidden tabular-nums @[27rem]:inline">{run.aiCredits} credits</span>}
        </span>
        {!empty && <ChevronRight aria-hidden className={cx('size-4 shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />}
      </button>
      <Collapse open={open && !empty}>
        <div className={cx('border-t border-line', dense ? 'px-3 pt-2 pb-2.5' : 'px-4 pt-2.5 pb-3')}>
          {hidden > 0 && (
            <button type="button" onClick={() => setAll(true)} className="mb-1 ml-[3px] rounded-md px-1.5 py-0.5 text-[12px] text-faint transition-colors hover:bg-surface-2 hover:text-muted">
              Show {hidden} earlier step{hidden === 1 ? '' : 's'}
            </button>
          )}
          {chunks.map((c) => (c.message ? <Narration key={c.key} text={c.message.text ?? ''} /> : <StepTimeline key={c.key} steps={c.steps} />))}
          {running && (
            <p role="status" aria-live="polite" className="mt-1 flex items-center gap-2.5 pl-[7px] text-[13px]">
              <span aria-hidden className="relative grid size-2 place-items-center">
                <span className="absolute size-2 animate-ping rounded-full bg-accent/50 motion-reduce:hidden" />
                <span className="size-1.5 rounded-full bg-accent" />
              </span>
              <span className="shimmer-text">{lastIntent ?? 'Working'}…</span>
            </p>
          )}
          {answer && (
            <div className="mt-2 border-t border-line/70 pt-1">
              <Message text={answer.text ?? ''} />
            </div>
          )}
        </div>
      </Collapse>
    </li>
  );
}

/** A task's activity: each Copilot run as a chapter, its steps inside, newest run open. */
export function TaskActivity({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: ['task-activity', taskId], queryFn: () => api<RunActivity[]>(`/api/tasks/${taskId}/activity`), refetchInterval: (query) => (query.state.data?.some((r) => r.status === 'running') ? 5_000 : 30_000) });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const runs = q.data ?? [];
  const focus = runs.find((r) => r.status === 'running') ?? runs.at(-1);
  // Open the run that is working now (or the latest) unless the reader chose otherwise.
  useEffect(() => {
    if (focus && open[focus.id] === undefined) setOpen((o) => ({ ...o, [focus.id]: true }));
  }, [focus, open]);
  if (q.isLoading) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!runs.length) return <EmptyState icon={Brain} title="Copilot hasn't started yet" body="When Copilot works on this task, each step shows here: what it read, what it changed, the commands it ran and why." />;
  const credits = Math.round(runs.reduce((n, r) => n + r.aiCredits, 0) * 100) / 100;
  return (
    <div className="max-w-[860px]">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 px-1">
        <p className="text-[13px] text-muted">
          Everything Copilot did on this task, in order. Open a step to see its instructions, thinking, the files it read and changed, and the commands it ran.
        </p>
        <p className="flex items-center gap-1 text-[12px] text-faint tabular-nums">
          {runs.length} step{runs.length === 1 ? '' : 's'} · {credits} AI credits <CreditsInfo /> · started {relativeTime(runs[0]!.startedAt)}
        </p>
      </div>
      <ol aria-label="Copilot activity" className="flex flex-col gap-2.5">
        {runs.map((r) => (
          <RunCard key={r.id} run={r} afterReview={runs.some((x) => x.kind === 'review' && x.startedAt < r.startedAt)} open={Boolean(open[r.id])} onToggle={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))} />
        ))}
      </ol>
    </div>
  );
}
