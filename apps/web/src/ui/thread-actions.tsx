import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListTodo, MoreHorizontal, Pencil, Pin, PinOff, Trash2, type LucideIcon } from 'lucide-react';
import { api, del, put } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import type { ChatThread, TaskListItem } from '../lib/types';
import { Button, Dialog, cx, useToast } from './kit';

/* ============================================================ action menu */

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  /** A line above this item. */
  divider?: boolean;
}

/**
 * A "⋯" button with a small menu. The menu is drawn over the page (not clipped by a scrolling list)
 * and works from the keyboard: arrows move, Enter picks, Escape closes and returns focus.
 */
export function ActionMenu({ label, items, className, onOpenChange }: { label: string; items: MenuItem[]; className?: string; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const enabled = items.map((x, i) => (x.disabled ? -1 : i)).filter((i) => i >= 0);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const place = () => {
      const r = trigger.current!.getBoundingClientRect();
      const w = menu.current?.offsetWidth ?? 200;
      const h = menu.current?.offsetHeight ?? 160;
      const below = r.bottom + 4 + h <= window.innerHeight - 8;
      setPos({ top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - h), left: Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8) });
    };
    place();
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (open && pos) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.focus();
  }, [open, pos, active]);

  const pick = (i: number) => {
    const item = items[i];
    if (!item || item.disabled) return;
    setOpen(false);
    trigger.current?.focus();
    item.run();
  };
  const step = (d: 1 | -1) => {
    const at = enabled.indexOf(active);
    setActive(enabled[(at + d + enabled.length) % enabled.length] ?? 0);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setActive(enabled[0] ?? 0);
          setPos(null);
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setActive(enabled[0] ?? 0);
            setOpen(true);
          }
        }}
        className={cx('grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent', open && 'bg-surface-3 text-fg', className)}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                step(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                step(-1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              } else if (e.key === 'Tab') setOpen(false);
            }}
            className="z-50 w-52 animate-pop rounded-xl bg-surface p-1 text-fg shadow-lg ring-1 ring-line"
          >
            {items.map((item, i) => (
              <div key={item.label}>
                {item.divider && <div className="my-1 h-px bg-line" />}
                <button
                  type="button"
                  role="menuitem"
                  data-i={i}
                  tabIndex={-1}
                  aria-disabled={item.disabled || undefined}
                  title={item.hint}
                  onMouseEnter={() => !item.disabled && setActive(i)}
                  onClick={() => pick(i)}
                  className={cx(
                    'flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] outline-none',
                    item.disabled ? 'cursor-not-allowed text-faint' : item.danger ? 'text-danger' : 'text-fg',
                    active === i && !item.disabled && (item.danger ? 'bg-danger-soft' : 'bg-surface-2'),
                  )}
                >
                  <item.icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ========================================================= chat actions */

/** Rename, pin and delete a chat, keeping every list and open page in step. */
export function useThreadActions(projectId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { path, search, navigate } = useRouter();
  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: ['threads', projectId] });
    void qc.invalidateQueries({ queryKey: ['thread', id] });
  };
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger');
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => put<ChatThread>(`/api/threads/${id}/title`, { title }),
    // Show the new name at once; the server's answer settles it.
    onMutate: ({ id, title }) => {
      qc.setQueryData<ChatThread[]>(['threads', projectId], (list) => list?.map((t) => (t.id === id ? { ...t, title } : t)));
    },
    onSuccess: (_t, { id }) => refresh(id),
    onError: (e, { id }) => {
      fail(e);
      refresh(id);
    },
  });
  const pin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => put<ChatThread>(`/api/threads/${id}/pin`, { pinned }),
    onSuccess: (t, { id }) => {
      refresh(id);
      toast(t.pinnedAt ? 'Pinned to the top.' : 'Unpinned.', 'ok');
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (t: ChatThread) => del<{ deleted: true }>(`/api/threads/${t.id}`),
    onSuccess: (_r, t) => {
      try {
        localStorage.removeItem(`tandem.draft.${t.id}`);
      } catch {
        /* storage may be unavailable */
      }
      // Leave the chat first, so nothing asks for it again.
      if (path.startsWith('/chat') && search.get('thread') === t.id) navigate(`/chat?project=${projectId}`, { replace: true });
      qc.setQueryData<ChatThread[]>(['threads', projectId], (list) => list?.filter((x) => x.id !== t.id));
      qc.removeQueries({ queryKey: ['thread', t.id] });
      void qc.invalidateQueries({ queryKey: ['threads', projectId] });
      toast('Chat deleted.', 'ok');
    },
    onError: fail,
  });
  return { rename, pin, remove };
}

