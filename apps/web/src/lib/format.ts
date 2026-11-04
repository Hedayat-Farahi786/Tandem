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

/** What a step is, in words people use. */
const STEP_WORDS: Record<string, string> = {
  'check-ready': 'Checking the request',
  'check-size': 'Sizing the request',
  'refresh-refs': 'Reading the latest code',
  draft: 'Drafting the spec',
  'await-pm': 'Waiting for approval',
  'prepare-workspace': 'Preparing the workspace',
  implement: 'Building',
  commit: 'Committing',
  verify: 'Running the checks',
  review: 'Self-review',
  sync: 'Updating the branch',
  push: 'Pushing the branch',
  'open-prs': 'Opening the pull requests',
  report: 'Reporting',
  poll: 'Checking the pull requests',
  cleanup: 'Cleaning up',
};

/** An expired AWS or SSO session, in the host's words. */
export const SIGNIN_EXPIRED = /session has expired|reauthenticate|ExpiredToken|security token (included in the request )?is expired|sso session/i;

/** "PR_OPEN / poll failed: X" reads as "Checking the pull requests failed: X". */
export const plainReason = (text: string) =>
  SIGNIN_EXPIRED.test(text)
    ? "Your AWS sign-in expired, so Tandem couldn't reach the repository host. Connect AWS again in Settings › AWS, then choose Retry."
    : text.replace(/^[A-Z_]+ \/ ([a-z-]+) failed: /, (_m, step: string) => `${STEP_WORDS[step] ?? stepLabel(step)} failed: `);

/** A reason short enough for a list row: one plain sentence. */
export const shortReason = (text: string) => {
  const line = text.split('\n')[0]!;
  if (SIGNIN_EXPIRED.test(line)) return 'AWS sign-in expired';
  const plain = plainReason(line);
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.replace(/\.$/, '');
};
