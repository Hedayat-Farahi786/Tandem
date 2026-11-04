import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RetryableError } from '../ports.js';
import { BudgetError } from '../budget.js';
import { GOOD_REQUIREMENT, SINGLE_SPEC, harness, repoFromPrompt } from './harness.js';

const states = async (h: ReturnType<typeof harness>, id: string) => (await h.store.transitions.list(id)).map((t) => t.to);

describe('workflow: one full-stack repo', () => {
  it('goes from request to merged PR and cleans up', async () => {
    const h = harness();
    let t = await h.start();
    expect(t.state).toBe('SPEC_REVIEW');
    const spec = await h.store.specs.latest(t.id);
    expect(spec?.version).toBe(1);
    expect(spec?.markdown).toContain('| TND-1 | 1 | In review |');

    t = await h.approveAll(t.id);
    expect(t.state).toBe('PR_OPEN');
    expect(t.step).toBe('poll');
    expect(await states(h, t.id)).toEqual(['DRAFT', 'READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN']);

    // Build happened in the task folder, commits by Tandem. The spec stays in Tandem, not in the repo.
    const wt = join(h.deps.paths.taskDir(t.id), 'app');
    expect(readFileSync(join(wt, 'src/health.ts'), 'utf8')).toContain("status: 'ok'");
    expect(existsSync(join(wt, 'specs'))).toBe(false);
    expect((await h.store.specs.latest(t.id))!.markdown).toContain('| TND-1 | 1 |');
    expect((await h.store.approvals.list(t.id)).map((a) => a.role).sort()).toEqual(['owner', 'pm']);
    expect(h.host.opened[0]!.description).toContain('Spec: version 1, approved (Kept in Tandem with task TND-1)');
    expect(h.git.commits.map((c) => c.message)).toEqual(['TND-1: Add a GET /health endpoint']);
    // Pushed as one commit, written like a person's: the key, the change, then why.
    expect(h.git.squashes).toHaveLength(1);
    expect(h.git.squashes[0]!.message).toMatch(/^TND-1: Add a GET \/health endpoint\n\n\S/);

    // Verify ran every repo command, deterministic and by Tandem.
    expect(h.process.calls.map((c) => c.command)).toEqual(['npm ci', 'npm run lint', 'npm run typecheck', 'npm run build', 'npm test']);
    const tests = await h.store.criterionTests.list(t.id);
    expect(tests.map((x) => [x.criterion, x.result, x.scope])).toEqual([
      [1, 'pass', 'suite'],
      [2, 'pass', 'suite'],
    ]);

    // One PR, with the criterion table; pushed to the agent branch; report posted.
    expect(h.host.pushes).toEqual([{ repoId: 'r-app' }]);
    expect(h.host.opened).toHaveLength(1);
    expect(h.host.opened[0]!.sourceBranch).toBe('feature/TND-1-add-a-get-health-endpoint');
    expect(h.host.opened[0]!.idempotencyKey).toBe(`${t.id}:r-app`);
    expect(h.host.opened[0]!.description).toContain('| Criterion | Test | Result |');
    expect(h.tracker.comments.at(-1)!.body).toMatch(/Pull requests for TND-1 are ready/);

    // Agent sessions: read-only for spec and review, build for implement; light vs build tiers.
    const kinds = h.agent.calls.map((c) => `${c.opts.mode}/${c.opts.tier}`);
    expect(kinds).toEqual(['read-only/light', 'read-only/light', 'build/build', 'read-only/light']);
    expect(h.agent.calls[2]!.opts.allowedCommands).toEqual(['npm ci', 'npm run lint', 'npm run typecheck', 'npm run build', 'npm test']);

    // Still waiting for merge; the poller keeps polling.
    h.clock.advance(5 * 60_000);
    await h.runner.runUntilIdle();
    expect((await h.get(t.id)).state).toBe('PR_OPEN');

    // Merged -> DONE -> worktrees removed.
    const pr = (await h.store.prs.list(t.id))[0]!;
    await h.store.prs.upsert({ ...pr, status: 'open' });
    (h.host as unknown as { script: { prStatus: () => string } }).script.prStatus = () => 'merged';
    h.clock.advance(5 * 60_000);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.state).toBe('DONE');
    expect(t.progress.cleanedUp).toBe(true);
    expect(h.git.removed).toEqual([wt]);
    expect(existsSync(h.deps.paths.taskDir(t.id))).toBe(false);
    expect(await h.store.jobs.get(t.id)).toBeUndefined();

    // Usage was metered per prompt.
    expect(await h.store.usage.prompts({ taskId: t.id })).toBe(4);
  });
});

