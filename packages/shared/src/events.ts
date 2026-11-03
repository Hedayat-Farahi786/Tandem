import type { BlockedReason, TaskState } from './states.js';

/** Events pushed to the UI over SSE. Anything that matters is also stored, so a reload rebuilds state. */
export type TandemEvent =
  | { type: 'task.transition'; taskId: string; from: TaskState; to: TaskState; reason: string; at: string }
  | { type: 'task.step'; taskId: string; state: TaskState; step: string; at: string }
  | { type: 'task.blocked'; taskId: string; reason: BlockedReason; message: string; at: string }
  | { type: 'task.updated'; taskId: string; at: string }
  | { type: 'agent.delta'; taskId?: string; threadId?: string; runId: string; text: string }
  | { type: 'agent.tool'; taskId?: string; threadId?: string; runId: string; tool: string; summary: string; allowed: boolean }
  /** A step of an agent run was saved (see AgentStep); the page reloads the run's activity. */
  | { type: 'agent.step'; taskId?: string; threadId?: string; runId: string }
  | { type: 'chat.done'; threadId: string; messageId: string }
  | { type: 'verify.output'; taskId: string; repoId?: string; kind: string; line: string }
  | { type: 'doctor.check'; id: string; status: 'pass' | 'warn' | 'fail' | 'skipped'; message: string };

export type TandemEventType = TandemEvent['type'];
