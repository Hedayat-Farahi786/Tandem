import type { ReactNode } from 'react';
import { ArrowRight, Check, CheckCircle2, Circle, FileText, Play, Save } from 'lucide-react';
import type { ChatThread } from '@tandem/shared';
import type { Readiness } from '../lib/types';
import { Button, ErrorState, LinkButton, Markdown, Spinner, cx } from '../ui/kit';
import { Caret, Typed } from '../ui/typewriter';

type ItemId = Readiness['items'][number]['id'];

/** The spec body as the panel shows it: Tandem's header table, title and approvals are added on the task. */
const specBody = (md: string) =>
  md
    .replace(/\r\n/g, '\n')
    .replace(/^# .*\n+/m, '')
    .replace(/^\|\s*Task\s*\|\s*Version\s*\|.*\n\|.*\n\|.*\n?/m, '')
    .replace(/^## Approvals\s*$[\s\S]*?(?=^## |(?![\s\S]))/m, '')
    .trim();

/** One section of the spec as it takes shape: done, being written, or still to come. */
function Section({ title, item, readiness, current, children }: { title: string; item?: ItemId; readiness: Readiness; current: boolean; children?: ReactNode }) {
  const r = item ? readiness.items.find((i) => i.id === item) : undefined;
  const ok = r ? r.ok : Boolean(children);
  return (
    <section className="group/sec">
      <h3 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-fg">
        {ok ? <CheckCircle2 aria-hidden className="size-3.5 text-ok" strokeWidth={2.4} /> : current ? <Spinner className="size-3" /> : <Circle aria-hidden className="size-3.5 text-line-strong" strokeWidth={2} strokeDasharray="3 3" />}
        {title}
        <span className="sr-only">{ok ? ' (done)' : ' (to do)'}</span>
      </h3>
      <div className="pl-[22px] text-[14.5px] leading-relaxed">
        {children ? (
          <>
            {children}
            {/* Written but not enough yet (one criterion of two, say): what's still needed. */}
            {!ok && r && <p className={cx('mt-1.5 text-[12.5px]', current ? 'shimmer-text' : 'text-faint')}>{r.detail}</p>}
          </>
        ) : current ? (
          <p className="shimmer-text">
            {r?.detail ?? 'Writing…'}
            <Caret />
          </p>
        ) : (
          <p className="text-[13.5px] text-faint italic">{r?.detail ?? 'Not yet.'}</p>
        )}
      </div>
    </section>
  );
}

/**
 * The spec beside a request chat, written live: as Copilot reads the code and learns from your
 * answers, each section fills in (new text types out with a cursor). When it meets the Definition of
 * Ready it can be created and started, or saved to start later.
 */
export function RequestDraft({
  thread,
  readiness,
  repos,
  working,
  liveLine,
  creating,
  done,
  error,
  onCreate,
}: {
  thread: ChatThread;
  readiness: Readiness;
  repos: Array<{ id: string; name: string }>;
  working: boolean;
  liveLine?: string | undefined;
  creating: 'start' | 'save' | null;
  done: boolean;
  error: unknown;
  onCreate: (start: boolean) => void;
}) {
  const d = thread.draft;
  const items = readiness.items;
  const okCount = items.filter((i) => i.ok).length;
  // The section Copilot is on: the first one still missing, while it works.
  const current = working ? items.find((i) => !i.ok)?.id : undefined;
  const repoNames = (thread.draftRepoIds ?? []).map((id) => repos.find((r) => r.id === id)?.name).filter(Boolean) as string[];
  const lines = thread.draftSize?.estimatedLines;
  const canSave = Boolean(thread.draftTitle || d?.goal.trim());
  const left = items.length - okCount;
  // Done means done: the requirement is complete, nothing is left to ask, and Copilot has finished.
  const asking = Boolean(thread.pendingQuestions?.questions.length) && !working;
  const writingSpec = working && thread.busy?.phase === 'spec';
  const spec = thread.draftSpec;
  const specReady = Boolean(spec && !spec.problems.length && !spec.openQuestions.length);
  const canStart = !done && readiness.ready && !asking && !working;
  const status = specReady && !working ? 'Ready to create' : writingSpec ? 'Writing the spec' : asking ? 'Your answer needed' : readiness.ready ? 'Requirement complete' : `${okCount} of ${items.length}`;
  const progress = specReady ? 1 : (okCount / Math.max(1, items.length)) * (readiness.ready ? 0.9 : 0.85);
  return (
    <aside aria-label="Task draft" className="flex flex-col overflow-hidden rounded-2xl bg-surface shadow-panel lg:sticky lg:top-16 lg:h-[calc(100dvh-5.5rem)] lg:self-start">
      <header className="border-b border-line px-6 pt-4 pb-3.5">
        <div className="flex items-center gap-2">
          <FileText aria-hidden className="size-4 text-muted" strokeWidth={1.9} />
          <p className="flex-1 text-[12.5px] font-medium text-muted">{specReady ? 'Spec' : 'Spec draft'}</p>
          <span className={cx('text-[12px] font-medium tabular-nums', specReady && !working ? 'text-ok' : asking ? 'text-warn' : 'text-muted')}>{status}</span>
        </div>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Definition of Ready" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={okCount}>
          <div className={cx('h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]', specReady && !working ? 'bg-ok' : 'bg-accent')} style={{ width: `${progress * 100}%` }} />
        </div>
        {working && (
          <p role="status" className="mt-2.5 flex min-w-0 animate-in items-center gap-2 text-[12.5px]">
            <Spinner className="size-3" />
            <span className="shimmer-text truncate">{writingSpec ? 'Writing the full spec from the code it read…' : (liveLine ?? 'Reading your request and the code…')}</span>
          </p>
        )}
      </header>

      <div tabIndex={0} role="region" aria-label="Spec" className="min-h-0 flex-1 overflow-y-auto px-6 py-6 focus-visible:outline-offset-[-2px]">
        <h2 className="font-display text-[22px] leading-snug">
          {thread.draftTitle ? <Typed text={thread.draftTitle} /> : working ? <span className="shimmer-text">Naming the change…</span> : <span className="text-faint">Untitled request</span>}
        </h2>
        {spec && !writingSpec ? (
          <div className="mt-5 animate-in">
            {!specReady && (
              <p className="mb-4 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                {spec.openQuestions.length ? `Open questions: ${spec.openQuestions.join(' · ')}. Answer them in the chat.` : 'Parts of this spec need another pass; the task rewrites it when it starts.'}
              </p>
            )}
            <Markdown className="text-[14px]" source={specBody(spec.markdown)} />
          </div>
        ) : (
        <div className="mt-6 flex flex-col gap-6">
          <Section title="Problem and goal" item="goal" readiness={readiness} current={current === 'goal'}>
            {d?.goal.trim() ? <Typed text={d.goal} /> : undefined}
          </Section>
          {d?.userStory?.trim() && (
            <Section title="User story" readiness={readiness} current={false}>
              <Typed text={d.userStory} />
            </Section>
          )}
          <Section title="Acceptance criteria" item="criteria" readiness={readiness} current={current === 'criteria'}>
            {d?.criteria.length ? (
              <ol className="flex flex-col gap-2">
                {d.criteria.map((c, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="mt-[3px] grid size-[18px] shrink-0 place-items-center rounded-md bg-surface-2 text-[11px] font-semibold text-muted tabular-nums">{i + 1}</span>
                    <Typed className="min-w-0" text={`Given ${c.given}, when ${c.when}, then ${c.then}.`.replace(/\.\.$/, '.')} />
                  </li>
                ))}
              </ol>
            ) : undefined}
          </Section>
          <Section title="Example data" item="example-data" readiness={readiness} current={current === 'example-data'}>
            {d?.exampleData.trim() ? <Typed className="font-mono text-[13px]" text={d.exampleData} /> : undefined}
          </Section>
          <Section title="Affected areas" item="affected-areas" readiness={readiness} current={current === 'affected-areas'}>
            {d?.affectedAreas.trim() ? (
              <>
                <Typed text={d.affectedAreas} />
                {repoNames.length > 0 && (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {repoNames.map((n) => (
                      <span key={n} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[12px] text-muted">
                        {n}
                      </span>
                    ))}
                  </span>
                )}
              </>
            ) : undefined}
          </Section>
          <Section title="Out of scope" item="out-of-scope" readiness={readiness} current={current === 'out-of-scope'}>
            {d?.outOfScope.trim() ? <Typed text={d.outOfScope} /> : undefined}
          </Section>
          <Section title="Open questions" item="open-questions" readiness={readiness} current={current === 'open-questions'}>
            {d && readiness.items.find((i) => i.id === 'open-questions')?.ok ? <span className="text-muted">None</span> : undefined}
          </Section>
          {lines ? <p className="text-[12px] text-faint">About {lines} lines across {repoNames.length || 1} repo{repoNames.length > 1 ? 's' : ''}.</p> : null}
          {writingSpec && (
            <p className="flex items-center gap-2 text-[13px]">
              <Spinner className="size-3" />
              <span className="shimmer-text">Writing the full spec: files to change, states, edge cases and tests…</span>
            </p>
          )}
        </div>
        )}
      </div>

      <footer className="border-t border-line bg-surface px-5 py-4">
        {error ? (
          <div className="mb-3">
            <ErrorState error={error} />
          </div>
        ) : null}
        {done && thread.createdTaskId ? (
          <div className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ok-soft text-ok">
              <Check aria-hidden className="size-4" strokeWidth={2.6} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">This request is now a task</p>
              <p className="text-[12.5px] text-muted">Follow the build and talk to Copilot in the task.</p>
            </div>
            <LinkButton to={`/tasks/${thread.createdTaskId}`} variant="primary" size="sm">
              Open task
              <ArrowRight aria-hidden className="size-3.5" />
            </LinkButton>
          </div>
        ) : (
        <>
        <div className="flex items-center gap-2">
          <Button className="flex-1" icon={Save} disabled={done || !canSave || working} busy={creating === 'save'} onClick={() => onCreate(false)}>
            Save for later
          </Button>
          <Button className="flex-[1.4]" variant="primary" icon={Play} disabled={!canStart} busy={creating === 'start'} onClick={() => onCreate(true)}>
            Create and start
          </Button>
        </div>
        <p className="mt-2 text-center text-[12px] text-faint">
          {asking
              ? "Answer Copilot's question to finish the spec."
              : writingSpec
                ? 'Copilot is writing the full spec. You can create the task once it is done.'
                : working
                  ? 'Copilot is still working on your request.'
                  : specReady
                    ? 'Creating approves this spec as yours; Copilot builds it once every approval is in.'
                    : readiness.ready
                      ? 'The task writes the full spec first, for you to approve.'
                      : `${left} to go before it can start. Save for later keeps it as a draft task.`}
        </p>
        </>
        )}
      </footer>
    </aside>
  );
}
