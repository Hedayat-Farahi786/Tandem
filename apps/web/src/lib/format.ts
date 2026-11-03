import { STATE_LABELS, type TaskState } from '@tandem/shared';

export const STATE_LABEL: Record<TaskState, string> = STATE_LABELS;

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';
export const STATE_TONE: Record<TaskState, Tone> = {
  DRAFT: 'neutral',
  READINESS: 'accent',
  SPEC_DRAFTING: 'accent',
  SPEC_REVIEW: 'warn',
  BUILDING: 'accent',
  VERIFYING: 'accent',
  SELF_REVIEW: 'accent',
  PR_OPEN: 'ok',
  DONE: 'ok',
  BLOCKED: 'warn',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

export const stepLabel = (step?: string) => (step ? step.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