describe('workflow: separate frontend and backend repos', () => {
  it('implements backend first, then frontend, and cross-links two PRs', async () => {
    const h = harness({ shape: 'split' });
    let t = await h.start();
    expect(t.state).toBe('SPEC_REVIEW');
    expect(h.agent.calls.find((c) => c.prompt.startsWith('Write the implementation spec'))!.prompt).toContain('the "API contract" section is mandatory');
    t = await h.approveAll(t.id);
    expect(t.state).toBe('PR_OPEN');
    const impl = h.agent.calls.filter((c) => c.prompt.startsWith('Implement'));
    expect(impl.map((c) => repoFromPrompt(c.prompt))).toEqual(['backend', 'frontend']);
    expect(impl[1]!.prompt).toContain('backend already implement the API contract');
    expect(impl[0]!.opts.workspace).toBe(h.deps.paths.taskDir(t.id));
    const prs = await h.store.prs.list(t.id);
    expect(prs).toHaveLength(2);
    expect(h.host.updatedDescriptions).toHaveLength(2);
    expect(h.host.updatedDescriptions[0]!.description).toMatch(/- frontend: https:\/\/pr\.example\/frontend\/2|- backend: https:\/\/pr\.example\/backend\/1/);
    expect(existsSync(join(h.deps.paths.taskDir(t.id), 'backend', 'specs'))).toBe(false);
    expect((await h.store.specs.latest(t.id))!.markdown).toContain('## API contract');
    expect(h.git.commits.map((c) => c.worktree.split('/').pop())).toEqual(['backend', 'frontend']);
  });

  it('blocks a multi-repo spec without an API contract after one redraft', async () => {
    const noContract = SINGLE_SPEC.replace(/## API contract[\s\S]*?## Data/, '## API contract\n\nNone.\n\n## Data');
    const h = harness({ shape: 'split', script: { spec: () => ({ text: noContract }) } });
    const t = await h.start();
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('spec-invalid');
    const drafts = h.agent.calls.filter((c) => c.prompt.startsWith('Write the implementation spec'));
    expect(drafts).toHaveLength(2);
    expect(drafts[1]!.prompt).toContain('Fix these problems');
    // The owner fixes it by editing the spec, which moves it back to review.
    const r = await h.service.editSpec(t.id, SINGLE_SPEC);
    expect(r.problems).toEqual([]);
    expect((await h.get(t.id)).state).toBe('SPEC_REVIEW');
  });
});

describe('workflow: readiness and size', () => {
  it('blocks until the Definition of Ready is met, then continues', async () => {
    const h = harness();
    let t = await h.start({ ...GOOD_REQUIREMENT, exampleData: '', criteria: [GOOD_REQUIREMENT.criteria[0]!] });
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('readiness-missing');
    expect(t.blockedMessage).toContain('Example data');
    expect(h.tracker.comments[0]!.body).toContain('Missing:');
    expect(h.agent.calls).toHaveLength(0); // the gate is code: no model call
    await h.service.update(t.id, { requirement: GOOD_REQUIREMENT });
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.state).toBe('SPEC_REVIEW');
  });

  it('extracts a structured requirement from free text (Jira-style)', async () => {
    const h = harness();
    await h.ready;
    const t0 = await h.service.create({ projectId: 'p1', title: 'Health', description: 'Please add a health endpoint and show it.', source: 'jira', externalKey: 'SHOP-42' });
    expect(t0.key).toBe('SHOP-42');
    await h.service.submit(t0.id);
    await h.runner.runUntilIdle();
    const t = await h.get(t0.id);
    expect(t.requirement.criteria).toHaveLength(2);
    expect(t.sizeEstimate?.estimatedLines).toBe(60);
    expect(t.state).toBe('SPEC_REVIEW');
    expect(h.agent.calls.filter((c) => c.prompt.startsWith('Estimate the size'))).toHaveLength(0); // size came with extraction
  });

  it('proposes a split for a big task; accepting it creates smaller tasks', async () => {
    const h = harness({
      script: {
        size: () => ({ value: { estimatedLines: 900, perRepo: [], features: ['health endpoint', 'status page'], proposedSplit: [{ title: 'Health endpoint', criteria: [1] }, { title: 'Status on main page', criteria: [2] }], rationale: 'two features' } }),
      },
    });
    const t = await h.start();
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('split-proposed');
    expect(t.blockedMessage).toContain('1. Health endpoint (criteria 1)');
    await expect(h.service.resume(t.id)).rejects.toThrow(/Accept the proposed split or override/);
    const children = await h.service.acceptSplit(t.id);
    expect(children.map((c) => [c.key, c.title, c.requirement.criteria.length, c.parentTaskId])).toEqual([
      ['TND-2', 'Health endpoint', 1, t.id],
      ['TND-3', 'Status on main page', 1, t.id],
    ]);
    expect((await h.get(t.id)).state).toBe('CANCELLED');
    await h.runner.runUntilIdle();
    // Children skip the size check (the owner already decided) but still pass readiness: 1 criterion is not enough.
    expect((await h.get(children[0]!.id)).blockedReason).toBe('readiness-missing');
  });

  it('lets the owner override the size check with a reason', async () => {
    const h = harness({ script: { size: () => ({ value: { estimatedLines: 900, perRepo: [], features: ['one'], proposedSplit: [], rationale: '' } }) } });
    const t = await h.start();
    await expect(h.service.overrideSplit(t.id, ' ')).rejects.toThrow(/Say why/);
    await expect(h.service.acceptSplit(t.id)).rejects.toThrow(/fewer than two parts/);
    await h.service.overrideSplit(t.id, 'Mostly generated code');
    await h.runner.runUntilIdle();
    const after = await h.get(t.id);
    expect(after.state).toBe('SPEC_REVIEW');
    expect(after.sizeOverride).toBe('Mostly generated code');
  });
});

