import { useEffect, useState, type ReactNode } from 'react';
import type { AgentStep } from '@tandem/shared';
import { ChevronRight, CircleAlert, FileText, FlaskConical, FolderSearch, Lightbulb, PencilLine, Search, ShieldAlert, Terminal, Wrench, type LucideIcon } from 'lucide-react';
import { Markdown, cx } from './kit';

/*
 * How an agent's work reads in Tandem: plain words, one icon per kind of action, repeated actions
 * grouped, reasoning shown as a titled thought. Used by the chat (live and folded) and the task's
 * Activity tab.
 */

export type StepKind = 'read' | 'search' | 'list' | 'edit' | 'command' | 'test' | 'tool' | 'think' | 'blocked' | 'error' | 'intent' | 'message' | 'prompt';

const ICONS: Record<StepKind, LucideIcon> = {
  read: FileText,
  search: Search,
  list: FolderSearch,
  edit: PencilLine,
  command: Terminal,
  test: FlaskConical,
  tool: Wrench,
  think: Lightbulb,
  blocked: ShieldAlert,
  error: CircleAlert,
  intent: Lightbulb,
  message: FileText,
  prompt: FileText,
};

/** "/home/…/projects/<id>/app/src/x.ts" or "app/src/x.ts" → "app/src/x.ts". */
export function shortPath(p: string): string {
  return p.replace(/^.*\/(?:projects|tasks)\/[0-9a-f-]{36}\//i, '').replace(/^\.\//, '');
}
const base = (p: string) => shortPath(p).split('/').filter(Boolean).at(-1) ?? p;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function kindOf(s: AgentStep): StepKind {
  if (s.kind === 'reasoning') return 'think';
  if (s.kind !== 'tool') return s.kind as StepKind;
  const n = (s.tool ?? '').toLowerCase();
  if (n === 'tandem_record_test') return 'test';
  if (n.startsWith('tandem_')) return 'tool';
  if (/^(view|read|cat|open|read_file)$/.test(n) || /view|read_file/.test(n)) return 'read';
  if (/rg|grep|search/.test(n)) return 'search';
  if (/glob|list|find|ls/.test(n)) return 'list';
  if (/edit|create|write|replace|patch/.test(n)) return 'edit';
  if (/bash|shell|powershell|run|exec/.test(n)) return 'command';
  return 'tool';
}

/** A thought's title (the model's own "**Heading**"), and the rest. */
export function splitThought(text: string): { title: string; body: string } {
  const m = /^\s*\*\*(.+?)\*\*\s*\n?([\s\S]*)$/.exec(text);
  if (m) return { title: m[1]!.trim(), body: m[2]!.trim() };
  const first = text.trim().split('\n')[0] ?? '';
  return { title: clip(first.replace(/[*_`#]/g, ''), 80), body: text.trim() };
}

/** One step in plain words: "Read app.routes.ts", "Searched for MSAL_INSTANCE". */
export function describe(s: AgentStep, live = false): string {
  const k = kindOf(s);
  const input = (s.input ?? '').split('\n')[0]!.trim();
  const v = (past: string, now: string) => (live ? now : past);
  switch (k) {
    case 'read':
      return input ? `${v('Read', 'Reading')} ${base(input)}` : v('Read a file', 'Reading a file');
    case 'search':
      return input ? `${v('Searched for', 'Searching for')} ${clip(input.replace(/\|/g, ', '), 48)}` : v('Searched the code', 'Searching the code');
    case 'list':
      return input && input !== '**/*' ? `${v('Listed', 'Listing')} ${clip(shortPath(input), 40)}` : v('Listed the files', 'Listing the files');
    case 'edit':
      return `${v('Edited', 'Editing')} ${base(s.files?.[0]?.path ?? input) || 'a file'}`;
    case 'command':
      return input ? `${v('Ran', 'Running')} ${clip(input, 56)}` : v('Ran a command', 'Running a command');
    case 'test':
      return 'Linked a test to an acceptance criterion';
    case 'tool':
      return s.title ?? (s.tool ?? 'tool').replace(/^tandem_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    case 'think':
      return splitThought(s.text ?? '').title || 'Thinking';
    case 'blocked':
      return `Tandem blocked: ${clip(s.text ?? s.tool ?? 'an action', 60)}`;
    case 'error':
      return clip(s.text ?? 'Something went wrong', 90);
    default:
      return clip(s.text ?? '', 90);
  }
}

/** Consecutive reads, searches or listings fold into one row; everything else stays on its own. */
export type StepGroup = { key: string; kind: StepKind; steps: AgentStep[] };
export function groupSteps(steps: readonly AgentStep[]): StepGroup[] {
  const out: StepGroup[] = [];
  for (const s of steps) {
    if (s.kind === 'prompt' || s.kind === 'message') continue;
    const k = kindOf(s);
    const last = out.at(-1);
    if (last && last.kind === k && (k === 'read' || k === 'search' || k === 'list' || k === 'edit')) last.steps.push(s);
    else out.push({ key: s.id, kind: k, steps: [s] });
  }
  return out;
}

function groupLabel(g: StepGroup): string {
  if (g.steps.length === 1) return describe(g.steps[0]!);
  const names = [...new Set(g.steps.map((s) => (g.kind === 'search' ? clip((s.input ?? '').split('|')[0]!.trim(), 24) : base(s.files?.[0]?.path ?? s.input ?? ''))))].filter(Boolean);
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` and ${names.length - 2} more` : '';
  if (g.kind === 'read') return `Read ${shown}${more}`;
  if (g.kind === 'edit') return `Edited ${shown}${more}`;
  if (g.kind === 'search') return `Searched ${g.steps.length} times: ${shown}${more}`;
  return `Listed files ${g.steps.length} times`;
}

/** "Worked for 36s · read 10 files · 14 searches". */
export function summaryLine(steps: readonly AgentStep[]): string {
  const tools = steps.filter((s) => s.kind === 'tool');
  const count = (k: StepKind) => tools.filter((s) => kindOf(s) === k).length;
  const files = new Set(tools.filter((s) => kindOf(s) === 'read').map((s) => shortPath(s.input ?? ''))).size;
  const edited = new Set(tools.filter((s) => kindOf(s) === 'edit').flatMap((s) => s.files?.map((f) => f.path) ?? [s.input ?? ''])).size;
  const times = steps.map((s) => Date.parse(s.at)).filter(Number.isFinite);
  const secs = times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0;
  const parts = [
    secs ? `Worked for ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}` : steps.some((s) => s.kind === 'reasoning') ? 'Thought it through' : 'Worked on it',
    files ? `read ${files} file${files === 1 ? '' : 's'}` : '',
    count('search') ? `${count('search')} search${count('search') === 1 ? '' : 'es'}` : '',
    edited ? `changed ${edited} file${edited === 1 ? '' : 's'}` : '',
    count('command') ? `ran ${count('command')} command${count('command') === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** Smooth open and close for any height. Content is mounted only while open (or closing). */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <div className={cx('grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
      <div className="min-h-0 overflow-hidden" inert={!open} aria-hidden={!open}>
        {mounted || open ? children : null}
      </div>
    </div>
  );
}

const Dot = ({ kind, tone }: { kind: StepKind; tone?: 'danger' | 'warn' }) => {
  const Icon = ICONS[kind];
  return (
    <span aria-hidden className={cx('relative z-[1] grid size-6 shrink-0 place-items-center rounded-full bg-bg ring-1 ring-line', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-muted')}>
      <Icon className="size-3.5" strokeWidth={1.9} />
    </span>
  );
};

const Output = ({ text }: { text: string }) => <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-muted">{text}</pre>;

/** One row of the timeline; opens to show what was read, searched or run. */
function GroupRow({ g, last }: { g: StepGroup; last: boolean }) {
  const [open, setOpen] = useState(false);
  const first = g.steps[0]!;
  const failed = g.steps.some((s) => s.ok === false);
  const think = g.kind === 'think' ? splitThought(first.text ?? '') : null;
  const details =
    think?.body ||
    (g.steps.length > 1 ? 'list' : first.output || (first.kind === 'blocked' && first.output) || (g.kind === 'command' && first.input) ? 'one' : '');
  const label = groupLabel(g);
  return (
    <li className="relative flex gap-3 pb-1">
      {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[11.5px] w-px bg-line" />}
      <Dot kind={g.kind} {...(failed || g.kind === 'error' ? { tone: 'danger' as const } : g.kind === 'blocked' ? { tone: 'warn' as const } : {})} />
      <div className="min-w-0 flex-1 pt-[3px] pb-1.5">
        {details ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="group inline-flex max-w-full items-center gap-1 text-left text-[13px] text-fg/85 transition-colors hover:text-fg">
            <span className={cx('truncate', g.kind === 'think' && 'italic', failed && 'text-danger')}>{label}</span>
            <ChevronRight aria-hidden className={cx('size-3.5 shrink-0 text-faint transition-transform duration-200', open && 'rotate-90')} />
          </button>
        ) : (
          <p className={cx('truncate text-[13px] text-fg/85', g.kind === 'error' && 'text-danger')}>{label}</p>
        )}
        <Collapse open={open}>
          <div className="pt-1.5">
            {think?.body ? (
              <div className="border-l-2 border-line pl-3 text-[12.5px] text-muted [&_.prose-tandem]:text-[12.5px] [&_.prose-tandem]:text-muted">
                <Markdown source={think.body} />
              </div>
            ) : g.steps.length > 1 ? (
              <ul className="flex flex-col gap-0.5 text-[12.5px] text-muted">
                {g.steps.map((s) => (
                  <li key={s.id} className="truncate font-mono text-[11.5px]" title={shortPath(s.input ?? '')}>
                    {g.kind === 'search' ? (s.input ?? '').replace(/\|/g, ' | ') : shortPath(s.files?.[0]?.path ?? s.input ?? '')}
                  </li>
                ))}
              </ul>
            ) : (
              <>
                {g.kind === 'command' && first.input && <Output text={`$ ${first.input}`} />}
                {first.output && <Output text={first.output} />}
              </>
            )}
          </div>
        </Collapse>
      </div>
    </li>
  );
}

export function StepTimeline({ steps }: { steps: readonly AgentStep[] }) {
  const groups = groupSteps(steps);
  return (
    <ol className="flex flex-col">
      {groups.map((g, i) => (
        <GroupRow key={g.key} g={g} last={i === groups.length - 1} />
      ))}
    </ol>
  );
}

/** A small, smooth spinner: a soft ring with a moving arc. */
export function Spin({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx('size-4 animate-spin [animation-duration:900ms]', className)} aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.75" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** While the agent works: what it is doing now, a timer, and its latest steps sliding in. */
export function LiveActivity({ steps, since, answering }: { steps: readonly AgentStep[]; since: number; answering: boolean }) {
  const elapsed = useElapsed(since);
  const shown = steps.filter((s) => s.kind !== 'prompt' && s.kind !== 'message');
  const current = [...shown].reverse().find((s) => s.kind !== 'intent');
  const intent = [...shown].reverse().find((s) => s.kind === 'intent')?.text;
  const now = answering ? 'Writing the answer' : current ? describe(current, true) : (intent ?? 'Thinking');
  const recent = shown.filter((s) => s.kind !== 'intent').slice(-4);
  const earlier = shown.filter((s) => s.kind !== 'intent').length - recent.length;
  return (
    <div role="status" aria-live="polite" className="mb-3 animate-[rise-in_320ms_cubic-bezier(0.16,1,0.3,1)_both] overflow-hidden rounded-2xl bg-surface shadow-panel">
      <div className="flex items-center gap-3 px-4 py-3">
        <Spin className="text-accent-text" />
        <span key={now} className="shimmer-text min-w-0 flex-1 animate-in truncate text-[13.5px] font-medium">
          {now}…
        </span>
        <span className="shrink-0 text-[12px] text-faint tabular-nums">{elapsed}</span>
      </div>
      {recent.length > 0 && (
        <ol className="border-t border-line px-4 pt-2.5 pb-2">
          {earlier > 0 && <li className="pb-1.5 pl-9 text-[11.5px] text-faint">{earlier} earlier step{earlier === 1 ? '' : 's'}</li>}
          {recent.map((s, i) => (
            <li key={s.id} className={cx('flex animate-[step-in_380ms_cubic-bezier(0.16,1,0.3,1)_both] items-center gap-3 py-1 text-[12.5px] transition-opacity duration-500', i < recent.length - 2 ? 'opacity-55' : 'text-fg/85')}>
              <Dot kind={kindOf(s)} {...(s.ok === false ? { tone: 'danger' as const } : {})} />
              <span className="min-w-0 truncate">{describe(s)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** After the answer: everything the agent did, folded into one line that opens into a timeline. */
export function ActivitySummary({ steps }: { steps: readonly AgentStep[] }) {
  const [open, setOpen] = useState(false);
  const shown = steps.filter((s) => s.kind !== 'prompt' && s.kind !== 'message' && s.kind !== 'intent');
  if (!shown.length) return null;
  return (
    <div className="mb-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="group -ml-1 inline-flex items-center gap-2 rounded-lg px-1.5 py-1 text-[12.5px] text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <Lightbulb aria-hidden className="size-3.5" strokeWidth={1.9} />
        {summaryLine(shown)}
        <ChevronRight aria-hidden className={cx('size-3.5 transition-transform duration-200', open && 'rotate-90')} />
      </button>
      <Collapse open={open}>
        <div className="pt-2 pl-0.5">
          <StepTimeline steps={shown} />
        </div>
      </Collapse>
    </div>
  );
}
