import { useState } from 'react';
import type { AgentStep } from '@tandem/shared';
import { ChevronRight } from 'lucide-react';
import { cx } from '../ui/kit';
import { Step } from './TaskActivity';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Read 3 files · searched twice · thought it through": what Copilot did, in one line. */
export function stepsLine(steps: readonly AgentStep[]): string {
  const tools = steps.filter((s) => s.kind === 'tool');
  const name = (s: AgentStep) => (s.tool ?? '').toLowerCase();
  const reads = tools.filter((s) => /view|read|cat|open|list/.test(name(s))).length;
  const searches = tools.filter((s) => /grep|glob|search|find/.test(name(s))).length;
  const edits = new Set(tools.filter((s) => /edit|create|write|replace|patch/.test(name(s))).flatMap((s) => s.files?.map((f) => f.path) ?? [s.input ?? ''])).size;
  const commands = tools.filter((s) => /bash|shell|powershell|run|exec/.test(name(s))).length;
  const other = tools.length - reads - searches - commands - tools.filter((s) => /edit|create|write|replace|patch/.test(name(s))).length;
  const parts = [
    reads ? `read ${plural(reads, 'file', 'files')}` : '',
    searches ? (searches === 1 ? 'searched once' : searches === 2 ? 'searched twice' : `searched ${searches} times`) : '',
    edits ? `changed ${plural(edits, 'file', 'files')}` : '',
    commands ? `ran ${plural(commands, 'command', 'commands')}` : '',
    other > 0 ? `used ${plural(other, 'tool', 'tools')}` : '',
    steps.some((s) => s.kind === 'reasoning') ? 'thought it through' : '',
    steps.some((s) => s.kind === 'blocked') ? 'was stopped from something' : '',
  ].filter(Boolean);
  const line = parts.join(' · ');
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : 'Looked at the task';
}

/** Above an answer: what Copilot did to write it, folded into one line you can open. */
export function StepsSummary({ steps }: { steps: readonly AgentStep[] }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <div className="mb-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] text-muted transition-colors hover:text-fg">
        {stepsLine(steps)}
        <ChevronRight aria-hidden className={cx('size-3.5 transition-transform duration-200', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1 -ml-2 animate-in border-l border-line pl-1">
          {steps.map((s) => (
            <Step key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Text with a light sweeping across it, for "Copilot is thinking". */
export function Shimmer({ children, className }: { children: string; className?: string }) {
  return (
    <span role="status" className={cx('shimmer-text text-[13px]', className)}>
      {children}
    </span>
  );
}

/** While Copilot works on an answer: its steps as they happen, then the answer as it streams. */
export function LiveAnswer({ steps, stream }: { steps: readonly AgentStep[]; stream: string }) {
  const intent = [...steps].reverse().find((s) => s.kind === 'intent')?.text;
  const shown = steps.filter((s) => s.kind !== 'intent');
  return (
    <div className="px-1">
      {shown.length > 0 && (
        <div className="mb-2 -ml-2 border-l border-line pl-1">
          {shown.map((s) => (
            <div key={s.id} className="animate-in">
              <Step s={s} />
            </div>
          ))}
        </div>
      )}
      {!stream && <Shimmer>{intent ? `${intent}…` : shown.length ? 'Working…' : 'Thinking…'}</Shimmer>}
    </div>
  );
}