describe('workflow: spec review', () => {
  it('requests changes and redrafts with the feedback', async () => {
    const h = harness();
    const t = await h.start();
    await expect(h.service.requestChanges(t.id, '')).rejects.toThrow(/Say what should change/);
    await h.service.requestChanges(t.id, 'Also return the version number.');
    await h.runner.runUntilIdle();
    const specs = await h.store.specs.list(t.id);
    expect(specs.map((s) => [s.version, s.source, s.feedback])).toEqual([
      [1, 'draft', undefined],
      [2, 'redraft', 'Also return the version number.'],
    ]);
    const redraft = h.agent.calls.at(-1)!.prompt;
    expect(redraft).toContain('Requested changes (apply these)');
    expect(redraft).toContain('Also return the version number.');
    expect(redraft).toContain('## Previous version');
    expect((await h.get(t.id)).specFeedback).toBe('');
  });

  it('resets approvals when the spec is edited', async () => {
    const h = harness();
    const t = await h.start();
    await h.service.approve(t.id, 'Owner');
    expect((await h.get(t.id)).state).toBe('SPEC_REVIEW'); // PM key still missing
    const r = await h.service.editSpec(t.id, SINGLE_SPEC.replace('No flags needed.', 'Behind a flag.'));
    expect(r.version).toBe(2);
    await h.service.recordPmApproval(t.id, { name: 'Pat', date: h.clock.iso(), evidence: 'https://chat/msg/1' });
    expect((await h.get(t.id)).state).toBe('SPEC_REVIEW'); // the owner's v1 approval no longer counts
    await h.service.approve(t.id, 'Owner');
    expect((await h.get(t.id)).state).toBe('BUILDING');
    const approvals = await h.store.approvals.list(t.id);
    expect(approvals.map((a) => [a.role, a.specVersion])).toEqual([
      ['owner', 1],
      ['pm', 2],
      ['owner', 2],
    ]);
  });

  it('refuses approval while open questions remain, and checks PM evidence', async () => {
    const h = harness({ script: { spec: () => ({ text: SINGLE_SPEC.replace('## Open questions\n\nNone.', '## Open questions\n\n- Which page shows it?') }) } });
    const t = await h.start();
    await expect(h.service.approve(t.id, 'Owner')).rejects.toThrow(/Answer the open questions.*Which page shows it/);
    await expect(h.service.recordPmApproval(t.id, { name: 'Pat', date: h.clock.iso(), evidence: '' })).rejects.toThrow(/Add a note or a link/);
    await expect(h.service.approve(t.id, ' ')).rejects.toThrow(/name/);
  });

  it('needs only the owner when the PM gate is off', async () => {
    const h = harness({ pmGate: 'off' });
    const t = await h.start();
    await expect(h.service.recordPmApproval(t.id, { name: 'Pat', date: '', evidence: 'x' })).rejects.toThrow(/no PM approval step/);
    await h.service.approve(t.id, 'Owner');
    expect((await h.get(t.id)).state).toBe('BUILDING');
  });

  it('imports Jira issues by key or by query: the project query wins, else the ready query from Settings', async () => {
    const h = harness();
    await h.ready;
    h.tracker.kind = 'jira';
    h.tracker.tasks.set('SHOP-1', { key: 'SHOP-1', title: 'Health', description: 'Add a health endpoint.', status: 'Ready for AI' });
    h.tracker.tasks.set('SHOP-2', { key: 'SHOP-2', title: 'Version', description: 'Add a version endpoint.', status: 'To do' });
    const project = (await h.store.projects.get('p1'))!;
    const s = await h.store.settings.get();
    await h.store.settings.set({ ...s, jira: { ...s.jira, readyJql: 'labels = ai-ready' } });
    expect((await h.service.importFromTracker(project)).map((t) => t.externalKey)).toEqual(['SHOP-1']);
    expect(h.tracker.queries.at(-1)).toBe('labels = ai-ready');
    await h.service.importFromTracker({ ...project, jiraJql: 'project = SHOP' });
    expect(h.tracker.queries.at(-1)).toBe('project = SHOP');
    // By key, whatever its status; an issue already imported is skipped.
    expect((await h.service.importFromTracker(project, ['SHOP-2', 'SHOP-1'])).map((t) => t.externalKey)).toEqual(['SHOP-2']);
  });

  it('takes PM approval from Jira replies by configured PMs only', async () => {
    const h = harness({ pmGate: 'jira' });
    let t = await h.start();
    expect(t.pmRequestedAt).toBeDefined();
    expect(h.tracker.comments.at(-1)!.body).toContain('Reply "approve"');
    await expect(h.service.recordPmApproval(t.id, { name: 'x', date: '', evidence: 'y' })).rejects.toThrow(/from Jira replies/);
    await h.service.approve(t.id, 'Owner');
    h.clock.advance(1_000);
    h.tracker.reply(t.key, 'someone-else', 'approve');
    h.clock.advance(5 * 60_000);
    await h.runner.runUntilIdle();
    expect((await h.get(t.id)).state).toBe('SPEC_REVIEW');
    h.tracker.reply(t.key, 'pm-1', 'Approve, looks good');
    h.clock.advance(5 * 60_000);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(['BUILDING', 'PR_OPEN']).toContain(t.state);
    const pm = (await h.store.approvals.list(t.id)).find((a) => a.role === 'pm');
    expect(pm).toMatchObject({ method: 'jira', name: 'pm-1', specVersion: 1 });
  });

  it('redrafts when the PM asks for changes in Jira', async () => {
    const h = harness({ pmGate: 'jira' });
    const t = await h.start();
    h.clock.advance(1_000);
    h.tracker.reply(t.key, 'pm-1', 'changes: show the version too');
    h.clock.advance(5 * 60_000);
    await h.runner.runUntilIdle();
    expect((await h.store.specs.list(t.id)).map((s) => s.feedback)).toEqual([undefined, 'show the version too']);
  });
});

