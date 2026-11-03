import { STATE_LABELS, type Actor, type BlockedReason, type Task, type TaskState } from '@tandem/shared';
import type { Clock, EventSink, Job, Store } from '../ports.js';
import { RUNNABLE_STATES, assertTransition, firstStep, isStep } from '../state-machine.js';

export interface TransitionOptions {
  to: TaskState;
  step?: string;
  reason: string;
  actor: Actor;
  blocked?: { reason: BlockedReason; message: string; resumeTo: { state: TaskState; step?: string } };
  /** Extra task fields to set in the same transaction. */
  patch?: Partial<Task>;
  /** Run the first job no earlier than this (epoch ms). */
  notBefore?: number;
}

/**
 * Moves a task to a new state: task row, transition history and job are written in one
 * transaction, so the timeline can never disagree with the task.
 */
export async function applyTransition(tx: Store, clock: Clock, task: Task, o: TransitionOptions, events?: EventSink): Promise<Task> {
  assertTransition(task.state, o.to, o.actor);
  const step = o.step && isStep(o.to, o.step) ? o.step : firstStep(o.to);
  const now = clock.iso();
  const next: Task = {
    ...task,
    ...o.patch,
    state: o.to,
    updatedAt: now,
  };
  if (step) next.step = step;
  else delete next.step;
  if (o.to === 'BLOCKED' && o.blocked) {
    next.blockedReason = o.blocked.reason;
    next.blockedMessage = o.blocked.message;
    next.resumeTo = o.blocked.resumeTo;
  } else if (o.to === 'FAILED') {
    next.blockedMessage = o.reason;
    next.resumeTo = o.patch?.resumeTo ?? { state: task.state, ...(task.step ? { step: task.step } : {}) };
    delete next.blockedReason;
  } else {
    delete next.blockedReason;
    delete next.blockedMessage;
    delete next.resumeTo;
  }
  await tx.tasks.upsert(next);
  await tx.transitions.add({ taskId: task.id, from: task.state, to: o.to, ...(step ? { step } : {}), reason: o.reason, actor: o.actor, at: now });
  const ownerName = o.actor === 'owner' ? (await tx.settings.get()).ownerName.trim() : '';
  await tx.audit.append({ at: now, actor: o.actor, ...(ownerName ? { actorName: ownerName } : {}), action: 'task.state', summary: `${task.key}: ${STATE_LABELS[task.state]} → ${STATE_LABELS[o.to]}. ${o.reason}`, taskId: task.id, projectId: task.projectId, detail: { from: task.state, to: o.to, ...(step ? { step } : {}) } });
  await scheduleJob(tx, clock, next, o.notBefore);
  events?.emit({ type: 'task.transition', taskId: task.id, from: task.state, to: o.to, reason: o.reason, at: now });
  if (o.to === 'BLOCKED' && o.blocked) events?.emit({ type: 'task.blocked', taskId: task.id, reason: o.blocked.reason, message: o.blocked.message, at: now });
  return next;
}

/** A task in a runnable state with a step gets exactly one queued job; any other task gets none. */
export async function scheduleJob(tx: Store, clock: Clock, task: Task, notBefore?: number): Promise<void> {
  if (RUNNABLE_STATES.includes(task.state) && task.step) {
    const job: Job = { taskId: task.id, state: task.state, step: task.step, status: 'queued', attempt: 0, notBefore: notBefore ?? clock.now() };
    await tx.jobs.upsert(job);
  } else {
    await tx.jobs.delete(task.id);
  }
}
