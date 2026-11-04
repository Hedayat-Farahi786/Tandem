import { describe, expect, it } from 'vitest';
import type { Approval, CommandResult, CriterionTest, ReviewFinding } from '@tandem/shared';
import { DEFAULT_TEMPLATE, finalizeSpec, requiredHeadings, requirementMarkdown, sectionItems, sections, validateSpec } from '../spec/template.js';
import { buildPrDescription, prTitle } from '../pr/description.js';
import { branchName, changeTitle, cleanTitle, commitMessage, slugify, specFileName } from '../naming.js';
import { VALID_SPEC } from './fixtures.js';

describe('spec template', () => {
  it('has every required section', () => {
    expect(requiredHeadings(DEFAULT_TEMPLATE)).toEqual([
      'Problem and goal',
      'User story',
      'Acceptance criteria',
      'In scope',
      'Out of scope',
      'Affected repos and changes',
      'API contract',
      'Data and database changes',
      'UI changes and states',
      'Edge cases and errors',
      'Security and permissions',
      'Tests to add',
      'Rollout notes',
      'Open questions',
      'Approvals',
    ]);
  });

  it('accepts a complete multi-repo spec', () => {
    const v = validateSpec(VALID_SPEC, { template: DEFAULT_TEMPLATE, multiRepo: true });
    expect(v.problems).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.openQuestions).toEqual([]);
  });

  it('requires the API contract with examples when more than one repo is affected', () => {
    const noContract = VALID_SPEC.replace(/## API contract[\s\S]*?## Data/, '## API contract\n\nNone.\n\n## Data');
    expect(validateSpec(noContract, { template: DEFAULT_TEMPLATE, multiRepo: false }).valid).toBe(true);
    const v = validateSpec(noContract, { template: DEFAULT_TEMPLATE, multiRepo: true });
    expect(v.valid).toBe(false);
    expect(v.problems.join(' ')).toMatch(/API contract/);
  });

  it('reports missing sections, empty sections, weak criteria and open questions', () => {
    const broken = VALID_SPEC.replace('## Edge cases and errors\n\nBackend down: the page shows the error state.\n', '').replace(/## User story\n\n.*\n/, '## User story\n\n')
      .replace(/2\. Given .*\n/, '2. The page shows the status.\n')
      .replace('## Open questions\n\nNone.', '## Open questions\n\n- Which page?');
    const v = validateSpec(broken, { template: DEFAULT_TEMPLATE, multiRepo: false });
    expect(v.problems).toContain('Missing section "Edge cases and errors".');
    expect(v.problems).toContain('Section "User story" is empty.');
    expect(v.problems.join(' ')).toMatch(/at least 2 numbered Given\/When\/Then/);
    expect(v.openQuestions).toEqual(['Which page?']);
  });

  it('uses a custom template from the repo', () => {
    const custom = '# T\n\n## Goal\n\n## Plan\n';
    expect(validateSpec('# T\n\n## Goal\n\nx y z\n\n## Plan\n\nsteps here\n', { template: custom, multiRepo: false }).valid).toBe(true);
    expect(validateSpec('# T\n\n## Goal\n\nx y z\n', { template: custom, multiRepo: false }).problems).toEqual(['Missing section "Plan".']);
  });

  it('ignores headings inside code fences', () => {
    const s = sections('## A\n\n```\n## not a heading\n```\n\n## B\n\nx\n');
    expect(s.map((x) => x.heading)).toEqual(['A', 'B']);
    expect(sectionItems('- None\n- real item\n_hint_\n')).toEqual(['real item']);
  });

  it('writes the header and approvals for the current version only', () => {
    const approvals: Approval[] = [
      { id: 'a1', taskId: 't', specVersion: 1, role: 'owner', name: 'Old', date: '2026-11-01T00:00:00Z', evidence: '', method: 'tandem', createdAt: '' },
      { id: 'a2', taskId: 't', specVersion: 2, role: 'owner', name: 'Hedayat', date: '2026-11-03T10:00:00Z', evidence: 'In Tandem', method: 'tandem', createdAt: '' },
      { id: 'a3', taskId: 't', specVersion: 2, role: 'pm', name: 'Pat', date: '2026-11-03T11:00:00Z', evidence: 'Slack | thread', method: 'tandem', createdAt: '' },
    ];
    const out = finalizeSpec(VALID_SPEC, { key: 'TND-1', title: 'Add a health endpoint' }, 2, 'Approved', approvals);
    expect(out).toContain('| TND-1 | 2 | Approved |');
    expect(out).not.toContain('| TND-1 | 1 | In review |');
    expect(out).toContain('| Owner (how) | Hedayat | 2 | 2026-11-03 | In Tandem |');
    expect(out).toContain('| PM (what) | Pat | 2 | 2026-11-03 | Slack \\| thread |');
    expect(out).not.toContain('Old');
    const none = finalizeSpec('## Problem and goal\n\nx\n', { key: 'TND-2', title: 'T' }, 1, 'In review', []);
    expect(none).toMatch(/^# T\n\n\| Task/);
    expect(none).toContain('_Not approved yet._');
  });

  it('renders a requirement', () => {
    const md = requirementMarkdown('T', { goal: 'g', userStory: '', criteria: [{ given: 'a', when: 'b', then: 'c' }], exampleData: '', affectedAreas: '', outOfScope: '', openQuestions: ['q?'] });
    expect(md).toContain('1. Given a, when b, then c.');
    expect(md).toContain('- q?');
  });
});

describe('PR description', () => {
  const tests: CriterionTest[] = [
    { taskId: 't', criterion: 1, repoId: 'be', file: 'test/health.test.ts', name: 'returns ok', result: 'pass', scope: 'single' },
    { taskId: 't', criterion: 2, repoId: 'be', file: 'test/x.test.ts', name: 'x', result: 'fail', scope: 'suite' },
  ];
  const verification: CommandResult[] = [
    { repoId: 'be', kind: 'test', command: 'npm test', exitCode: 0, timedOut: false, durationMs: 1200, outputTail: '' },
    { repoId: 'be', kind: 'lint', command: 'npm run lint', exitCode: 1, timedOut: false, durationMs: 300, outputTail: '' },
    { kind: 'integration', command: 'npm run e2e', exitCode: null, timedOut: true, durationMs: 900000, outputTail: '' },
  ];
  const findings: ReviewFinding[] = [{ id: 'F1', taskId: 't', severity: 'medium', category: 'security', file: 'src/app.ts', line: 3, title: 'Validate input', detail: 'name is unbounded', status: 'open' }];
  const base = {
    taskKey: 'TND-1',
    title: 'Add a health endpoint',
    summary: 'Adds GET /health.',
    specRef: 'Kept in Tandem with task TND-1',
    specVersion: 2,
    repoName: 'backend',
    criteria: [
      { given: 'a', when: 'b', then: 'c' },
      { given: 'd', when: 'e', then: 'f' },
      { given: 'g', when: 'h', then: 'i' },
    ],
    tests,
    verification,
    openFindings: findings,
    otherPrs: [{ repoName: 'frontend', url: 'https://pr/2' }],
    trackerUrl: 'https://jira/TND-1',
    needsAttention: true,
    attentionNotes: ['backend: lint failed'],
    limit: 10_240,
  };

  it('has every part the PR needs', () => {
    const d = buildPrDescription(base);
    expect(d).toContain('**Needs attention.**');
    expect(d).toContain('## Summary\n\nAdds GET /health.');
    expect(d).toContain('Spec: version 2, approved (Kept in Tandem with task TND-1)');
    expect(d).toContain('- frontend: https://pr/2');
    expect(d).toContain('- Ticket: https://jira/TND-1');
    expect(d).toContain('`test/health.test.ts` › returns ok | ✅ pass');
    expect(d).toContain('(suite) | ❌ fail');
    expect(d).toContain('_no test recorded_ | ⏭️ not run');
    expect(d).toContain('| lint | `npm run lint` | ❌ fail |');
    expect(d).toContain('⏱️ timed out');
    expect(d).toContain('**medium** (security) Validate input — `src/app.ts:3`');
  });

  it('fits the host limit', () => {
    const d = buildPrDescription({ ...base, summary: 'x'.repeat(20_000), limit: 2_000 });
    expect(d.length).toBeLessThanOrEqual(2_000);
    expect(d).toContain('Trimmed to fit the 2000-character limit');
    expect(d).toContain('The full spec and details are in Tandem (task TND-1)');
    const clean = buildPrDescription({ ...base, openFindings: [], needsAttention: false, attentionNotes: [], otherPrs: [], verification: [], criteria: [] });
    expect(clean).toContain('## Open review findings\n\nNone.');
    expect(clean).not.toContain('Needs attention');
  });

  it('titles', () => {
    // Just the short name: no task key, no status (that's in the description), no trailing dot.
    expect(prTitle('Health  endpoint ')).toBe('Health endpoint');
    expect(prTitle('[needs attention] O4M-1: Enable Save only for changed arrows.')).toBe('Enable Save only for changed arrows');
    expect(prTitle('add a beta badge')).toBe('Add a beta badge');
    const long = prTitle('Enable Save only when the arrows in the microstructure drawing tool differ from their initial or last-saved state and');
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long).toBe('Enable Save only when the arrows in the microstructure drawing tool');
  });
});

describe('naming', () => {
  it('slugs and branches', () => {
    expect(slugify('Add a GET /health endpoint & show it!')).toBe('add-a-get-health-endpoint-show-it');
    expect(slugify('Ünïcödé café')).toBe('unicode-cafe');
    expect(slugify('!!!')).toBe('task');
    expect(slugify('a'.repeat(60)).length).toBeLessThanOrEqual(40);
    expect(slugify('implement the very long feature name that goes on and on')).toBe('implement-the-very-long-feature-name');
    expect(branchName('TND-7', 'health')).toBe('feature/TND-7-health');
    expect(specFileName('TND-7', 'health')).toBe('specs/TND-7-health.md');
  });
});

describe('commit titles', () => {
  it('reads like a person wrote it: no task key, no prefixes, no period', () => {
    expect(cleanTitle('SHOP-12: Bump version to 1.7.13.')).toBe('Bump version to 1.7.13');
    expect(cleanTitle('feat(TND-1): add health endpoint')).toBe('Add health endpoint');
    expect(cleanTitle('[WIP] "fix flaky save button"')).toBe('Fix flaky save button');
    expect(cleanTitle('  ')).toBeUndefined();
  });
  it("uses Copilot's name for the change, else the task title in sentence case", () => {
    expect(changeTitle({ title: 'Update Frontend Application Version', progress: { commitTitle: 'Bump version to 1.7.13' } })).toBe('Bump version to 1.7.13');
    expect(changeTitle({ title: 'Update Frontend Application Version', progress: {} })).toBe('Update frontend application version');
    expect(changeTitle({ title: 'Add a GET /health endpoint', progress: {} })).toBe('Add a GET /health endpoint');
  });
  it('wraps the body under the title and keeps lists', () => {
    expect(commitMessage('Bump version to 1.7.13')).toBe('Bump version to 1.7.13');
    expect(commitMessage('Bump version to 1.7.13', '- package.json and the lockfile\n- a test for each environment')).toBe('Bump version to 1.7.13\n\n- package.json and the lockfile\n- a test for each environment');
    const long = commitMessage('Add undo', 'word '.repeat(40));
    expect(long.split('\n').slice(2).every((l) => l.length <= 72)).toBe(true);
  });
});