describe('workflow: verification and review', () => {
  it('gives the agent two fix attempts, then continues with "needs attention"', async () => {
    const h = harness({ process: { 'npm test': { exitCode: 1, stdout: 'FAIL test/health.test.ts\nexpected 200, got 404' } } });
    let t = await h.start();
    t = await h.approveAll(t.id);
    expect(t.state).toBe('PR_OPEN');
    expect(t.needsAttention).toBe(true);
    expect(t.attentionNotes).toEqual(['app: test failed (`npm test`, exit 1)']);
    const fixes = h.agent.calls.filter((c) => c.prompt.startsWith('Verification failed'));
    expect(fixes).toHaveLength(2);
    expect((await h.store.runs.listFor({ taskId: t.id })).map((r) => r.kind)).toEqual(['size', 'spec', 'build', 'fix', 'fix', 'review']);
    expect(fixes[0]!.prompt).toContain('expected 200, got 404');
    expect(fixes[1]!.prompt).toContain('fix attempt 2 of 2');
    expect(fixes[0]!.opts.resumeId).toBe(t.progress.buildSessionId); // the build session is resumed, not restarted
    expect(fixes[0]!.opts.resumeId).toBe(h.agent.calls.find((c) => c.prompt.startsWith('Implement'))!.opts.resumeId ?? 'scripted-3');
    expect(h.git.commits.map((c) => c.message)).toEqual(['TND-1: Add a GET /health endpoint', 'Fix failing checks', 'Fix failing checks']);
    expect(h.host.opened[0]!.title).toBe('Add a GET /health endpoint');
    expect(h.host.opened[0]!.description).toContain('**Needs attention.**');
    expect((await h.store.verifyRuns.list(t.id)).map((v) => v.passed)).toEqual([false, false, false]);
  });

  it('passes after one successful fix', async () => {
    const h = harness({ process: { 'npm test': (n) => (n === 1 ? { exitCode: 1 } : { exitCode: 0 }) } });
    const t = await h.approveAll((await h.start()).id);
    expect(t.needsAttention).toBe(false);
    expect((await h.store.transitions.list(t.id)).find((x) => x.to === 'SELF_REVIEW')?.reason).toBe('All checks pass after 1 fix attempt.');
  });

  it('runs single tests per criterion and the integration command', async () => {
    const h = harness({ integrationCommand: 'npm run e2e' });
    await h.ready;
    await h.store.repos.upsert({ ...h.repos[0]!, commands: { ...h.repos[0]!.commands, testSingle: 'npx vitest run {file} -t {name}' } });
    const t = await h.approveAll((await h.start()).id);
    const cmds = h.process.calls.map((c) => c.command);
    expect(cmds).toContain('npx vitest run "test/health-1.test.ts" -t "criterion 1"');
    expect(cmds.at(-1)).toBe('npm run e2e');
    expect((await h.store.criterionTests.list(t.id)).every((x) => x.scope === 'single' && x.result === 'pass')).toBe(true);
  });

  it('flags criteria with no recorded test after one follow-up', async () => {
    const h = harness({ script: { implement: () => ({ text: 'done', edits: [{ path: 'app/x.ts', content: 'x' }], tools: [{ name: 'tandem_record_test', args: { criterion: 1, repo: 'app', file: 'test/a.test.ts', name: 'a' } }] }) } });
    const t = await h.approveAll((await h.start()).id);
    expect(h.agent.calls.some((c) => c.prompt.startsWith('These acceptance criteria have no recorded test yet: 2'))).toBe(true);
    expect(t.attentionNotes).toContain('No test recorded for acceptance criteria 2.');
  });

  it('fixes self-review findings once and lists what is left in the PR', async () => {
    const h = harness({
      script: {
        review: () => ({
          value: {
            findings: [
              { severity: 'high', category: 'security', repo: 'app', file: 'src/app.ts', line: 3, title: 'Unvalidated input', detail: 'Validate name length.' },
              { severity: 'low', category: 'rules', title: 'Naming', detail: 'Use camelCase.' },
            ],
          },
        }),
        reviewFix: () => ({ text: 'fixed one', tools: [{ name: 'tandem_resolve_finding', args: { id: 'TND-1-F1', status: 'fixed', note: '' } }] }),
      },
    });
    const t = await h.approveAll((await h.start()).id);
    const findings = await h.store.findings.list(t.id);
    expect(findings.map((f) => [f.id, f.status])).toEqual([
      ['TND-1-F1', 'fixed'],
      ['TND-1-F2', 'open'],
    ]);
    expect(h.git.commits.at(-1)!.message).toBe('Address review findings');
    expect(h.host.opened[0]!.description).toContain('Naming');
    expect(h.host.opened[0]!.description).not.toContain('Unvalidated input');
    expect(h.agent.calls.filter((c) => c.prompt.startsWith('Review this change'))).toHaveLength(1);
  });
});

describe('workflow: sync and push', () => {
  it('lets the agent resolve a rebase conflict, re-verifies and continues', async () => {
    const h = harness({ host: { rebase: (_r, n) => (n === 1 ? { kind: 'conflict', files: ['README.md'] } : { kind: 'ok', head: 'h' }) } });
    h.overrides.conflict = () => {
      h.git.conflicts = [];
      return { text: 'resolved' };
    };
    const t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('PR_OPEN');
    expect(h.agent.calls.find((c) => c.prompt.startsWith('Rebasing'))?.prompt).toContain('README.md');
    expect((await h.store.runs.listFor({ taskId: t.id })).filter((r) => r.kind === 'conflict').map((r) => r.status)).toEqual(['succeeded']);
  });

  it('blocks when the conflict can not be resolved, and aborts the rebase', async () => {
    const h = harness({ host: { rebase: () => ({ kind: 'conflict', files: ['src/app.ts'] }) } });
    h.overrides.conflict = () => {
      h.git.conflicts = ['src/app.ts'];
      return { text: 'could not' };
    };
    const t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('rebase-conflict');
    expect(t.blockedMessage).toContain('could not resolve src/app.ts');
    expect(t.resumeTo).toEqual({ state: 'SELF_REVIEW', step: 'sync' });
    expect(h.git.conflicts).toEqual([]); // aborted
  });

  it('blocks when the resolved rebase fails checks', async () => {
    const h = harness({
      host: { rebase: () => ({ kind: 'conflict', files: ['a.ts'] }) },
      process: { 'npm test': (n) => (n <= 1 ? { exitCode: 0 } : { exitCode: 1 }) },
    });
    h.overrides.conflict = () => ({ text: 'resolved' });
    const t = await h.approveAll((await h.start()).id);
    expect(t.blockedReason).toBe('rebase-conflict');
    expect(t.blockedMessage).toContain('checks fail afterwards');
  });

  it('blocks on a rejected push and re-pushes with a lease after retry', async () => {
    const h = harness({ host: { push: (_r, n) => (n === 1 ? { kind: 'pushed', sha: 'abc' } : n === 2 ? { kind: 'rejected', message: 'stale info' } : { kind: 'pushed', sha: 'def' }) } });
    let t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('PR_OPEN');
    // Simulate a second push round (for example after a retry from sync).
    await h.store.tasks.upsert({ ...t, state: 'BLOCKED', blockedReason: 'push-rejected', resumeTo: { state: 'SELF_REVIEW', step: 'push' } });
    await h.store.jobs.delete(t.id);
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.blockedReason).toBe('push-rejected');
    expect(h.host.pushes.at(-1)).toEqual({ repoId: 'r-app', forceWithLease: 'abc' });
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    expect((await h.get(t.id)).progress.pushed).toEqual({ 'r-app': 'def' });
  });
});

