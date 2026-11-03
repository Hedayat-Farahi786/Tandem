import type { CommandResult, Repo, ReviewFinding, Task } from '@tandem/shared';
import { requirementMarkdown } from '../spec/template.js';

const fence = (s: string, lang = '') => `\`\`\`${lang}\n${s.replace(/```/g, '`​``')}\n\`\`\``;

export const READ_ONLY_RULES = [
  'You are working for Tandem in a read-only session.',
  'You can read and search files in the workspace. You cannot change files, run commands or use the network.',
  'Cite code as path:line (for example src/app.ts:12) using paths relative to the workspace.',
].join('\n');

export const BUILD_RULES = [
  'You are the build agent for Tandem.',
  'Edit files only inside the workspace. Run only the repo commands, package installs and read-only commands you are allowed.',
  'Do not commit, rebase, push or change branches: Tandem does that. Do not deploy, call cloud CLIs or run migrations against real databases.',
  'Follow each repo\'s instructions and learned rules below. Keep the change as small as the spec allows.',
].join('\n');

export function extractPrompt(task: Task, repos: readonly Repo[]): string {
  return [
    'Turn this ticket into a structured requirement. Read the code in the workspace to judge size and affected areas, but do not invent requirements the ticket does not state.',
    'Put anything unclear or missing into openQuestions instead of guessing.',
    `Repos in the workspace: ${repos.map((r) => `${r.name} (${r.role})`).join(', ')}. Use these names in affectedRepos and size.perRepo.`,
    'Size: estimate changed lines across all repos (including tests), list independent features (things that could ship separately), and if it is more than one reviewable change, propose a split as smaller tasks with the criterion numbers each would own.',
    `Ticket title: ${task.title}`,
    fence(task.description || requirementMarkdown(task.title, task.requirement), 'markdown'),
  ].join('\n\n');
}

export function sizePrompt(task: Task, repos: readonly Repo[]): string {
  return [
    'Estimate the size of this change by reading the code in the workspace. Do not change anything.',
    `Repos: ${repos.map((r) => `${r.name} (${r.role})`).join(', ')}.`,
    'Return estimatedLines (changed lines across all repos, including tests), perRepo, features (independent features that could ship separately; one entry if it is a single feature), proposedSplit (only if it should be split; each part lists the criterion numbers it would own) and a one-sentence rationale.',
    fence(requirementMarkdown(task.title, task.requirement), 'markdown'),
  ].join('\n\n');
}

export function specPrompt(task: Task, opts: { template: string; repos: readonly Repo[]; feedback?: string; previous?: string; problems?: readonly string[] }): string {
  const multi = opts.repos.length > 1;
  const parts = [
    'Write the implementation spec for this task as Markdown, following the template exactly: every section, in order, with the same headings.',
    'Read the code in the workspace so the spec names real files, endpoints and components. Keep it concise and specific.',
    `Affected repos: ${opts.repos.map((r) => `${r.name} (${r.role}, default branch ${r.defaultBranch})`).join(', ')}.`,
    multi
      ? 'More than one repo is affected, so the "API contract" section is mandatory: give the exact request, the success response and at least one error response, each in its own code block, with status codes.'
      : 'Only one repo is affected; the API contract section can say "None" if no API changes.',
    'Acceptance criteria: keep the numbering from the requirement, one numbered line each as "Given …, when …, then …".',
    'Tests to add: map each test to criterion numbers.',
    'Open questions: write "None" unless something truly blocks implementation. Leave the Approvals section empty: Tandem fills it in.',
    'Reply with the spec Markdown only.',
    '## Requirement',
    requirementMarkdown(task.title, task.requirement),
    '## Template',
    fence(opts.template, 'markdown'),
  ];
  if (opts.previous && opts.feedback) parts.push('## Previous version', fence(opts.previous, 'markdown'), '## Requested changes (apply these)', opts.feedback);
  else if (opts.feedback) parts.push('## Requested changes (apply these)', opts.feedback);
  if (opts.problems?.length) parts.push('## Fix these problems in your previous draft', opts.problems.map((p) => `- ${p}`).join('\n'));
  return parts.join('\n\n');
}

export function buildInstructions(context: string, spec: string): string {
  return [BUILD_RULES, '## Approved spec (the contract you implement)', spec, '## Repo instructions and rules', context || '_None._'].join('\n\n');
}

