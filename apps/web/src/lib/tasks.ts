/** How the task list and the sidebar group tasks. */
export const RUNNING = new Set(['READINESS', 'SPEC_DRAFTING', 'BUILDING', 'VERIFYING', 'SELF_REVIEW']);
export const NEEDS_YOU = new Set(['SPEC_REVIEW', 'BLOCKED', 'FAILED', 'DRAFT']);
export type TaskGroup = 'needs-you' | 'active' | 'finished';
export const groupOf = (s: string): TaskGroup => (NEEDS_YOU.has(s) ? 'needs-you' : s === 'DONE' || s === 'CANCELLED' ? 'finished' : 'active');