describe('workflow: PRs', () => {
  it('falls back to a manual link, then follows the pasted PR until merged', async () => {
    const h = harness({ host: { openPr: () => ({ kind: 'manual', url: 'https://console/new-pr', reason: 'no permission' }) } });
    const t = await h.approveAll((await h.start()).id);
    const pr = (await h.store.prs.list(t.id))[0]!;
    expect(pr).toMatchObject({ status: 'manual-pending', manual: true, url: 'https://console/new-pr' });
    expect(pr.description).toContain('## Acceptance criteria');
    await expect(h.service.setManualPrUrl(pr.id, 'nope')).rejects.toThrow(/full https/);
    const updated = await h.service.setManualPrUrl(pr.id, 'https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/app/pull-requests/17/details');
    expect(updated).toMatchObject({ providerId: '17', status: 'open' });
    await h.service.markMerged(pr.id);
    await h.runner.runUntilIdle();
    expect((await h.get(t.id)).state).toBe('DONE');
  });

  it('notes a PR closed without merging', async () => {
    const h = harness({ host: { prStatus: () => 'closed' } });
    const t = await h.approveAll((await h.start()).id);
    expect(t.attentionNotes.some((n) => n.startsWith('A pull request was closed without merging'))).toBe(true);
    expect(t.state).toBe('PR_OPEN');
  });
});

const karma = (failed: number, names: string[]) =>
  [
    '\x1b[32m✔ Browser application bundle generation complete.\x1b[39m',
    ...Array.from({ length: 30 }, (_, i) => `\x1b[1A\x1b[2KChrome Headless 153.0.0.0 (Linux 0.0.0): Executed ${i + 1} of 68 (${Math.min(i, failed)} FAILED) (0 secs / 1.2 secs)`),
    ...names.map((n) => `Chrome Headless 153.0.0.0 (Linux 0.0.0) ${n} FAILED\n\tNullInjectorError: No provider for MsalService!`),
    `TOTAL: ${failed} FAILED, ${68 - failed} SUCCESS`,
  ].join('\n');

describe('workflow: knowing where the repo starts', () => {
  const base = ['AuthGuard redirects to login', 'AppComponent should create'];
  it('tests that already fail on the base branch are not the task\'s: no fix rounds, no "needs attention"', async () => {
    const h = harness({ process: { 'npm test': () => ({ exitCode: 1, stdout: karma(2, base) }) } });
    h.git.remote.set('r-app:main', 'base-1');
    const t = await h.approveAll((await h.start()).id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: false, attentionNotes: [] });
    expect(h.agent.calls.filter((c) => c.prompt.startsWith('Verification failed'))).toHaveLength(0);
    const test = (await h.store.verifyRuns.list(t.id))[0]!.results.find((r) => r.kind === 'test')!;
    expect(test.preexisting).toEqual({ base: 'main', failures: 2 });
    expect(test.outputTail).toContain('Also fails on main before this change (2 failing there)');
    expect(test.outputTail).not.toContain('\x1b['); // no colour codes
    expect(test.outputTail.match(/Executed \d+ of 68/g)).toHaveLength(1); // one progress line, not 30
    expect(h.host.opened[0]!.description).toContain('fails on main too (2), not this change');
    // The base branch was checked once, in its own copy, then cached.
    expect(h.process.calls.filter((c) => c.command === 'npm test' && c.cwd.includes('.baseline'))).toHaveLength(1);
  });

  it('a failure the change added gets a fix round that names just the new failures', async () => {
    const h = harness({ process: { 'npm test': (n, cwd) => (cwd.includes('.baseline') ? { exitCode: 1, stdout: karma(2, base) } : n <= 2 ? { exitCode: 1, stdout: karma(3, [...base, 'Details saves only changed arrows']) } : { exitCode: 1, stdout: karma(2, base) }) } });
    h.git.remote.set('r-app:main', 'base-1');
    const t = await h.approveAll((await h.start()).id);
    const fixes = h.agent.calls.filter((c) => c.prompt.startsWith('Verification failed'));
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.prompt).toContain('New failures (they pass on main): Details saves only changed arrows');
    expect(fixes[0]!.prompt).toContain('are not this change\'s: leave them');
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: false });
  });
});

