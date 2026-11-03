import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, FileText, GitPullRequest, HelpCircle, MessageSquarePlus, PencilRuler, Sparkles } from 'lucide-react';
import type { ChatMessage, ChatThread } from '@tandem/shared';
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

function Message({ m, repoName, enter = isFresh(m) }: { m: ChatMessage; repoName: (id?: string) => string; enter?: boolean }) {
  if (m.role === 'system') {
    return (
      <div className="flex justify-center">
        <p className="rounded-full bg-surface-2 px-3 py-1 text-[12px] text-muted">{m.content}</p>
      </div>
    );
  }
  const mine = m.role === 'user';
  return (
    <div className={cx('flex', enter && 'animate-rise', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[min(680px,92%)]', mine ? 'rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5' : 'px-1')}>
        {mine ? <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{m.content}</p> : <Markdown source={m.content} />}
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
export function ThreadPanel({ threadId, placeholder, repos, onTaskCreated, compact, initialMessage, onInitialSent }: { threadId: string; placeholder: string; repos: Array<{ id: string; name: string }>; onTaskCreated?: (taskId: string) => void; compact?: boolean; initialMessage?: string; onInitialSent?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const view = useQuery({ queryKey: ['thread', threadId], queryFn: () => api<ThreadView>(`/api/threads/${threadId}`) });
  const [text, setText] = useState('');
  const [stream, setStream] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEvents((e) => {
    if (e.type === 'agent.delta' && e.threadId === threadId) setStream((s) => s + e.text);
  });
  const send = useMutation({
    mutationFn: (t: string) => post(`/api/threads/${threadId}/messages`, { text: t }),
    onMutate: (t) => {
      setPending(t);
      setStream('');
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      setPending(null);
      setStream('');
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
  const applyChange = useMutation({
    mutationFn: (apply: boolean) => post(`/api/threads/${threadId}/spec-change/${apply ? 'apply' : 'dismiss'}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task'] });
    },
  });
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    void end.current?.scrollIntoView?.({ block: 'end' });
  }, [view.data?.messages.length, stream, pending]);
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
            <Message key={m.id} m={m} repoName={repoName} />
          ))}
          {pending && <Message enter m={{ id: 'pending', threadId, role: 'user', content: pending, refs: [], createdAt: '' }} repoName={repoName} />}
          {send.isPending && (
            <div className="px-1">
              {stream ? <Markdown source={stream} /> : null}
              <p className="mt-1 flex animate-in items-center gap-2.5 text-[12.5px] text-muted" role="status">
                <span aria-hidden className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
                {stream ? 'Writing…' : 'Reading the code…'}
              </p>
            </div>
          )}
          {send.isError && <ErrorState title="The message was not answered" error={send.error} />}
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
          <div ref={end} />
        </div>
        <form
          className="sticky bottom-4 mt-auto pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
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
              placeholder={done ? 'This request became a task. Continue in the task chat.' : placeholder}
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
              <Button type="submit" variant="primary" aria-label="Send" className="disabled:bg-surface-3 disabled:text-faint disabled:opacity-100 size-8 rounded-[10px] !px-0 transition-[background-color,opacity,transform] duration-150 active:scale-[0.92]" disabled={!text.trim() || send.isPending || done}>
                {send.isPending ? <Spinner /> : <ArrowUp aria-hidden className="size-4" strokeWidth={2.5} />}
              </Button>
            </div>
          </div>
          <p className="mt-1.5 px-2 text-[11.5px] text-faint">Enter to send · Shift+Enter for a new line · Chat never changes code.</p>
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
    <div className="relative mx-auto flex min-h-[calc(100vh-11rem)] max-w-2xl flex-col items-center justify-center pb-[6vh] text-center md:min-h-[calc(100vh-5rem)]">
      <div aria-hidden className="pointer-events-none absolute top-[14%] left-1/2 h-[380px] w-[min(760px,100%)] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--surface-3),transparent)] opacity-80 blur-2xl" />
      <span aria-hidden className="relative mb-5 grid size-11 animate-rise place-items-center rounded-[14px] bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_10px_24px_-10px_rgb(0_0_0/0.45)]">
        <svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M3.5 4.5h9M8 4.5v8" />
        </svg>
      </span>
      <h1 className="relative animate-rise font-display text-[34px] leading-tight">{mode === 'request' ? 'What should we build?' : 'What would you like to know?'}</h1>
      <p className="relative mt-2 animate-rise text-[14.5px] text-muted [animation-delay:40ms]">{mode === 'request' ? `Describe a change to ${projectName}. Tandem asks until it is clear, then turns it into a reviewed pull request.` : `Ask anything about ${projectName}. Answers are read-only and cite files and lines.`}</p>
      <form
        className="relative mt-8 w-full animate-rise text-left [animation-delay:80ms]"
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
      <div className="relative mt-4 flex animate-rise flex-wrap justify-center gap-2 [animation-delay:120ms]" aria-label="Examples" role="group">
        {EXAMPLES[mode].map((ex) => (
          <button key={ex} type="button" onClick={() => setText(ex)} className="inline-flex items-center gap-1.5 rounded-full bg-surface/80 px-3.5 py-1.5 text-[12.5px] text-muted shadow-[0_0_0_1px_var(--border)] transition-[color,background-color,box-shadow,transform] duration-150 hover:bg-surface hover:text-fg hover:shadow-[0_0_0_1px_var(--border-strong),var(--shadow-sm)] active:scale-[0.97]">
            <Sparkles aria-hidden className="size-3 text-faint" />
            {ex}
          </button>
        ))}
      </div>
      {Boolean(error) && (
        <div className="mt-4 w-full text-left">
          <ErrorState error={error} />
        </div>
      )}
      {mode === 'request' ? (
        <ol aria-label="How it works" className="relative mt-10 flex animate-rise flex-wrap items-center justify-center gap-x-2 gap-y-2 text-[12.5px] text-muted [animation-delay:160ms]">
          {(
            [
              [MessageSquarePlus, 'Describe it'],
              [FileText, 'Approve the spec'],
              [GitPullRequest, 'Review the pull request'],
            ] as const
          ).map(([Icon, label], i) => (
            <li key={label} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="h-px w-6 bg-line-strong" />}
              <span className="grid size-6 place-items-center rounded-lg bg-surface text-fg shadow-[0_0_0_1px_var(--border)]">
                <Icon aria-hidden className="size-3.5" strokeWidth={1.9} />
              </span>
              {label}
            </li>
          ))}
        </ol>
      ) : (
        <p className="relative mt-8 animate-rise text-[12px] text-faint [animation-delay:160ms]">Answers are read-only. Chat never changes code.</p>
      )}
      {mode === 'request' && <p className="relative mt-3 text-[12px] text-faint">Chat never changes code. Code is written only after you approve a spec.</p>}
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
      <section aria-label="Conversation" className={cx('min-w-0', current && 'flex min-h-[calc(100vh-9rem)] flex-col md:min-h-[calc(100vh-5rem)]')}>
        {current ? (
          <>
            <div className="mb-6 flex items-center justify-between gap-4 border-b border-line pb-4">
              <div className="min-w-0">
                <h1 className="truncate font-display text-[22px] tracking-tight">{current.title}</h1>
                <p className="text-[12.5px] text-muted">{current.mode === 'request' ? 'Request · Tandem asks until it is ready to build' : 'Ask · read-only answers about the code'}</p>
              </div>
              {current.createdTaskId && (
                <Button variant="primary" onClick={() => navigate(`/tasks/${current.createdTaskId}`)}>
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
