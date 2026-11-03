import { z } from 'zod';

export const TASK_STATES = [
  'DRAFT',
  'READINESS',
  'SPEC_DRAFTING',
  'SPEC_REVIEW',
  'BUILDING',
  'VERIFYING',
  'SELF_REVIEW',
  'PR_OPEN',
  'DONE',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;
export const TaskState = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_STATES: readonly TaskState[] = ['DONE', 'CANCELLED'];
/** States in which the runner does work without waiting for a person. */
export const ACTIVE_STATES: readonly TaskState[] = ['READINESS', 'SPEC_DRAFTING', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN', 'DONE'];

export const BlockedReason = z.enum([
  'readiness-missing',
  'split-proposed',
  'spec-invalid',
  'rebase-conflict',
  'push-rejected',
  'preflight-failed',
  'pm-changes-requested',
  'budget-reached',
  'agent-unavailable',
]);
export type BlockedReason = z.infer<typeof BlockedReason>;

export const Actor = z.enum(['system', 'owner', 'pm', 'agent']);
export type Actor = z.infer<typeof Actor>;

/** Ordered steps per state. The runner persists the current step so a restart resumes there. */
export const STEPS = {
  DRAFT: [],
  READINESS: ['check-ready', 'check-size'],
  SPEC_DRAFTING: ['refresh-refs', 'draft'],
  SPEC_REVIEW: ['await-pm'],
  BUILDING: ['prepare-workspace', 'implement', 'commit'],
  VERIFYING: ['verify'],
  SELF_REVIEW: ['review', 'sync', 'push'],
  PR_OPEN: ['open-prs', 'report', 'poll'],
  DONE: ['cleanup'],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: ['cleanup'],
} as const satisfies Record<TaskState, readonly string[]>;
export type StepOf<S extends TaskState> = (typeof STEPS)[S][number];
export type Step = StepOf<TaskState>;
