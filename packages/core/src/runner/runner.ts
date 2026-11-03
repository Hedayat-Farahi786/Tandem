import type { BlockedReason, Task, TaskState } from '@tandem/shared';
import { BudgetError } from '../budget.js';
import { DiskSpaceError } from '../workflow/deps.js';
import { RetryableError, type Clock, type EventSink, type Job, type Logger, type Store } from '../ports.js';
import { RUNNABLE_STATES, TransitionError, firstStep, isStep, laneOf, nextStep, type Lane } from '../state-machine.js';
import { applyTransition, scheduleJob } from './transition.js';

export type StepOutcome =
  | { kind: 'next'; patch?: Partial<Task> }
  | { kind: 'goto'; state: TaskState; step?: string; reason: string; patch?: Partial<Task> }
  | { kind: 'block'; reason: BlockedReason; message: string; resumeTo: { state: TaskState; step?: string }; patch?: Partial<Task> }
  | { kind: 'wait'; ms: number; patch?: Partial<Task> }
  | { kind: 'idle'; patch?: Partial<Task> };

export interface StepContext {
  task: Task;
  attempt: number;
  signal: AbortSignal;
  /** Saves step progress immediately (so a crash later in the step doesn't repeat finished work). */
  saveProgress(progress: Record<string, unknown>): Promise<Task>;
}

export type StepHandler = (ctx: StepContext) => Promise<StepOutcome>;
export type StepHandlers = Partial<Record<`${TaskState}:${string}`, StepHandler>>;

export interface RunnerOptions {
  store: Store;
  clock: Clock;
  bootId: string;
  handlers: StepHandlers;
  capacity: () => Promise<Record<Lane, number>>;
  events?: EventSink;
  logger?: Logger;
  retry?: { attempts: number; baseMs: number; maxMs: number };
  isRetryable?: (err: unknown) => boolean;
  random?: () => number;
}

const DEFAULT_RETRY = { attempts: 4, baseMs: 2_000, maxMs: 60_000 };

/**
 * Durable job runner. One job per task (its current step), persisted in the store. On boot,
 * `recover()` re-queues jobs from a previous process and creates jobs for tasks that need one.
 */
export class Runner {
  private readonly running = new Map<string, { promise: Promise<void>; controller: AbortController; lane: Lane }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;
  private readonly retry: { attempts: number; baseMs: number; maxMs: number };

  constructor(private readonly o: RunnerOptions) {
    this.retry = o.retry ?? DEFAULT_RETRY;
  }

  async recover(): Promise<{ requeued: number; created: number }> {
    const { store, clock, bootId } = this.o;
    let requeued = 0;
    let created = 0;
    await store.transaction(async (tx) => {
      for (const job of await tx.jobs.list()) {
        if (job.status === 'running' && job.leaseBootId !== bootId) {
          const { leaseBootId: _old, ...rest } = job;
          await tx.jobs.upsert({ ...rest, status: 'queued', notBefore: clock.now() });
          requeued++;
        }
      }
      const withJob = new Set((await tx.jobs.list()).map((j) => j.taskId));
      for (const task of await tx.tasks.listByState(RUNNABLE_STATES)) {
        if (withJob.has(task.id)) continue;
        if ((task.state === 'DONE' || task.state === 'CANCELLED') && task.progress.cleanedUp) continue;
        const step = task.step && isStep(task.state, task.step) ? task.step : firstStep(task.state);
        if (!step) continue;
        await scheduleJob(tx, clock, { ...task, step });
        created++;
      }
    });
    this.o.logger?.info('runner recovered', { requeued, created, bootId });
    return { requeued, created };
  }

  /**
   * Starts every runnable job the lane limits allow. Returns how many started. A tick that arrives
   * while another is in flight waits for it (so callers never see "nothing running" too early).
   */
  async tick(): Promise<number> {
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
      return this.running.size > 0 ? 1 : 0;
    }
    this.inFlight = this.startRunnable().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async startRunnable(): Promise<number> {
    const capacity = await this.o.capacity();
    const used: Record<Lane, number> = { build: 0, read: 0, io: 0 };
    for (const r of this.running.values()) used[r.lane]++;
    const now = this.o.clock.now();
    const jobs = (await this.o.store.jobs.list()).filter((j) => j.status === 'queued' && j.notBefore <= now && !this.running.has(j.taskId)).sort((a, b) => a.notBefore - b.notBefore);
    let started = 0;
    for (const job of jobs) {
      const lane = laneOf(job.state);
      if (used[lane] >= capacity[lane]) continue;
      used[lane]++;
      started++;
      const controller = new AbortController();
      const promise = this.execute(job, controller).finally(() => this.running.delete(job.taskId));
      this.running.set(job.taskId, { promise, controller, lane });
    }
    return started;
  }

