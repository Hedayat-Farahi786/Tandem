import type { TandemEvent } from '@tandem/shared';
import type { EventSink } from '@tandem/core';

export interface StoredEvent {
  id: number;
  event: TandemEvent;
}

/** In-process event bus for SSE: monotonically increasing ids and a replay buffer for reconnects. */
export class EventBus implements EventSink {
  private next = 1;
  private readonly buffer: StoredEvent[] = [];
  private readonly subscribers = new Set<(e: StoredEvent) => void>();

  constructor(private readonly capacity = 2_000) {}

  emit(event: TandemEvent): void {
    const stored = { id: this.next++, event };
    this.buffer.push(stored);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const s of this.subscribers) s(stored);
  }

  /** Events after `lastId` still in the buffer (for Last-Event-ID). */
  since(lastId: number): StoredEvent[] {
    return this.buffer.filter((e) => e.id > lastId);
  }

  subscribe(fn: (e: StoredEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get size(): number {
    return this.subscribers.size;
  }
}