describe('workflow: checks the owner skips', () => {
  it('skips a failing check on an open PR: checked again without it, no new Copilot run, and the PR says so', async () => {
    const h = harness({ process: { 'npm test': { exitCode: 1, stdout: 'No binary for Chrome browser on your platform.' } } });
    let t = await h.approveAll((await h.start()).id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: true });
    const runs = (await h.store.runs.listFor({ taskId: t.id })).length;
    const r = await h.service.continueWith(t.id, 'Chrome is not installed here, so the browser tests cannot start.', { skip: [{ repoId: 'r-app', kind: 'test' }] });
    expect(r.action).toBe('rechecking');
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: false, skippedChecks: [{ repoId: 'r-app', kind: 'test', reason: 'Chrome is not installed here, so the browser tests cannot start.' }] });
    expect((await h.store.runs.listFor({ taskId: t.id })).length).toBe(runs); // no new Copilot run
    const last = (await h.store.verifyRuns.list(t.id)).at(-1)!;
    expect(last.passed).toBe(true);
    expect(last.results.find((x) => x.kind === 'test')).toMatchObject({ skipped: true, outputTail: expect.stringContaining('Chrome is not installed') });
    expect(h.host.updatedDescriptions.at(-1)!.description).toContain('skipped by the owner');
    expect((await h.store.audit.list({ taskId: t.id })).some((e) => e.action === 'checks.skipped')).toBe(true);
  });

  it('skipping a check on a failed task clears the notes about it', async () => {
    const h = harness({ process: { 'npm test': { exitCode: 1 } } });
    const t = await h.approveAll((await h.start()).id);
    expect(t.attentionNotes).toEqual(['app: test failed (`npm test`, exit 1)']);
    await h.store.tasks.upsert({ ...t, state: 'FAILED', resumeTo: { state: 'PR_OPEN', step: 'open-prs' } });
    const r = await h.service.continueWith(t.id, 'No Chrome here.', { skip: [{ repoId: 'r-app', kind: 'test' }] });
    expect(r.action).toBe('resumed');
    expect(await h.get(t.id)).toMatchObject({ needsAttention: false, attentionNotes: [] });
  });

  it('skipping a check that hangs stops it at once, and the task goes on without it', async () => {
    const h = harness({ process: { 'npm test': { hang: true } } });
    const t = await h.start();
    await h.service.approve(t.id, 'Owner');
    await h.service.recordPmApproval(t.id, { name: 'Pat', date: h.clock.iso(), evidence: 'chat' });
    const done = h.runner.runUntilIdle();
    for (let i = 0; i < 200 && !h.process.calls.some((c) => c.command === 'npm test'); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await h.get(t.id)).state).toBe('VERIFYING');
    const r = await h.service.continueWith(t.id, 'The test runner waits for changes and never ends.', { skip: [{ repoId: 'r-app', kind: 'test' }] });
    expect(r.action).toBe('skipping');
    await done;
    const end = await h.get(t.id);
    expect(end).toMatchObject({ state: 'PR_OPEN', needsAttention: false });
    expect(h.agent.calls.filter((c) => c.prompt.startsWith('Verification failed'))).toHaveLength(0);
    expect(h.process.calls.filter((c) => c.command === 'npm test')).toHaveLength(1); // stopped, never run again
  });

  it("keeps what a repo's own checks change (lint --fix), so nothing is left to block the rebase", async () => {
    let wt = '';
    const h = harness({ process: { 'npm run lint': () => (h.git.checksChanged.add(wt), { exitCode: 0 }) } });
    const t0 = await h.start();
    wt = join(h.deps.paths.taskDir(t0.id), 'app');
    const t = await h.approveAll(t0.id);
    expect(t.state).toBe('PR_OPEN');
    expect(h.git.commits.map((c) => c.message)).toContain('Apply lint and formatting fixes');
  });

  it('an expired sign-in while checking an open PR leaves the task open with a clear note, and the note clears once it works', async () => {
    let fail = true;
    const h = harness({
      host: {
        prStatus: () => {
          if (fail) throw new Error('Your session has expired. Please reauthenticate.');
          return 'open';
        },
      },
    });
    const t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('PR_OPEN');
    await h.store.jobs.upsert({ taskId: t.id, state: 'PR_OPEN', step: 'poll', status: 'queued', attempt: 0, notBefore: h.clock.now() });
    await h.runner.runUntilIdle();
    let now = await h.get(t.id);
    expect(now.state).toBe('PR_OPEN');
    expect(now.progress.pollProblem).toMatch(/AWS sign-in has expired/);
    fail = false;
    await h.store.jobs.upsert({ taskId: t.id, state: 'PR_OPEN', step: 'poll', status: 'queued', attempt: 0, notBefore: h.clock.now() });
    await h.runner.runUntilIdle();
    now = await h.get(t.id);
    expect(now.state).toBe('PR_OPEN');
    expect(now.progress.pollProblem).toBeUndefined();
  });

  it('renames an open PR that still has an old-style title to the plain task name', async () => {
    const h = harness();
    const t = await h.approveAll((await h.start()).id);
    const [pr] = await h.store.prs.list(t.id);
    await h.store.prs.upsert({ ...pr!, title: '[needs attention] TND-1: Add a GET /health endpoint' });
    await h.store.jobs.upsert({ taskId: t.id, state: 'PR_OPEN', step: 'poll', status: 'queued', attempt: 0, notBefore: h.clock.now() });
    await h.runner.tick();
    await h.runner.runUntilIdle?.().catch(() => undefined);
    expect(h.host.updatedTitles).toContainEqual({ prId: pr!.id, title: 'Add a GET /health endpoint' });
    expect((await h.store.prs.list(t.id))[0]!.title).toBe('Add a GET /health endpoint');
  });

  it("picks up a repo's changed test command in the next round of the same step", async () => {
    const h = harness({
      process: {
        'npm test': (n) => {
          // The owner fixes the repo's test command while the first round fails.
          if (n === 1) void h.store.repos.get('r-app').then((r) => h.store.repos.upsert({ ...r!, commands: { ...r!.commands, test: 'npm run test:ci' } }));
          return { exitCode: 1 };
        },
      },
    });
    const t = await h.approveAll((await h.start()).id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: false });
    expect(h.process.calls.map((c) => c.command)).toContain('npm run test:ci');
    expect((await h.store.verifyRuns.list(t.id)).map((v) => v.passed)).toEqual([false, true]);
  });
});