  /** Waits for the jobs that are running now. */
  async settle(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => r.promise));
  }

  /** Test and CLI helper: runs until nothing is runnable right now. */
  async runUntilIdle(maxRounds = 500): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const started = await this.tick();
      if (started === 0 && this.running.size === 0) return;
      await this.settle();
    }
    throw new Error(`runner did not settle after ${maxRounds} rounds`);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Asks a running step to stop (used by Cancel). The task's new state is already stored. */
  abort(taskId: string): void {
    this.running.get(taskId)?.controller.abort();
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.o.logger?.error('runner tick failed', { error: String(err) }));
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Stops scheduling and waits for running steps. Interrupted work resumes on the next boot. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.settle();
  }

  private async execute(job: Job, controller: AbortController): Promise<void> {
    const { store, clock, bootId, handlers } = this.o;
    const claimed = await store.transaction(async (tx) => {
      const current = await tx.jobs.get(job.taskId);
      if (!current || current.status !== 'queued' || current.step !== job.step || current.state !== job.state) return undefined;
      const lease: Job = { ...current, status: 'running', leaseBootId: bootId };
      await tx.jobs.upsert(lease);
      return lease;
    });
    if (!claimed) return;
    const task = await store.tasks.get(job.taskId);
    if (!task || task.state !== job.state) {
      await store.jobs.delete(job.taskId);
      return;
    }
    const handler = handlers[`${job.state}:${job.step}`];
    if (!handler) {
      await this.fail(task, claimed, new Error(`No handler for ${job.state}/${job.step}.`));
      return;
    }
    this.o.events?.emit({ type: 'task.step', taskId: task.id, state: task.state, step: job.step, at: clock.iso() });
    let current = task;
    const ctx: StepContext = {
      task,
      attempt: claimed.attempt,
      signal: controller.signal,
      saveProgress: async (progress) => {
        const fresh = (await store.tasks.get(task.id)) ?? current;
        current = { ...fresh, progress: { ...fresh.progress, ...progress }, updatedAt: clock.iso() };
        await store.tasks.upsert(current);
        ctx.task = current;
        return current;
      },
    };
    let outcome: StepOutcome;
    try {
      outcome = await handler(ctx);
    } catch (err) {
      await this.handleError(ctx.task, claimed, err);
      return;
    }
    await this.applyOutcome(ctx.task, claimed, outcome);
  }

  private async applyOutcome(task: Task, job: Job, outcome: StepOutcome): Promise<void> {
    const { store, clock, events } = this.o;
    await store.transaction(async (tx) => {
      const fresh = await tx.tasks.get(task.id);
      // A person changed the task while the step ran (for example Cancel): their change wins.
      if (!fresh || fresh.state !== job.state) return;
      const base: Task = { ...fresh, progress: { ...fresh.progress, ...task.progress } };
      const withPatch = (p?: Partial<Task>): Task => ({ ...base, ...p, progress: { ...base.progress, ...(p?.progress ?? {}) }, updatedAt: clock.iso() });
      switch (outcome.kind) {
        case 'next': {
          const step = nextStep(job.state, job.step);
          if (!step) throw new TransitionError(`${job.state}/${job.step} is the last step; the handler must move the task on.`);
          const t = { ...withPatch(outcome.patch), step };
          await tx.tasks.upsert(t);
          await tx.jobs.upsert({ taskId: t.id, state: t.state, step, status: 'queued', attempt: 0, notBefore: clock.now() });
          return;
        }
        case 'goto':
          await applyTransition(tx, clock, base, { to: outcome.state, ...(outcome.step ? { step: outcome.step } : {}), reason: outcome.reason, actor: 'system', ...(outcome.patch ? { patch: outcome.patch } : {}) }, events);
          return;
        case 'block':
          await applyTransition(tx, clock, base, { to: 'BLOCKED', reason: outcome.message, actor: 'system', blocked: { reason: outcome.reason, message: outcome.message, resumeTo: outcome.resumeTo }, ...(outcome.patch ? { patch: outcome.patch } : {}) }, events);
          return;
        case 'wait': {
          const t = withPatch(outcome.patch);
          await tx.tasks.upsert(t);
          await tx.jobs.upsert({ taskId: t.id, state: t.state, step: job.step, status: 'queued', attempt: 0, notBefore: clock.now() + outcome.ms });
          return;
        }
        case 'idle':
          await tx.tasks.upsert(withPatch(outcome.patch));
          await tx.jobs.delete(task.id);
          return;
      }
    });
  }

  private async handleError(task: Task, job: Job, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BudgetError) {
      await this.applyOutcome(task, job, { kind: 'block', reason: 'budget-reached', message, resumeTo: { state: job.state, step: job.step } });
      return;
    }
    if (err instanceof DiskSpaceError) {
      await this.applyOutcome(task, job, { kind: 'block', reason: 'disk-low', message, resumeTo: { state: job.state, step: job.step } });
      return;
    }
    const retryable = err instanceof RetryableError || (this.o.isRetryable?.(err) ?? false);
    if (retryable && job.attempt + 1 < this.retry.attempts) {
      const delay = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** job.attempt) * (0.8 + 0.4 * (this.o.random ?? Math.random)());
      this.o.logger?.warn('step failed, retrying', { taskId: task.id, step: job.step, attempt: job.attempt + 1, delayMs: Math.round(delay), error: message });
      await this.o.store.jobs.upsert({ taskId: job.taskId, state: job.state, step: job.step, status: 'queued', attempt: job.attempt + 1, notBefore: this.o.clock.now() + Math.round(delay), lastError: message });
      return;
    }
    await this.fail(task, job, err);
  }

  private async fail(task: Task, job: Job, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.o.logger?.error('step failed', { taskId: task.id, state: job.state, step: job.step, error: message });
    await this.o.store.transaction(async (tx) => {
      const fresh = await tx.tasks.get(task.id);
      if (!fresh || fresh.state !== job.state) return;
      await applyTransition(tx, this.o.clock, { ...fresh, progress: { ...fresh.progress, ...task.progress } }, { to: 'FAILED', reason: `${job.state} / ${job.step} failed: ${message}`, actor: 'system', patch: { resumeTo: { state: job.state, step: job.step } } }, this.o.events);
    });
  }
}
