import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Copy, FileText, HelpCircle, MessageSquarePlus, PencilRuler, Sparkles } from 'lucide-react';
import type { AgentStep, ChatMessage, ChatThread } from '@tandem/shared';
import { ActivitySummary, LiveActivity } from '../ui/agent-steps';
import { api, post, put } from '../lib/api';
import { useEvents } from '../lib/events';
import { relativeTime } from '../lib/format';
import { useRouter } from '../lib/router';
import { useChatProject } from '../lib/project';
import type { Bootstrap, ThreadView } from '../lib/types';
import { Button, Callout, EmptyState, ErrorState, Loading, Markdown, Pill, Select, Spinner, cx, useToast } from '../ui/kit';
import { ModelPicker, useModels } from '../ui/model-picker';
import { ReadinessChecklist } from './Tasks';

/** Your message animates once, as you send it; replies animate as they arrive (not on reload). */
const isFresh = (m: ChatMessage) => m.role === 'assistant' && Date.now() - Date.parse(m.createdAt) < 5_000;

/** Under an answer, on hover: copy it (like a chat app's message actions). */
function CopyAnswer({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-1.5 -ml-1.5 flex h-7 items-center opacity-0 transition-opacity duration-200 group-hover/msg:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        aria-label={done ? 'Copied' : 'Copy answer'}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
        className="grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {done ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </div>
  );
}