describe('workflow: resilience', () => {
  it('a low review finding is listed on the PR, not fixed with another Copilot run', async () => {
    const h = harness({ script: { review: () => ({ value: { findings: [{ severity: 'low', category: 'other', repo: 'app', title: 'Name could be clearer', detail: 'Nit.' }] } }) } });
    const t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('PR_OPEN');
    expect((await h.store.runs.listFor({ taskId: t.id })).map((r) => r.kind)).not.toContain('fix');
    expect(h.host.opened[0]!.description).toContain('Name could be clearer');
  });

  it('a review fix stopped at the credit limit keeps its edits: committed and checked on resume, not left to block the rebase', async () => {
    const h = harness({
      script: {
        review: () => ({ value: { findings: [{ severity: 'medium', category: 'criteria', repo: 'app', title: 'Save button not tested', detail: 'Add a test.' }] } }),
      },
    });
    const started = await h.start();
    h.overrides.reviewFix = async () => {
      // It marks the finding fixed, edits code, then hits the limit before Tandem commits.
      const f = (await h.store.findings.list(started.id))[0]!;
      await h.store.findings.replace(started.id, [{ ...f, status: 'fixed' }]);
      throw new BudgetError('limit');
    };
    let t = await h.approveAll(started.id);
    expect(['BLOCKED', 'FAILED']).toContain(t.state); // stopped mid-fix
    expect(h.git.commits.map((c) => c.message)).not.toContain('Address review findings');
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.blockedMessage ?? '').toBe('');
    expect(t.state).toBe('PR_OPEN');
    expect(h.git.commits.map((c) => c.message)).toContain('Address review findings');
    expect((await h.store.verifyRuns.list(t.id)).at(-1)!.attempt).toBe(100);
  });

  it('resumes a build interrupted by a restart, in the same agent session', async () => {
    const h = harness();
    let hang = true;
    h.overrides.implement = async () => {
      if (hang) await new Promise(() => undefined); // the process "dies" here
      return { text: 'done', edits: [{ path: 'app/src/health.ts', content: 'ok' }], tools: [1, 2].map((n) => ({ name: 'tandem_record_test', args: { criterion: n, repo: 'app', file: 'test/h.test.ts', name: `c${n}` } })) };
    };
    const t = await h.start();
    await h.service.approve(t.id, 'Owner');
    await h.service.recordPmApproval(t.id, { name: 'Pat', date: h.clock.iso(), evidence: 'chat' });
    for (let i = 0; i < 5 && (await h.store.jobs.get(t.id))?.status !== 'running'; i++) await h.runner.tick().then(() => new Promise((r) => setTimeout(r, 20)));
    let job = await h.store.jobs.get(t.id);
    expect(job).toMatchObject({ state: 'BUILDING', step: 'implement', status: 'running', leaseBootId: 'boot-1' });
    const buildSession = (await h.get(t.id)).progress.buildSessionId;
    expect(buildSession).toMatch(/^scripted-\d+$/);

    // New process: recover the job, continue in the same Copilot session.
    hang = false;
    const second = h.makeRunner('boot-2');
    expect(await second.recover()).toEqual({ requeued: 1, created: 0 });
    // The run the restart cut off no longer shows as working.
    const cut = (await h.store.runs.listFor({ taskId: t.id })).filter((r) => r.kind === 'build');
    expect(cut).toEqual([expect.objectContaining({ status: 'aborted', error: expect.stringContaining('Tandem restarted') })]);
    job = await h.store.jobs.get(t.id);
    expect(job).toMatchObject({ status: 'queued' });
    await second.runUntilIdle();
    expect((await h.get(t.id)).state).toBe('PR_OPEN');
    const resumed = h.agent.calls.filter((c) => c.prompt.startsWith('Implement'));
    expect(resumed.at(-1)!.opts.resumeId).toBe(buildSession);
    expect(resumed.at(-1)!.prompt).toContain('may already exist from an interrupted run');
  });

  it('re-checking a task that waits for spec review after a restart leaves its time alone', async () => {
    const h = harness();
    const t = await h.start();
    expect(t.state).toBe('SPEC_REVIEW');
    h.clock.advance(60 * 60_000);
    const r = h.makeRunner('boot-4');
    await r.recover();
    await r.runUntilIdle();
    expect((await h.get(t.id)).updatedAt).toBe(t.updatedAt);
  });

  it('creates jobs on boot for active tasks that lost theirs', async () => {
    const h = harness();
    const t = await h.start();
    await h.store.jobs.delete(t.id);
    await h.store.tasks.upsert({ ...(await h.get(t.id)), state: 'VERIFYING', step: 'verify' });
    const r = h.makeRunner('boot-3');
    expect(await r.recover()).toEqual({ requeued: 0, created: 1 });
    expect(await h.store.jobs.get(t.id)).toMatchObject({ state: 'VERIFYING', step: 'verify' });
  });

  it('cancels a running build and cleans up', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    h.overrides.implement = () => new Promise((r) => (release = () => r({ text: 'late' })));
    const t = await h.start();
    await h.service.approve(t.id, 'Owner');
    await h.service.recordPmApproval(t.id, { name: 'Pat', date: h.clock.iso(), evidence: 'chat' });
    for (let i = 0; i < 100 && !release; i++) {
      await h.runner.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(release).toBeDefined();
    expect((await h.get(t.id)).step).toBe('implement');
    await h.service.cancel(t.id);
    release!();
    await h.runner.runUntilIdle();
    const after = await h.get(t.id);
    expect(after.state).toBe('CANCELLED');
    expect(after.progress.cleanedUp).toBe(true);
    expect(existsSync(h.deps.paths.taskDir(t.id))).toBe(false);
    await expect(h.service.cancel(t.id)).rejects.toThrow(/can't be cancelled/);
  });

  it('retries transient agent errors with backoff', async () => {
    const h = harness();
    let n = 0;
    h.overrides.spec = () => (n++ === 0 ? { error: new RetryableError('rate limited') } : { text: SINGLE_SPEC });
    const t0 = await h.start();
    expect(t0.state).toBe('SPEC_DRAFTING');
    expect(await h.store.jobs.get(t0.id)).toMatchObject({ attempt: 1, lastError: 'rate limited' });
    h.clock.advance(2_000);
    await h.runner.runUntilIdle();
    expect((await h.get(t0.id)).state).toBe('SPEC_REVIEW');
  });

  it('fails after a non-retryable error and resumes the failed step on retry', async () => {
    const h = harness();
    let n = 0;
    h.overrides.spec = () => (n++ === 0 ? { error: new Error('model unavailable') } : { text: SINGLE_SPEC });
    let t = await h.start();
    expect(t.state).toBe('FAILED');
    expect(t.blockedMessage).toContain('SPEC_DRAFTING / draft failed: model unavailable');
    expect(t.resumeTo).toEqual({ state: 'SPEC_DRAFTING', step: 'draft' });
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.state).toBe('SPEC_REVIEW');
  });

  it('stops at the Copilot budget and continues after it is raised', async () => {
    const h = harness();
    await h.ready;
    const s = await h.store.settings.get();
    await h.store.settings.set({ ...s, budget: { ...s.budget, perTaskPrompts: 2 } });
    let t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('budget-reached');
    expect(t.blockedMessage).toMatch(/This task used its Copilot limit \(2 of 2/);
    await h.store.settings.set({ ...s, budget: { ...s.budget, perTaskPrompts: 15 } });
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.state).toBe('PR_OPEN');
  });
});

