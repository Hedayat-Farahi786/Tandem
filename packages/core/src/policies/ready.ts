import type { Requirement } from '@tandem/shared';

export interface ReadinessItem {
  id: 'goal' | 'criteria' | 'example-data' | 'affected-areas' | 'out-of-scope' | 'open-questions';
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessResult {
  ready: boolean;
  items: ReadinessItem[];
  missing: ReadinessItem[];
}

const filled = (s: string | undefined) => (s ?? '').trim().length >= 3;

/** Definition of Ready, evaluated in code. The model only fills the fields; it never decides the gate. */
export function checkReadiness(r: Requirement): ReadinessResult {
  const complete = r.criteria.filter((c) => filled(c.given) && filled(c.when) && filled(c.then));
  const items: ReadinessItem[] = [
    { id: 'goal', label: 'Clear goal', ok: filled(r.goal), detail: filled(r.goal) ? r.goal : 'Say what should be true when this is done.' },
    {
      id: 'criteria',
      label: 'At least 2 acceptance criteria (Given/When/Then)',
      ok: complete.length >= 2,
      detail:
        complete.length >= 2
          ? `${complete.length} criteria`
          : `${complete.length} complete ${complete.length === 1 ? 'criterion' : 'criteria'}; add ${2 - complete.length} more with Given, When and Then filled in.`,
    },
    { id: 'example-data', label: 'Example data', ok: filled(r.exampleData), detail: filled(r.exampleData) ? r.exampleData : 'Give a sample input and the expected output.' },
    { id: 'affected-areas', label: 'Affected areas', ok: filled(r.affectedAreas), detail: filled(r.affectedAreas) ? r.affectedAreas : 'Name the screens, endpoints or modules this touches.' },
    { id: 'out-of-scope', label: 'Out of scope', ok: filled(r.outOfScope), detail: filled(r.outOfScope) ? r.outOfScope : 'Say what this change will not do.' },
    {
      id: 'open-questions',
      label: 'No open questions',
      ok: r.openQuestions.filter((q) => q.trim()).length === 0,
      detail: r.openQuestions.length ? r.openQuestions.join(' · ') : 'None',
    },
  ];
  const missing = items.filter((i) => !i.ok);
  return { ready: missing.length === 0, items, missing };
}

/** Plain-text list for a tracker comment or a blocked message. */
export function readinessMessage(result: ReadinessResult): string {
  if (result.ready) return 'Ready: every Definition of Ready item is met.';
  return ['Not ready yet. Missing:', ...result.missing.map((m) => `- ${m.label}: ${m.detail}`)].join('\n');
}
