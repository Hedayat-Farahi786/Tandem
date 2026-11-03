import { STEPS, type Actor, type TaskState } from '@tandem/shared';

const WORK: readonly TaskState[] = ['READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN'];
const STOPS: readonly TaskState[] = ['BLOCKED', 'FAILED', 'CANCELLED'];

/** Allowed transitions. Anything not listed is a bug and throws. */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ['READINESS', 'CANCELLED'],
  READINESS: ['SPEC_DRAFTING', ...STOPS],
  SPEC_DRAFTING: ['SPEC_REVIEW', ...STOPS],
  SPEC_REVIEW: ['BUILDING', 'SPEC_DRAFTING', ...STOPS],
  BUILDING: ['VERIFYING', ...STOPS],
  VERIFYING: ['SELF_REVIEW', ...STOPS],
  SELF_REVIEW: ['PR_OPEN', ...STOPS],
  // VERIFYING: the owner asks for another fix round on a PR whose checks still fail.
  PR_OPEN: ['DONE', 'VERIFYING', ...STOPS],
  DONE: [],
  // Blocked and failed tasks resume where they stopped (or are cancelled).
  BLOCKED: [...WORK, 'CANCELLED'],
  FAILED: [...WORK, 'CANCELLED'],
  CANCELLED: [],
};

/** Who may cause a transition into a state. The system may do anything the table allows. */
const HUMAN_ONLY: Partial<Record<TaskState, readonly Actor[]>> = {
  READINESS: ['owner', 'system'],
  CANCELLED: ['owner'],
};

export class TransitionError extends Error {
  override readonly name = 'TransitionError';
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState, actor: Actor): void {
  if (!canTransition(from, to)) throw new TransitionError(`A task can't go from ${from} to ${to}.`);
  const allowed = HUMAN_ONLY[to];
  if (allowed && !allowed.includes(actor)) throw new TransitionError(`Only ${allowed.join(' or ')} can move a task to ${to}.`);
}

export function stepsOf(state: TaskState): readonly string[] {
  return STEPS[state];
}

export function firstStep(state: TaskState): string | undefined {
  return STEPS[state][0];
}

export function nextStep(state: TaskState, step: string): string | undefined {
  const steps = STEPS[state] as readonly string[];
  const i = steps.indexOf(step);
  if (i < 0) throw new TransitionError(`${step} is not a step of ${state}.`);
  return steps[i + 1];
}

export function isStep(state: TaskState, step: string): boolean {
  return (STEPS[state] as readonly string[]).includes(step);
}

export type Lane = 'build' | 'read' | 'io';

/** Concurrency lane: builds are limited (default 1), read-only agent work separately. */
export function laneOf(state: TaskState): Lane {
  if (state === 'BUILDING' || state === 'VERIFYING' || state === 'SELF_REVIEW') return 'build';
  if (state === 'READINESS' || state === 'SPEC_DRAFTING') return 'read';
  return 'io';
}

/** States the runner keeps a job for (when not finished). */
export const RUNNABLE_STATES: readonly TaskState[] = ['READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN', 'DONE', 'CANCELLED'];