describe('workflow: model and credits', () => {
  it('runs every step of a task on its picked model, and Auto falls back to Settings', async () => {
    const h = harness({ settings: { copilot: { host: '', buildModel: 'build-default', lightModel: 'light-default', cliPath: '' } } });
    await h.ready;
    const t = await h.start();
    const before = h.agent.calls.length;
    await h.service.setModel(t.id, 'scripted-steady');
    await h.approveAll(t.id);
    // From the next step on, every step (light and build) uses the picked model.
    expect(new Set(h.agent.calls.slice(before).map((c) => c.opts.model))).toEqual(new Set(['scripted-steady']));
    expect(h.agent.calls.slice(before).some((c) => c.opts.tier === 'build')).toBe(true);
    await expect(h.service.setModel(t.id, 'no-such-model')).rejects.toThrow(/not available to this Copilot account/);

    const h2 = harness({ settings: { copilot: { host: '', buildModel: 'build-default', lightModel: 'light-default', cliPath: '' } } });
    await h2.ready;
    await h2.approveAll((await h2.start()).id);
    const byKind = (kind: string) => new Set(h2.agent.calls.filter((c) => c.opts.tier === kind).map((c) => c.opts.model));
    expect(byKind('light')).toEqual(new Set(['light-default']));
    expect(byKind('build')).toEqual(new Set(['build-default']));
  });

  it('stops a run the moment it reaches the credit limit, records what it used, and resumes after the limit is raised', async () => {
    const h = harness();
    await h.ready;
    const s = await h.store.settings.get();
    await h.store.settings.set({ ...s, budget: { ...s.budget, perTaskCredits: 2 } });
    h.overrides.implement = () => ({ text: 'Expensive.', nanoAiu: 3e9 });
    let t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('budget-reached');
    expect(t.blockedMessage).toMatch(/this task reached its Copilot credit limit \(3 of 2\)/);
    const usage = await h.store.usage.list({ taskId: t.id });
    expect(usage.reduce((n, u) => n + u.nanoAiu, 0)).toBe(3e9);
    const run = (await h.store.runs.listFor({ taskId: t.id })).find((r) => r.kind === 'build');
    expect(run?.status).toBe('failed');

    delete h.overrides.implement;
    await h.store.settings.set({ ...s, budget: { ...s.budget, perTaskCredits: 25 } });
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.state).toBe('PR_OPEN');
  });
});

describe('workflow: learned rules', () => {
  it('appends pending rules to docs/agent-rules.md on the next task branch', async () => {
    const h = harness();
    await h.ready;
    await expect(h.service.addRule('nope', 'x', 'y')).rejects.toThrow(/not found/);
    await expect(h.service.addRule('r-app', ' ', 'y')).rejects.toThrow(/Write the rule/);
    const rule = await h.service.addRule('r-app', 'Always validate query parameters.', 'Review comment on TND-0');
    const t = await h.approveAll((await h.start()).id);
    const rules = readFileSync(join(h.deps.paths.taskDir(t.id), 'app', 'docs', 'agent-rules.md'), 'utf8');
    expect(rules).toContain('- Always validate query parameters.');
    expect(await h.store.rules.get(rule.id)).toMatchObject({ status: 'committed', committedInTaskId: t.id });
    expect(h.agent.calls.find((c) => c.prompt.startsWith('Implement'))!.opts.instructions).toContain('Always validate query parameters.');
  });
});

describe('service: partial requirement updates', () => {
  it('never resets fields that were not given', async () => {
    const h = harness();
    await h.ready;
    const t = await h.service.create({ projectId: 'p1', title: 'T', requirement: { goal: 'Keep me', exampleData: undefined } });
    expect(t.requirement.goal).toBe('Keep me');
    const u = await h.service.update(t.id, { requirement: { outOfScope: 'Auth', goal: undefined } });
    expect(u.requirement).toMatchObject({ goal: 'Keep me', outOfScope: 'Auth' });
  });
});

describe('workflow: branch names', () => {
  it('a task not built yet moves from an old agent/ branch name to feature/; a built one keeps its branch', async () => {
    const h = harness();
    const t = await h.start();
    await h.store.tasks.upsert({ ...t, branch: `agent/${t.key}-${t.slug}` });
    expect(await h.service.renameUnbuiltBranches()).toBe(1);
    expect((await h.store.tasks.get(t.id))!.branch).toBe(`feature/${t.key}-${t.slug}`);
    const built = await h.approveAll(t.id);
    await h.store.tasks.upsert({ ...built, branch: `agent/${t.key}-${t.slug}` });
    expect(await h.service.renameUnbuiltBranches()).toBe(0);
    expect((await h.store.tasks.get(t.id))!.branch).toBe(`agent/${t.key}-${t.slug}`);
  });
});