export function implementPrompt(task: Task, repo: Repo, opts: { order: readonly Repo[]; index: number; criteriaCount: number }): string {
  const first = opts.index === 0;
  const lines = [
    `Implement the approved spec in the \`${repo.name}\` repo (folder ${repo.name}/ in the workspace).`,
    'Some of this work may already exist from an interrupted run: check the files first and continue from there.',
  ];
  if (opts.order.length > 1) {
    lines.push(
      first
        ? `Repos are implemented in contract order: ${opts.order.map((r) => r.name).join(', then ')}. Only change ${repo.name} now.`
        : `${opts.order.slice(0, opts.index).map((r) => r.name).join(' and ')} already implement the API contract. Build ${repo.name} against the contract in the spec, not against guesses. Only change ${repo.name} now.`,
    );
  }
  lines.push(
    `For every acceptance criterion this repo covers (1-${opts.criteriaCount}), add or update at least one automated test, then call the tool tandem_record_test with the criterion number, repo "${repo.name}", the test file path (relative to the repo) and the test name.`,
    `Run the repo's tests (${repo.commands.test ?? 'the test command'}) before you finish and fix what you broke.`,
    'When you are done, reply with a short summary of what you changed.',
  );
  return lines.join('\n');
}

export function coveragePrompt(missing: readonly number[]): string {
  return `These acceptance criteria have no recorded test yet: ${missing.join(', ')}. Add a test for each (or point to an existing one that covers it) and call tandem_record_test for each.`;
}

const tail = (s: string, n = 4_000) => (s.length > n ? `…${s.slice(-n)}` : s);

export function fixPrompt(failures: readonly CommandResult[], attempt: number, max: number, repoNames: Map<string, string>): string {
  return [
    `Verification failed (fix attempt ${attempt} of ${max}). Tandem ran these checks; fix the code so they pass. Do not weaken or skip tests, and do not change the check commands.`,
    ...failures.map((f) => `### ${f.repoId ? repoNames.get(f.repoId) ?? f.repoId : 'project'}: ${f.kind} — \`${f.command}\` (${f.timedOut ? 'timed out' : `exit ${f.exitCode}`})\n\n${fence(tail(f.outputTail))}`),
    'Reply with a short summary of the fixes.',
  ].join('\n\n');
}

export const SECURITY_CHECKLIST = [
  'Secrets: no keys, tokens or passwords in code, config, tests or logs.',
  'Injection: no SQL, shell, path or template injection; inputs are parameterised or escaped.',
  'Auth: every new endpoint or action checks authentication and permissions like its neighbours.',
  'Input validation: new inputs are validated (type, length, range) and errors do not leak internals.',
];

export function reviewPrompt(opts: { spec: string; diff: string; rules: string }): string {
  return [
    'Review this change as a careful senior engineer. Do not change anything.',
    'Check the full diff against: the approved spec, its acceptance criteria (is each one implemented and tested?), the repo rules, and this security checklist:',
    SECURITY_CHECKLIST.map((c) => `- ${c}`).join('\n'),
    'Report only real problems. For each: severity (high, medium, low), category, repo, file, line, a short title and the detail needed to fix it. An empty list is a fine answer.',
    '## Spec',
    opts.spec,
    '## Repo rules',
    opts.rules || '_None._',
    '## Diff',
    fence(tail(opts.diff, 60_000), 'diff'),
  ].join('\n\n');
}

export function reviewFixPrompt(findings: readonly ReviewFinding[]): string {
  return [
    'A separate reviewer found these issues in your change. Fix the ones that are valid. For each finding, call tandem_resolve_finding with its id and status "fixed" or "dismissed" (with a one-line reason if dismissed).',
    ...findings.map((f) => `- id ${f.id} — **${f.severity}** (${f.category}) ${f.title}${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.detail}`),
    'Then run the repo tests again and reply with a short summary.',
  ].join('\n');
}

export function conflictPrompt(repo: Repo, files: readonly string[]): string {
  return [
    `Rebasing ${repo.name} onto the latest ${repo.defaultBranch} hit conflicts in: ${files.join(', ')}.`,
    `Resolve the conflict markers in those files (in ${repo.name}/) so both the upstream change and this task's change are kept, consistent with the spec. Then run \`git add\` on each resolved file.`,
    'Do not run git rebase, commit or push: Tandem continues the rebase. Reply with a short summary.',
  ].join('\n');
}
