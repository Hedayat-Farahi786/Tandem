import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentRun, AgentStep } from '@tandem/shared';
import { Brain, CheckCircle2, ChevronRight, CircleAlert, FileText, FlaskConical, ListChecks, Pencil, Search, ShieldAlert, Terminal, Wrench, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { BrandLogo, providerOf } from '../ui/brands';
import { Collapse, LiveActivity, StepTimeline } from '../ui/agent-steps';
import { EmptyState, ErrorState, Loading, Markdown, Spinner, cx } from '../ui/kit';

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

export function Step({ s }: { s: AgentStep }) {
  switch (s.kind) {
    case 'prompt':
      return (
        <Fold icon={ListChecks} label="Tandem's instructions" meta={`${(s.text?.length ?? 0).toLocaleString()} characters`}>
          <Pre text={s.text ?? ''} />
        </Fold>
      );
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

function RunCard({ run, open, onToggle }: { run: RunActivity; open: boolean; onToggle: () => void }) {
  const running = run.status === 'running';
  const lastIntent = [...run.steps].reverse().find((s) => s.kind === 'intent')?.text;
  const tools = run.steps.filter((s) => s.kind === 'tool');
  const edited = new Set(tools.flatMap((t) => t.files?.map((f) => f.path) ?? []));
  const summary = running
    ? (lastIntent ?? 'Working…')
    : [tools.length ? `${tools.length} action${tools.length === 1 ? '' : 's'}` : null, edited.size ? `${edited.size} file${edited.size === 1 ? '' : 's'} changed` : null, run.error ? run.error.split('\n')[0] : null].filter(Boolean).join(' · ') || 'No actions';
  const brand = run.model ? providerOf(run.model) : undefined;
  // Old runs (before steps were recorded) have nothing to open.
  const empty = run.steps.length === 0;
  return (
    <li className="overflow-hidden rounded-2xl bg-surface shadow-panel">
      <button type="button" aria-expanded={open} disabled={empty} onClick={onToggle} className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors enabled:hover:bg-surface-2/50 disabled:cursor-default">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-surface text-fg shadow-[0_0_0_1px_var(--border)]">
          {running ? <Spinner className="size-3.5" /> : <BrandLogo brand="copilot" size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{RUN_TITLE[run.kind] ?? run.kind}</span>
            {run.status === 'succeeded' && <CheckCircle2 aria-label="done" className="size-3.5 shrink-0 text-ok" />}
            {run.status === 'failed' && <XCircle aria-label="failed" className="size-3.5 shrink-0 text-danger" />}
            {run.status === 'aborted' && <span className="shrink-0 text-[12px] text-faint">stopped</span>}
          </span>
          <span className={cx('mt-0.5 block truncate text-[13px]', run.status === 'failed' ? 'text-danger' : 'text-muted')}>{summary}</span>
        </span>
        <span className="hidden shrink-0 items-center gap-3 text-[12px] text-faint sm:flex">
          {run.model && (
            <span className="inline-flex max-w-40 items-center gap-1.5 truncate">
              {brand && <BrandLogo brand={brand} size={12} />}
              {run.model}
            </span>
          )}
          <span className="tabular-nums" title={new Date(run.startedAt).toLocaleString()}>
            {duration(run.startedAt, run.endedAt)}
          </span>
          {run.aiCredits > 0 && <span className="tabular-nums">{run.aiCredits} credits</span>}
        </span>
        {!empty && <ChevronRight aria-hidden className={cx('size-4 shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />}
      </button>
      <Collapse open={open && !empty}>
        <div className="border-t border-line px-4 py-3">
          {run.steps
            .filter((s) => s.kind === 'prompt')
            .map((s) => (
              <Step key={s.id} s={s} />
            ))}
          <div className="py-1.5">
            {running ? <LiveActivity steps={run.steps} since={Date.parse(run.startedAt)} answering={false} /> : <StepTimeline steps={run.steps.filter((s) => s.kind !== 'prompt' && s.kind !== 'message' && s.kind !== 'intent')} />}
          </div>
          {run.steps
            .filter((s) => s.kind === 'message')
            .map((s) => (
              <Step key={s.id} s={s} />
            ))}
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
        <p className="text-[12px] text-faint tabular-nums">
          {runs.length} step{runs.length === 1 ? '' : 's'} · {credits} AI credits · started {relativeTime(runs[0]!.startedAt)}
        </p>
      </div>
      <ol aria-label="Copilot activity" className="flex flex-col gap-2.5">
        {runs.map((r) => (
          <RunCard key={r.id} run={r} open={Boolean(open[r.id])} onToggle={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))} />
        ))}
      </ol>
    </div>
  );
}