/** The menu items for one chat. */
function threadItems(t: ChatThread, o: { onRename: () => void; onPin: () => void; onDelete: () => void; openTask: () => void }): MenuItem[] {
  return [
    { label: t.pinnedAt ? 'Unpin' : 'Pin to top', icon: t.pinnedAt ? PinOff : Pin, run: o.onPin },
    { label: 'Rename', icon: Pencil, run: o.onRename },
    ...(t.createdTaskId ? [{ label: 'Open the task', icon: ListTodo, run: o.openTask }] : []),
    {
      label: 'Delete',
      icon: Trash2,
      run: o.onDelete,
      danger: true,
      divider: true,
      ...(t.busy ? { disabled: true, hint: 'Copilot is answering in this chat. Delete it once the answer is in.' } : {}),
    },
  ];
}

/** Asks before deleting a chat, and says what stays. */
export function DeleteThreadDialog({ thread, projectId, onClose }: { thread: ChatThread | null; projectId: string; onClose: () => void }) {
  const { remove } = useThreadActions(projectId);
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<TaskListItem[]>('/api/tasks'), enabled: Boolean(thread?.createdTaskId) });
  const task = thread?.createdTaskId ? tasks.data?.find((x) => x.id === thread.createdTaskId) : undefined;
  return (
    <Dialog
      open={Boolean(thread)}
      onClose={onClose}
      title="Delete this chat?"
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            variant="danger"
            icon={Trash2}
            busy={remove.isPending}
            onClick={() => thread && remove.mutate(thread, { onSuccess: onClose })}
          >
            Delete chat
          </Button>
        </>
      }
    >
      {thread && (
        <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-muted">
          <p>
            <span className="font-medium text-fg">“{thread.title}”</span> and all its messages will be deleted. This can't be undone.
          </p>
          {thread.createdTaskId && (
            <p>
              {task ? <span className="font-medium text-fg">{task.key}</span> : 'The task made from it'} isn't affected: it keeps its own copy of the request, the spec and the trace.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Edits a chat's name in place: Enter or leaving the field saves, Escape cancels. */
function RenameField({ value, onSave, onCancel, className }: { value: string; onSave: (title: string) => void; onCancel: () => void; className?: string }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const t = text.replace(/\s+/g, ' ').trim();
    if (save && t && t !== value) onSave(t);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      aria-label="Chat name"
      value={text}
      maxLength={120}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      className={cx('w-full min-w-0 rounded-md border border-fg/40 bg-surface px-2 text-fg outline-none focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]', className)}
    />
  );
}

/* ============================================================ sidebar */

/** The sidebar's chats: pinned ones first, then recent ones, each with rename, pin and delete. */
export function ChatRecents({ projectId }: { projectId: string }) {
  const { path, search, navigate } = useRouter();
  const threads = useQuery({
    queryKey: ['threads', projectId],
    queryFn: () => api<ChatThread[]>(`/api/projects/${projectId}/threads`),
    enabled: Boolean(projectId),
  });
  const { rename, pin } = useThreadActions(projectId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ChatThread | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const current = path.startsWith('/chat') ? search.get('thread') : null;
  const pinned = threads.data?.filter((t) => t.pinnedAt) ?? [];
  const recent = threads.data?.filter((t) => !t.pinnedAt) ?? [];
  // The project's tasks that are still going, so a task never hides among the chats.
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<TaskListItem[]>('/api/tasks'), enabled: Boolean(projectId), refetchInterval: 15_000 });
  const open = (tasks.data ?? []).filter((t) => t.projectId === projectId && t.state !== 'DONE' && t.state !== 'CANCELLED').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const SHOWN = 5;
  const taskRow = (t: TaskListItem) => {
    const active = path === `/tasks/${t.id}`;
    const s = taskStatus(t);
    return (
      <li key={t.id}>
        <Link
          to={`/tasks/${t.id}`}
          aria-current={active ? 'page' : undefined}
          title={`${t.title} · ${s.word}`}
          className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150', active ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--border)]' : 'text-muted hover:bg-surface-3/60 hover:text-fg')}
        >
          <span aria-hidden className="relative grid size-2 shrink-0 place-items-center">
            {s.pulse && <span className={cx('absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden', s.dot)} />}
            <span className={cx('size-[7px] rounded-full', s.dot)} />
          </span>
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
          <span className="sr-only">, {s.word}</span>
        </Link>
      </li>
    );
  };

  const row = (t: ChatThread) => {
    const active = t.id === current;
    if (renaming === t.id)
      return (
        <li key={t.id} className="px-0.5 py-px">
          <RenameField value={t.title} className="h-8 text-[13px]" onCancel={() => setRenaming(null)} onSave={(title) => { setRenaming(null); rename.mutate({ id: t.id, title }); }} />
        </li>
      );
    const menuOpen = menuFor === t.id;
    return (
      <li key={t.id} className="group/row relative">
        <Link
          to={`/chat?project=${projectId}&thread=${t.id}`}
          aria-current={active ? 'page' : undefined}
          title={`${t.title} · ${t.createdTaskId ? 'became a task' : t.mode === 'request' ? 'request' : 'question'} · ${relativeTime(t.updatedAt)}`}
          onDoubleClick={(e) => {
            e.preventDefault();
            setRenaming(t.id);
          }}
          className={cx(
            'flex h-8 items-center gap-2 rounded-lg pr-8 pl-2.5 text-[13px] transition-colors duration-150',
            active ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--border)]' : cx('text-muted hover:bg-surface-3/60 hover:text-fg', menuOpen && 'bg-surface-3/60 text-fg'),
          )}
        >
          <span className="min-w-0 flex-1 truncate">{t.title}</span>
        </Link>
        <span className="absolute inset-y-0 right-1 flex items-center">
          <ActionMenu
            label={`Actions for ${t.title}`}
            onOpenChange={(o) => setMenuFor(o ? t.id : null)}
            className={cx('opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100', (menuOpen || active) && 'opacity-100')}
            items={threadItems(t, {
              onRename: () => setRenaming(t.id),
              onPin: () => pin.mutate({ id: t.id, pinned: !t.pinnedAt }),
              onDelete: () => setDeleting(t),
              openTask: () => navigate(`/tasks/${t.createdTaskId}`),
            })}
          />
        </span>
      </li>
    );
  };

  return (
    <nav aria-label="Conversations" className="mt-6 flex min-h-0 flex-1 flex-col">
      {/* Scrolls without a visible bar; the list fades out at the bottom edge when there is more. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {open.length > 0 && (
          <Group title="Open tasks">
            <ul aria-label="Open tasks" className="flex flex-col gap-px">
              {open.slice(0, SHOWN).map(taskRow)}
              {open.length > SHOWN && (
                <li>
                  <Link to="/tasks" className="flex h-7 items-center rounded-lg px-2.5 text-[12px] text-faint transition-colors hover:bg-surface-3/60 hover:text-fg">
                    {open.length - SHOWN} more in Tasks
                  </Link>
                </li>
              )}
            </ul>
          </Group>
        )}
        {pinned.length > 0 && (
          <Group title="Pinned">
            <ul aria-label="Pinned chats" className="flex flex-col gap-px">
              {pinned.map(row)}
            </ul>
          </Group>
        )}
        <Group title="Chats">
          <ul aria-label="Recent chats" className="flex flex-col gap-px">
            {threads.isLoading && <li className="px-2.5 py-1.5 text-[12px] text-faint">Loading…</li>}
            {threads.data?.length === 0 && <li className="px-2.5 py-1.5 text-[12px] leading-snug text-faint">Your questions and requests appear here.</li>}
            {recent.map(row)}
          </ul>
        </Group>
      </div>
      <DeleteThreadDialog thread={deleting} projectId={projectId} onClose={() => setDeleting(null)} />
    </nav>
  );
}

/** A task's state as the sidebar shows it: a coloured dot, and the word behind it. */
function taskStatus(t: TaskListItem): { dot: string; word: string; pulse?: boolean } {
  if (t.state === 'FAILED') return { dot: 'bg-danger', word: 'stopped' };
  if (t.state === 'BLOCKED' || t.state === 'SPEC_REVIEW' || t.needsAttention) return { dot: 'bg-warn', word: t.state === 'SPEC_REVIEW' ? 'spec to review' : 'needs you' };
  if (t.state === 'PR_OPEN') return { dot: 'bg-ok', word: 'pull request open' };
  if (t.state === 'DRAFT') return { dot: 'bg-line-strong', word: 'not started' };
  return { dot: 'bg-accent', word: 'working', pulse: true };
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1 flex h-6 items-center px-2.5 text-[12px] font-medium text-faint">{title}</p>
      {children}
    </div>
  );
}

/* ======================================================== chat title bar */

/** The open chat's name, renamable in place, with the same actions as the sidebar. */
export function ThreadTitle({ thread, projectId }: { thread: ChatThread; projectId: string }) {
  const { navigate } = useRouter();
  const { rename, pin } = useThreadActions(projectId);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {editing ? (
        <RenameField value={thread.title} className="h-8 w-[min(420px,60vw)] text-[15px] font-semibold" onCancel={() => setEditing(false)} onSave={(title) => { setEditing(false); rename.mutate({ id: thread.id, title }); }} />
      ) : (
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {thread.title}
        </h1>
      )}
      {thread.pinnedAt && !editing && <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-faint" />}
      {!editing && (
        <ActionMenu
          label="Chat actions"
          items={threadItems(thread, {
            onRename: () => setEditing(true),
            onPin: () => pin.mutate({ id: thread.id, pinned: !thread.pinnedAt }),
            onDelete: () => setDeleting(true),
            openTask: () => navigate(`/tasks/${thread.createdTaskId}`),
          })}
        />
      )}
      <DeleteThreadDialog thread={deleting ? thread : null} projectId={projectId} onClose={() => setDeleting(false)} />
    </div>
  );
}
