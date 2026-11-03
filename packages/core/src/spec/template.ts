import type { Approval, Requirement, Task } from '@tandem/shared';

/** Default spec template, used when the spec repo has no specs/TEMPLATE.md. */
export const DEFAULT_TEMPLATE = `# {{title}}

| Task | Version | Status |
| --- | --- | --- |
| {{key}} | {{version}} | {{status}} |

## Problem and goal

## User story

## Acceptance criteria

Numbered, each as Given / When / Then.

## In scope

## Out of scope

## Affected repos and changes

## API contract

Request and response examples, and at least one error example. Required when more than one repo is affected.

## Data and database changes

Include migrations, or "None".

## UI changes and states

Loading, empty and error states.

## Edge cases and errors

## Security and permissions

## Tests to add

Map each test to a criterion number.

## Rollout notes

## Open questions

Must say "None" before the spec can be approved.

## Approvals
`;

export interface Section {
  heading: string;
  level: number;
  body: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Splits markdown into `##`-level sections (and deeper headings stay inside their section body). */
export function sections(markdown: string): Section[] {
  const out: Section[] = [];
  let cur: Section | undefined;
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m && m[1]!.length === 2) {
      cur = { heading: m[2]!, level: 2, body: '' };
      out.push(cur);
    } else if (cur) {
      cur.body += `${line}\n`;
    }
  }
  return out;
}

export function requiredHeadings(template: string): string[] {
  return sections(template).map((s) => s.heading);
}

function findSection(all: Section[], heading: string): Section | undefined {
  const want = norm(heading);
  return all.find((s) => norm(s.heading) === want) ?? all.find((s) => norm(s.heading).startsWith(want) || want.startsWith(norm(s.heading)));
}

const EMPTYISH = /^\s*(none\.?|n\/a|nothing|-|no open questions\.?|no\.?)\s*$/i;

/** Items in a section that are real content (bullets or paragraphs), ignoring "None" and template hints. */
export function sectionItems(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*([-*+]|\d+[.)])\s+/, '').trim())
    .filter((l) => l && !EMPTYISH.test(l) && !/^_.*_$/.test(l));
}

export interface SpecProblems {
  valid: boolean;
  problems: string[];
  openQuestions: string[];
}

/** Code-level spec validation. The open-questions gate is checked here, not by the model. */
export function validateSpec(markdown: string, opts: { template: string; multiRepo: boolean }): SpecProblems {
  const all = sections(markdown);
  const problems: string[] = [];
  const templateSections = sections(opts.template);
  for (const h of requiredHeadings(opts.template)) {
    if (norm(h) === 'approvals' || norm(h) === 'open questions') continue; // filled by Tandem / may be "None"
    const s = findSection(all, h);
    if (!s) {
      problems.push(`Missing section "${h}".`);
      continue;
    }
    // Empty means no text beyond the template's own hint lines; "None." is a real answer.
    const hints = new Set((findSection(templateSections, h)?.body ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const content = s.body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !hints.has(l));
    if (content.length === 0) problems.push(`Section "${h}" is empty.`);
  }
  const criteria = findSection(all, 'Acceptance criteria');
  if (criteria) {
    const numbered = criteria.body.split(/\r?\n/).filter((l) => /^\s*\d+[.)]\s+/.test(l));
    const gwt = numbered.filter((l) => /given/i.test(l) && /when/i.test(l) && /then/i.test(l));
    if (gwt.length < 2) problems.push('Acceptance criteria need at least 2 numbered Given/When/Then items.');
  }
  if (opts.multiRepo) {
    const api = findSection(all, 'API contract');
    const body = api?.body ?? '';
    const fences = (body.match(/```/g) ?? []).length / 2;
    if (!api || fences < 2 || !/request/i.test(body) || !/response/i.test(body) || !(/\b[45]\d\d\b/.test(body) || /error/i.test(body))) {
      problems.push('More than one repo is affected, so the API contract section needs a request example, a response example and an error example (in code blocks).');
    }
  }
  const oq = findSection(all, 'Open questions');
  const openQuestions = oq ? sectionItems(oq.body).filter((l) => !/must say "none"/i.test(l)) : [];
  return { valid: problems.length === 0, problems, openQuestions };
}

/** Replaces the header table and the Approvals section with Tandem's authoritative values. */
export function finalizeSpec(markdown: string, task: Pick<Task, 'key' | 'title'>, version: number, status: string, approvals: readonly Approval[]): string {
  const header = `| Task | Version | Status |\n| --- | --- | --- |\n| ${task.key} | ${version} | ${status} |`;
  let out = markdown.replace(/\r\n/g, '\n');
  if (/^\|\s*Task\s*\|\s*Version\s*\|\s*Status\s*\|[\s\S]*?\n(?!\|)/m.test(out)) {
    out = out.replace(/^\|\s*Task\s*\|\s*Version\s*\|\s*Status\s*\|.*\n\|.*\n\|.*\n?/m, `${header}\n`);
  } else {
    out = out.replace(/^(# .+\n)/, `$1\n${header}\n`);
  }
  if (!/^# /m.test(out)) out = `# ${task.title}\n\n${header}\n\n${out}`;
  const current = approvals.filter((a) => a.specVersion === version);
  const table = current.length
    ? ['| Role | Name | Spec version | Date | Evidence |', '| --- | --- | --- | --- | --- |', ...current.map((a) => `| ${a.role === 'owner' ? 'Owner (how)' : 'PM (what)'} | ${a.name} | ${a.specVersion} | ${a.date.slice(0, 10)} | ${a.evidence.replace(/\|/g, '\\|') || '-'} |`)].join('\n')
    : '_Not approved yet._';
  out = /^## Approvals\s*$/m.test(out) ? out.replace(/^## Approvals\s*$[\s\S]*?(?=^## |(?![\s\S]))/m, `## Approvals\n\n${table}\n`) : `${out.trimEnd()}\n\n## Approvals\n\n${table}\n`;
  return out;
}

/** The requirement as Markdown, for prompts and the readiness view. */
export function requirementMarkdown(title: string, r: Requirement): string {
  const lines = [`# ${title}`, '', `**Goal:** ${r.goal || '-'}`, '', `**User story:** ${r.userStory || '-'}`, '', '**Acceptance criteria:**'];
  r.criteria.forEach((c, i) => lines.push(`${i + 1}. Given ${c.given}, when ${c.when}, then ${c.then}.`));
  lines.push('', `**Example data:** ${r.exampleData || '-'}`, '', `**Affected areas:** ${r.affectedAreas || '-'}`, '', `**Out of scope:** ${r.outOfScope || '-'}`);
  if (r.openQuestions.length) lines.push('', '**Open questions:**', ...r.openQuestions.map((q) => `- ${q}`));
  return lines.join('\n');
}
