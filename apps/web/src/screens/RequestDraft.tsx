import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Sparkles } from 'lucide-react';
import type { ChatThread } from '@tandem/shared';
import type { Readiness } from '../lib/types';
import { Button, ErrorState, Spinner, cx } from '../ui/kit';
import { InlineText } from '../ui/text';

/** Items that just turned done, so they can celebrate once (not on every render or reload). */
function useJustDone(items: Readiness['items']): Set<string> {
  const before = useRef<Map<string, boolean> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = before.current;
    before.current = new Map(items.map((i) => [i.id, i.ok]));
    if (!prev) return;
    const now = items.filter((i) => i.ok && prev.get(i.id) === false).map((i) => i.id);
    if (!now.length) return;
    setFresh(new Set(now));
    const t = setTimeout(() => setFresh(new Set()), 1200);
    return () => clearTimeout(t);
  }, [items]);
  return fresh;
}

/**
 * The task taking shape beside a request chat: Copilot fills in the Definition of Ready live (the
 * item it's on shimmers, finished ones tick), and once it's ready, the task to create.
 */
export function RequestDraft({ thread, readiness, repos, working, creating, done, error, onCreate }: { thread: ChatThread; readiness: Readiness; repos: Array<{ id: string; name: string }>; working: boolean; creating: boolean; done: boolean; error: unknown; onCreate: () => void }) {
  const items = readiness.items;
  const ok = items.filter((i) => i.ok).length;
  const fresh = useJustDone(items);
  const current = working ? items.find((i) => !i.ok)?.id : undefined;
  const draft = thread.draft;
  const repoNames = (thread.draftRepoIds ?? []).map((id) => repos.find((r) => r.id === id)?.name).filter(Boolean) as string[];
  const lines = thread.draftSize?.estimatedLines;
  return (
    <aside aria-label="Task draft" className="h-fit overflow-hidden rounded-2xl bg-surface shadow-panel lg:sticky lg:top-20">
      <div className="px-4 pt-4 pb-3.5">
        <p className="text-[12px] font-medium text-faint">Task draft</p>
        {thread.draftTitle ? (
          <p key={thread.draftTitle} className="mt-1 animate-in text-[15px] leading-snug font-semibold tracking-[-0.01em]">
            {thread.draftTitle}
          </p>
        ) : working ? (
          <p className="shimmer-text mt-1 text-[15px] font-semibold">Reading your request…</p>
        ) : (
          <p className="mt-1 text-[15px] font-semibold text-faint">Untitled request</p>
        )}
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Definition of Ready" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={ok}>
            <div className={cx('h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]', readiness.ready ? 'bg-ok' : 'bg-accent')} style={{ width: `${(ok / Math.max(1, items.length)) * 100}%` }} />
          </div>
          <span className={cx('shrink-0 text-[12px] font-medium tabular-nums', readiness.ready ? 'text-ok' : 'text-muted')}>{readiness.ready ? 'Ready' : `${ok} of ${items.length}`}</span>
        </div>
      </div>
      <ul aria-label="Definition of Ready" className="flex flex-col border-t border-line px-2 py-2">
        {items.map((i) => {
          const on = current === i.id;
          return (
            <li key={i.id} className={cx('flex gap-2.5 rounded-lg px-2 py-2 transition-colors duration-300', on && 'bg-surface-2', fresh.has(i.id) && 'bg-ok-soft/60')}>
              <span aria-hidden className="mt-px grid size-[18px] shrink-0 place-items-center">
                {i.ok ? <CheckCircle2 key="ok" className={cx('size-[18px] text-ok', fresh.has(i.id) && 'animate-pop')} strokeWidth={2.2} /> : on ? <Spinner className="size-3.5" /> : <Circle className="size-[18px] text-line-strong" strokeWidth={1.75} strokeDasharray="3 3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block text-[13.5px] leading-snug', i.ok ? 'font-medium' : on ? 'shimmer-text font-medium' : 'text-muted')}>{i.label}</span>
                <span className="sr-only">{i.ok ? ' — done' : ' — missing'}</span>
                {i.ok && (
                  <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug break-words text-muted">
                    <InlineText text={i.detail} />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line px-4 py-3.5">
        {readiness.ready ? (
          <div className="animate-in">
            <p className="text-[13px] text-muted">
              {[draft?.criteria.length ? `${draft.criteria.length} acceptance criteria` : null, repoNames.length ? repoNames.join(', ') : null, lines ? `about ${lines} lines` : null].filter(Boolean).join(' · ') || 'Ready to become a task.'}
            </p>
            {error ? (
              <div className="mt-3">
                <ErrorState error={error} />
              </div>
            ) : null}
            <Button variant="primary" className="mt-3 w-full" icon={Sparkles} disabled={done} busy={creating} onClick={onCreate}>
              {done ? 'Task created' : 'Create task'}
            </Button>
          </div>
        ) : (
          <p className="text-[12px] leading-relaxed text-faint">{working ? 'Copilot fills this in as it learns about your request.' : 'Answer Copilot’s questions to finish the draft. Then create the task here.'}</p>
        )}
      </div>
    </aside>
  );
}