function Message({ m, repoName, steps, enter = isFresh(m) }: { m: ChatMessage; repoName: (id?: string) => string; steps?: AgentStep[] | undefined; enter?: boolean }) {
  if (m.role === 'system') {
    return (
      <div className="flex justify-center">
        <p className="rounded-full bg-surface-2 px-3 py-1 text-[12px] text-muted">{m.content}</p>
      </div>
    );
  }
  const mine = m.role === 'user';
  return (
    <div className={cx('group/msg flex', enter && 'animate-rise', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[min(680px,92%)]', mine ? 'rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5' : 'px-1')}>
        {!mine && steps && <ActivitySummary steps={steps} />}
        {mine ? <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{m.content}</p> : <Markdown source={m.content} />}
        {!mine && <CopyAnswer text={m.content} />}
        {m.refs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.refs.map((r) => (
              <span key={`${r.repoId}:${r.path}:${r.line}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[11.5px] text-muted">
                <FileText aria-hidden className="size-3" />
                {repoName(r.repoId)}/{r.path}
                {r.line ? `:${r.line}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A chat thread with live streaming. Used for Ask, Request and task chats. */
/** A task's state as the task chat needs it: stuck tasks can be continued with the owner's message. */
export interface ChatTask {
  id: string;
  state: string;
  needsAttention: boolean;
}
const WORKING = new Set(['READINESS', 'SPEC_DRAFTING', 'BUILDING', 'VERIFYING', 'SELF_REVIEW']);

export function ThreadPanel({ threadId, placeholder, repos, onTaskCreated, compact, initialMessage, onInitialSent, task }: { threadId: string; placeholder: string; repos: Array<{ id: string; name: string }>; onTaskCreated?: (taskId: string) => void; compact?: boolean; initialMessage?: string; onInitialSent?: () => void; task?: ChatTask }) {
  const stuck = Boolean(task && (task.state === 'BLOCKED' || task.state === 'FAILED' || (task.state === 'PR_OPEN' && task.needsAttention)));
  const bootInfo = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const testAgent = bootInfo.data && bootInfo.data.agent !== 'copilot';
  const working = Boolean(task && WORKING.has(task.state));
  const qc = useQueryClient();
  const toast = useToast();
  const view = useQuery({ queryKey: ['thread', threadId], queryFn: () => api<ThreadView>(`/api/threads/${threadId}`) });
  const [text, setText] = useState('');
  const [stream, setStream] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Live: the answer as it streams, and Copilot's steps as it takes them.
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [since, setSince] = useState(() => Date.now());
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvents((e) => {
    if (e.type === 'agent.delta' && e.threadId === threadId) setStream((s) => s + e.text);
    if (e.type === 'agent.step' && e.threadId === threadId && !liveTimer.current) {
      const runId = e.runId;
      liveTimer.current = setTimeout(() => {
        liveTimer.current = null;
        void api<AgentStep[]>(`/api/agent-runs/${runId}/steps`)
          .then(setLiveSteps)
          .catch(() => undefined);
      }, 250);
    }
  });
  const send = useMutation({
    mutationFn: (t: string) => post(`/api/threads/${threadId}/messages`, { text: t }),
    onMutate: (t) => {
      setPending(t);
      setStream('');
      setLiveSteps([]);
      setSince(Date.now());
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      setPending(null);
      setStream('');
      setLiveSteps([]);
      input.current?.focus();
    },
  });
  const createTask = useMutation({
    mutationFn: () => post<{ id: string; key: string }>(`/api/threads/${threadId}/create-task`),
    onSuccess: (t) => {
      toast(`Created ${t.key}. Tandem is checking readiness and drafting the spec.`, 'ok');
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      onTaskCreated?.(t.id);
    },
  });
  const setModel = useMutation({
    mutationFn: (model: string) => put(`/api/threads/${threadId}/model`, { model }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['task'] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not change the model.', 'danger'),
  });
  // Continue the task with the owner's message (or with what Copilot proposed).
  const proceed = useMutation({
    mutationFn: (t?: string) => post<{ action: string }>(`/api/threads/${threadId}/continue`, t ? { text: t } : {}),
    onSuccess: (r) => toast(r.action === 'noted' ? 'Copilot follows this from its next step.' : r.action === 'fixing' ? 'Copilot is fixing the checks with your guidance.' : 'Continuing the task.', 'ok'),
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'danger'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['task'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const dismissContinue = useMutation({
    mutationFn: () => post(`/api/threads/${threadId}/continue/dismiss`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['thread', threadId] }),
  });
  const applyChange = useMutation({
    mutationFn: (apply: boolean) => post(`/api/threads/${threadId}/spec-change/${apply ? 'apply' : 'dismiss'}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task'] });
    },
  });
  // Stick to the bottom like a chat app: follow new content only while the reader is at the bottom,
  // glide down when they send, and offer a "jump to latest" button when they have scrolled up.
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  useEffect(() => {
    const measure = () => {
      const d = document.documentElement;
      const near = d.scrollHeight - (window.scrollY + window.innerHeight) < 140;
      atBottomRef.current = near;
      setAtBottom(near);
    };
    measure();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);
  const toBottom = (behavior: ScrollBehavior) => requestAnimationFrame(() => window.scrollTo?.({ top: document.documentElement.scrollHeight, behavior }));
  const opened = useRef(false);
  useEffect(() => {
    if (!view.data || opened.current) return;
    opened.current = true;
    toBottom('auto');
  }, [view.data]);
  useEffect(() => {
    if (pending) {
      atBottomRef.current = true;
      toBottom('smooth');
    }
  }, [pending]);
  useEffect(() => {
    if (atBottomRef.current) toBottom('auto');
  }, [view.data?.messages.length, stream, liveSteps.length]);
  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialMessage || sentInitial.current || !view.data || view.data.messages.length > 0) return;
    sentInitial.current = true;
    send.mutate(initialMessage);
    onInitialSent?.();
  }, [initialMessage, view.data, send, onInitialSent]);
  const repoName = (id?: string) => repos.find((r) => r.id === id)?.name ?? 'repo';
  const thread = view.data?.thread;
  const done = Boolean(thread?.createdTaskId);
  const submit = () => {
    const t = text.trim();
    if (!t || send.isPending) return;
    setText('');
    send.mutate(t);
  };

  if (view.isLoading) return <Loading />;
  if (view.isError || !view.data) return <ErrorState error={view.error} retry={() => void view.refetch()} />;
  const messages = view.data.messages;
  return (
    <div className={cx('grid flex-1 gap-6', thread?.mode === 'request' && !compact && 'lg:grid-cols-[1fr_280px]')}>
      <div className="flex min-h-[420px] flex-col">
        <div className="flex flex-1 flex-col gap-5 pb-4" aria-live="polite" aria-busy={send.isPending}>
          {messages.length === 0 && !pending && (
            <div className="py-10 text-center text-[13.5px] text-muted">
              {thread?.mode === 'request' ? 'Describe what you want. Tandem asks until the request is clear and testable, then creates the task.' : thread?.mode === 'task' ? 'Ask about the spec, the build, the diff or failing checks. Ask for a spec change and Tandem proposes it for you to confirm.' : 'Ask anything about the code. Answers cite files and lines.'}
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} repoName={repoName} steps={m.runId ? view.data.steps?.[m.runId] : undefined} />
          ))}
          {pending && <Message enter m={{ id: 'pending', threadId, role: 'user', content: pending, refs: [], createdAt: '' }} repoName={repoName} />}
          {send.isPending && (
            <div className="flex flex-col">
              <LiveActivity steps={liveSteps} since={since} answering={Boolean(stream)} />
              {stream && (
                <div className="animate-in px-1">
                  <Markdown source={stream} className="stream-caret" />
                </div>
              )}
            </div>
          )}
          {send.isError && <ErrorState title="The message was not answered" error={send.error} />}
          {thread?.pendingContinue && (
            <Callout
              tone="accent"
              title="Copilot's proposal"
              actions={
                <>
                  <Button size="sm" variant="primary" busy={proceed.isPending} onClick={() => proceed.mutate(undefined)}>
                    Continue with this
                  </Button>
                  <Button size="sm" busy={dismissContinue.isPending} onClick={() => dismissContinue.mutate()}>
                    Not now
                  </Button>
                </>
              }
            >
              {thread.pendingContinue.summary}
            </Callout>
          )}
          {thread?.pendingSpecChange && (
            <Callout
              tone="accent"
              title="Proposed spec change"
              actions={
                <>
                  <Button size="sm" variant="primary" busy={applyChange.isPending && applyChange.variables === true} onClick={() => applyChange.mutate(true)}>
                    {thread.pendingSpecChange.kind === 'edit' ? 'Save as new spec version' : 'Redraft the spec'}
                  </Button>
                  <Button size="sm" busy={applyChange.isPending && applyChange.variables === false} onClick={() => applyChange.mutate(false)}>
                    Dismiss
                  </Button>
                </>
              }
            >
              {thread.pendingSpecChange.summary}. Earlier approvals will not count for the new version.
            </Callout>
          )}
        </div>
        <form
          className="sticky bottom-0 z-10 -mx-2 mt-auto bg-[linear-gradient(to_top,var(--bg)_78%,transparent)] px-2 pt-8 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <button
            type="button"
            aria-label="Jump to latest"
            tabIndex={atBottom ? -1 : 0}
            onClick={() => toBottom('smooth')}
            className={cx(
              'absolute -top-3 left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full bg-surface text-muted shadow-[0_0_0_1px_var(--border-strong),var(--shadow-md)] transition-[opacity,transform,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:text-fg',
              atBottom ? 'pointer-events-none translate-y-2 scale-90 opacity-0' : 'translate-y-0 scale-100 opacity-100',
            )}
          >
            <ArrowDown aria-hidden className="size-4" strokeWidth={2.2} />
          </button>
          <div style={{ viewTransitionName: 'composer' }} className={cx('rounded-2xl border border-line-strong bg-surface p-2 shadow-md transition-shadow focus-within:border-[color-mix(in_srgb,var(--accent)_45%,var(--border-strong))] focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_9%,transparent)]', done && 'opacity-60')}>
            <label htmlFor={`composer-${threadId}`} className="sr-only">
              Message
            </label>
            <textarea
              id={`composer-${threadId}`}
              ref={input}
              rows={1}
              value={text}
              disabled={done}
              placeholder={done ? 'This request became a task. Continue in the task chat.' : stuck ? 'Tell Copilot how to continue, or ask what went wrong…' : working ? 'Ask a question, or tell Copilot something for its next step…' : placeholder}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="block max-h-[220px] min-h-[40px] w-full resize-none bg-transparent px-2.5 pt-1.5 text-[14.5px] leading-relaxed focus:outline-none focus-visible:outline-none"
            />
            <div className="flex items-center justify-end gap-1.5">
              <ModelPicker value={setModel.isPending ? (setModel.variables ?? '') : view.data.model} onChange={(m) => setModel.mutate(m)} busy={setModel.isPending} disabled={done} align="end" />
              {(stuck || working) && (
                <Button
                  size="sm"
                  variant={stuck ? 'secondary' : 'ghost'}
                  disabled={!text.trim() || proceed.isPending}
                  busy={proceed.isPending}
                  onClick={() => {
                    const t = text.trim();
                    if (!t) return;
                    setText('');
                    proceed.mutate(t);
                  }}
                >
                  {stuck ? 'Continue with this' : 'Tell Copilot'}
                </Button>
              )}
              <Button type="submit" variant="primary" aria-label="Send" className="disabled:bg-surface-3 disabled:text-faint disabled:opacity-100 size-8 rounded-[10px] !px-0 transition-[background-color,opacity,transform] duration-150 active:scale-[0.92]" disabled={!text.trim() || send.isPending || done}>
                {send.isPending ? <Spinner /> : <ArrowUp aria-hidden className="size-4" strokeWidth={2.5} />}
              </Button>
            </div>
          </div>
          {testAgent && <p className="mt-1.5 px-2 text-[11.5px] font-medium text-warn">Test mode: answers come from Tandem's test agent, not Copilot.</p>}
          <p className={cx('mt-1.5 px-2 text-[11.5px] text-faint', testAgent && 'hidden')}>{stuck ? 'Enter asks Copilot · Continue with this lets Copilot work on it again' : working ? 'Enter asks a question · Tell Copilot passes a note to its next step' : 'Enter to send · Shift+Enter for a new line · Chat never changes code.'}</p>
        </form>
      </div>
      {thread?.mode === 'request' && view.data.readiness && !compact && (
        <aside className="h-fit rounded-2xl border border-line bg-surface p-4 shadow-sm lg:sticky lg:top-6">
          <p className="mb-1 flex items-center justify-between text-[13.5px] font-semibold">
            Ready to build?
            <Pill tone={view.data.readiness.ready ? 'ok' : 'neutral'}>{view.data.readiness.ready ? 'Ready' : `${view.data.readiness.missing.length} to go`}</Pill>
          </p>
          <p className="mb-4 text-[12.5px] text-muted">{thread.draftTitle ?? 'The task takes shape as you answer.'}</p>
          <ReadinessChecklist readiness={view.data.readiness} compact />
          {createTask.isError && (
            <div className="mt-3">
              <ErrorState error={createTask.error} />
            </div>
          )}
          <Button variant="primary" className="mt-4 w-full" icon={Sparkles} disabled={!view.data.readiness.ready || done} busy={createTask.isPending} onClick={() => createTask.mutate()}>
            {done ? 'Task created' : 'Create task'}
          </Button>
        </aside>
      )}
    </div>
  );
}

type Mode = 'request' | 'ask';

/** Runs a UI change as a view transition when the browser supports it and motion is welcome. */
function withTransition(change: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduced) return change();
  doc.startViewTransition(() => flushSync(change));
}

const EXAMPLES: Record<Mode, string[]> = {
  request: ['Let customers download their invoices as a PDF', 'Show a friendly message when a page fails to load', 'Remember the language a visitor picked'],
  ask: ['Give me a short tour of this project', 'How do people sign in?', 'What happens when a payment fails?'],
};

const MODEL_KEY = 'tandem.model';
const rememberedModel = () => {
  try {
    return localStorage.getItem(MODEL_KEY) ?? '';
  } catch {
    return '';
  }
};

function StartComposer({ projectName, busy, error, onStart }: { projectName: string; busy: boolean; error: unknown; onStart: (mode: Mode, text: string, model: string) => void }) {
  const [mode, setMode] = useState<Mode>('request');
  const [text, setText] = useState('');
  const [model, setModel] = useState(rememberedModel);
  const catalog = useModels(Boolean(model));
  // A remembered model this account no longer offers falls back to Auto.
  const usable = !model || !catalog.data || catalog.data.models.some((m) => m.id === model) ? model : '';
  const submit = () => text.trim() && !busy && onStart(mode, text.trim(), usable);
  const pick = (m: string) => {
    setModel(m);
    try {
      localStorage.setItem(MODEL_KEY, m);
    } catch {
      // Private window or blocked storage: the pick still applies to this chat.
    }
  };
  return (
    <div className="mx-auto flex min-h-[calc(100vh-9rem)] max-w-2xl flex-col items-center justify-center pb-[6vh] text-center md:min-h-[calc(100vh-2rem)]">
      <h1 className="animate-rise font-display text-[34px] leading-tight">{mode === 'request' ? 'What should we build?' : 'What would you like to know?'}</h1>
      <p className="mt-2 animate-rise text-[14.5px] text-muted [animation-delay:40ms]">{mode === 'request' ? `Describe a change to ${projectName}. Tandem asks until it is clear, then turns it into a reviewed pull request.` : `Ask anything about ${projectName}. Answers are read-only and cite files and lines.`}</p>
      <form
        className="mt-8 w-full animate-rise text-left [animation-delay:80ms]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div style={{ viewTransitionName: 'composer' }} className="rounded-[20px] bg-surface p-3 shadow-[0_0_0_1px_var(--border-strong),var(--shadow-md),0_24px_60px_-28px_rgb(0_0_0/0.2)] transition-shadow duration-200 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_45%,var(--border-strong)),0_0_0_5px_color-mix(in_srgb,var(--accent)_8%,transparent),var(--shadow-md)]">
          <label htmlFor="start-composer" className="sr-only">
            {mode === 'request' ? 'Describe your request' : 'Your question'}
          </label>
          <textarea
            id="start-composer"
            rows={3}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={mode === 'request' ? 'For example: let customers download their invoices as a PDF from their account page.' : 'For example: how do people sign in, and what happens if they forget their password?'}
            className="w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-relaxed focus:outline-none focus-visible:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <div role="radiogroup" aria-label="Mode" className="inline-flex rounded-xl bg-surface-2 p-1">
              {(
                [
                  ['request', 'Request', PencilRuler],
                  ['ask', 'Ask', HelpCircle],
                ] as const
              ).map(([m, label, Icon]) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cx('flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors', mode === m ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:text-fg')}>
                  <Icon aria-hidden className={cx('size-3.5', mode === m && 'text-accent')} />
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <ModelPicker value={usable} onChange={pick} placement="bottom" align="end" />
              <Button type="submit" variant="primary" aria-label="Start" className="disabled:bg-surface-3 disabled:text-faint disabled:opacity-100 size-9 rounded-xl !px-0 transition-[background-color,opacity,transform] duration-150 active:scale-[0.92]" disabled={!text.trim() || busy}>
                {busy ? <Spinner /> : <ArrowUp aria-hidden className="size-4" strokeWidth={2.5} />}
              </Button>
            </div>
          </div>
        </div>
      </form>
      <div className="mt-4 flex animate-rise flex-wrap justify-center gap-2 [animation-delay:120ms]" aria-label="Examples" role="group">
        {EXAMPLES[mode].map((ex) => (
          <button key={ex} type="button" onClick={() => setText(ex)} className="rounded-full px-3.5 py-1.5 text-[12.5px] text-muted shadow-[0_0_0_1px_var(--border)] transition-[color,background-color,box-shadow,transform] duration-150 hover:bg-surface hover:text-fg hover:shadow-[0_0_0_1px_var(--border-strong)] active:scale-[0.97]">
            {ex}
          </button>
        ))}
      </div>
      {Boolean(error) && (
        <div className="mt-4 w-full text-left">
          <ErrorState error={error} />
        </div>
      )}
      <p className="mt-6 animate-rise text-[12px] text-faint [animation-delay:160ms]">{mode === 'request' ? 'Chat never changes code. Code is written only after you approve a spec.' : 'Answers are read-only. Chat never changes code.'}</p>
    </div>
  );
}

export function ChatScreen() {
  const qc = useQueryClient();
  const { search, navigate } = useRouter();
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const projectId = useChatProject(boot.data, search);
  const threadId = search.get('thread') ?? '';
  const [firstMessage, setFirstMessage] = useState<{ threadId: string; text: string } | null>(null);
  const threads = useQuery({ queryKey: ['threads', projectId], queryFn: () => api<ChatThread[]>(`/api/projects/${projectId}/threads`), enabled: Boolean(projectId) });
  const start = useMutation({
    mutationFn: ({ mode, model }: { mode: Mode; text: string; model: string }) => post<ChatThread>('/api/threads', { projectId, mode, ...(model ? { model } : {}) }),
    onSuccess: (t, v) => {
      void qc.invalidateQueries({ queryKey: ['threads', projectId] });
      // The composer glides from the centre to the bottom (View Transitions; an instant switch elsewhere).
      withTransition(() => {
        setFirstMessage({ threadId: t.id, text: v.text });
        navigate(`/chat?project=${projectId}&thread=${t.id}`);
      });
    },
  });
  if (boot.isLoading) return <Loading />;
  if (!boot.data?.projects.length) return <EmptyState icon={MessageSquarePlus} title="Add a project first" body="Chat works on a project's repositories." action={<Button variant="primary" onClick={() => navigate('/setup')}>Open setup</Button>} />;
  const project = boot.data.projects.find((p) => p.id === projectId);
  const repos = boot.data.repos.filter((r) => project?.repoIds.includes(r.id));
  const current = threads.data?.find((t) => t.id === threadId);

  return (
    <div className={cx('mx-auto w-full', current?.mode === 'request' ? 'max-w-[1080px]' : 'max-w-[780px]')}>
      {/* The sidebar lists conversations on wide screens; small screens get them here. */}
      {boot.data.projects.length > 1 && (
        <div className="mb-6 md:hidden">
          <Select label="Project" value={projectId} onChange={(p) => navigate(`/chat?project=${p}`)} options={boot.data.projects.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
      )}
      <section aria-label="Conversation" className={cx('min-w-0', current && 'flex min-h-[calc(100vh-7rem)] flex-col md:min-h-[calc(100vh-1rem)]')}>
        {current ? (
          <>
            {/* A slim title bar, like a chat app: the conversation gets the room. */}
            <div className="sticky top-0 z-20 -mx-4 mb-2 flex h-14 items-center justify-between gap-4 bg-bg/85 px-4 backdrop-blur-md md:-mx-8 md:px-8">
              <div className="flex min-w-0 items-center gap-2.5">
                <h1 className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">{current.title}</h1>
                <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-muted">{current.mode === 'request' ? 'Request' : 'Question'}</span>
              </div>
              {current.createdTaskId && (
                <Button size="sm" variant="primary" onClick={() => navigate(`/tasks/${current.createdTaskId}`)}>
                  Open task
                </Button>
              )}
            </div>
            <ThreadPanel
              key={current.id}
              threadId={current.id}
              repos={repos}
              placeholder={current.mode === 'request' ? 'Reply…' : 'Ask a follow-up…'}
              onTaskCreated={(id) => navigate(`/tasks/${id}`)}
              {...(firstMessage?.threadId === current.id ? { initialMessage: firstMessage.text, onInitialSent: () => setFirstMessage(null) } : {})}
            />
          </>
        ) : threadId && threads.isLoading ? (
          <Loading />
        ) : (
          <>
            <StartComposer projectName={project?.name ?? 'your code'} busy={start.isPending} error={start.error} onStart={(mode, text, model) => start.mutate({ mode, text, model })} />
            {Boolean(threads.data?.length) && (
              <nav aria-label="Recent conversations" className="mx-auto mt-12 max-w-2xl md:hidden">
                <p className="mb-2 px-1 text-[12px] font-medium text-faint">Recents</p>
                <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
                  {threads.data!.slice(0, 8).map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => navigate(`/chat?project=${projectId}&thread=${t.id}`)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[13.5px] hover:bg-surface-2">
                        <span className="truncate">{t.title}</span>
                        <span className="shrink-0 text-[12px] text-faint">{t.createdTaskId ? 'Became a task' : relativeTime(t.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
}
