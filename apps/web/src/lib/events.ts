import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TandemEvent } from '@tandem/shared';

type Listener = (e: TandemEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;

function connect() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data as string) as TandemEvent;
      for (const l of listeners) l(e);
    } catch {
      // ignore malformed events
    }
  };
  // EventSource reconnects by itself and sends Last-Event-ID, so missed events are replayed.
}

export function onEvent(fn: Listener): () => void {
  connect();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribes a component to live events. */
export function useEvents(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onEvent((e) => ref.current(e)), []);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Keeps cached queries fresh when the server reports changes. */
export function useLiveInvalidation() {
  const qc = useQueryClient();
  useEvents((e) => {
    if (e.type === 'task.transition' || e.type === 'task.updated' || e.type === 'task.blocked' || e.type === 'task.step') {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task', e.taskId] });
    }
    if (e.type === 'chat.done') void qc.invalidateQueries({ queryKey: ['thread', e.threadId] });
    // A busy run saves many steps: reload a task's activity at most every half second.
    if (e.type === 'agent.step' && e.taskId) {
      const key = e.taskId;
      if (!pending.has(key))
        pending.set(
          key,
          setTimeout(() => {
            pending.delete(key);
            void qc.invalidateQueries({ queryKey: ['task-activity', key] });
          }, 500),
        );
    }
  });
}
