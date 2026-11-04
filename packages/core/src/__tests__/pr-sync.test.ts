import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harness } from './harness.js';

const BRANCH = 'feature/TND-1-add-a-get-health-endpoint';

/** A task with its PR open, the base at `b1` and the branch exactly as Tandem pushed it. */
async function openPr(o: Parameters<typeof harness>[0] = {}) {
  const h = harness(o);
  const t = await h.approveAll((await h.start()).id);
  expect(t.state).toBe('PR_OPEN');
  const pushed = (t.progress.pushed as Record<string, string>)['r-app']!;
  const wt = join(h.deps.paths.taskDir(t.id), 'app');
  h.overrides.conflict = () => {
    h.git.conflicts = [];
    return { text: 'Kept both changes.' };
  };
  h.git.remote.set(`r-app:main`, 'b1');
  h.git.remote.set(`r-app:${BRANCH}`, pushed);
  const poll = async () => {
    h.clock.advance(5 * 60_000);
    await h.runner.runUntilIdle();
    return (await h.store.prs.list(t.id))[0]!;
  };
  const conflictCalls = () => h.agent.calls.filter((c) => c.prompt.startsWith('The pull request branch')).length;
  return { h, t, pushed, wt, poll, conflictCalls };
}

describe('open PRs and their base branch', () => {
  it('records an up-to-date PR, and one whose base moved without conflicts, and changes nothing', async () => {
    const { h, pushed, wt, poll } = await openPr();
    h.git.ancestors.add(`b1|${pushed}`);
    expect((await poll()).sync).toMatchObject({ state: 'up-to-date', base: 'b1', head: pushed });

    h.git.remote.set('r-app:main', 'b2');
    expect((await poll()).sync).toMatchObject({ state: 'mergeable', base: 'b2' });
    expect(h.git.merges).toEqual([]);
    expect(h.host.pushes).toHaveLength(1);
    expect(h.git.resets.at(-1)).toEqual({ worktree: wt, ref: pushed });
  });

  it('merges the base in, has the agent resolve the conflict, runs every check and pushes without force', async () => {
    const { h, t, wt, poll, conflictCalls } = await openPr();
    const checksBefore = h.process.calls.length;
    h.git.remote.set('r-app:main', 'b2');
    h.git.mergeConflicts.set(wt, ['src/app.ts']);
    const pr = await poll();

    expect(conflictCalls()).toBe(1);
    expect(h.agent.calls.at(-1)!.prompt).toContain('conflicts in: src/app.ts');
    expect(h.git.merges).toEqual([{ worktree: wt, ref: 'b2', message: `Merge branch 'main' into ${BRANCH}` }]);
    expect(h.process.calls.slice(checksBefore).map((c) => c.command)).toEqual(['npm ci', 'npm run lint', 'npm run typecheck', 'npm run build', 'npm test']);
    expect(h.host.pushes).toEqual([{ repoId: 'r-app' }, { repoId: 'r-app' }]);
    const sha = (await h.get(t.id)).progress.pushed as Record<string, string>;
    expect(pr.sync).toMatchObject({ state: 'updated', base: 'b2', head: sha['r-app'], files: ['src/app.ts'] });
    expect(h.host.updatedDescriptions.at(-1)!.description).toContain('| Check | Command | Result | Time |');
    expect(h.tracker.comments.at(-1)!.body).toMatch(/main changed and conflicted with the PR in src\/app\.ts\. Tandem merged it in/);
    expect((await h.get(t.id)).state).toBe('PR_OPEN');

    // Handled once: the same base and branch are not looked at again.
    h.git.remote.set(`r-app:${BRANCH}`, sha['r-app']!);
    await poll();
    expect(h.git.merges).toHaveLength(1);
  });

  it('leaves a branch someone else pushed to for a person, until the owner asks Tandem to fix it', async () => {
    const { h, t, pushed, wt, poll, conflictCalls } = await openPr();
    h.git.remote.set(`r-app:${BRANCH}`, 'dev-1');
    h.git.ancestors.add(`${pushed}|dev-1`);
    h.git.remote.set('r-app:main', 'b2');
    h.git.mergeConflicts.set(wt, ['src/app.ts']);
    let pr = await poll();
    expect(pr.sync).toMatchObject({ state: 'needs-person', files: ['src/app.ts'] });
    expect(pr.sync!.message).toMatch(/Someone else has pushed/);
    expect(conflictCalls()).toBe(0);
    expect(h.host.pushes).toHaveLength(1);

    await h.service.fixConflicts(t.id);
    await h.runner.runUntilIdle();
    pr = (await h.store.prs.list(t.id))[0]!;
    expect(pr.sync?.state).toBe('updated');
    // Their commits are the starting point; nothing of theirs is overwritten.
    expect(h.git.resets).toContainEqual({ worktree: wt, ref: 'dev-1' });
    expect(h.host.pushes.at(-1)).toEqual({ repoId: 'r-app' });
    expect((await h.get(t.id)).progress.syncRequested).toBe(false);
  });

  it('never touches a rewritten branch, and waits for a person when automatic fixing is off', async () => {
    const a = await openPr();
    a.h.git.remote.set(`r-app:${BRANCH}`, 'rewritten');
    a.h.git.remote.set('r-app:main', 'b2');
    a.h.git.mergeConflicts.set(a.wt, ['src/app.ts']);
    expect((await a.poll()).sync?.state).toBe('branch-rewritten');
    expect(a.h.git.resets).toEqual([]);
    await a.h.service.fixConflicts(a.t.id);
    await a.h.runner.runUntilIdle();
    expect(a.h.git.merges).toEqual([]);

    const b = await openPr({ settings: { polling: { prPollIntervalMin: 5, fixConflicts: false } } });
    b.h.git.remote.set('r-app:main', 'b2');
    b.h.git.mergeConflicts.set(b.wt, ['src/app.ts']);
    const pr = await b.poll();
    expect(pr.sync?.state).toBe('needs-person');
    expect(pr.sync!.message).toMatch(/off in Settings/);
    expect(b.conflictCalls()).toBe(0);
  });

  it('pushes nothing when the agent cannot resolve the conflict or checks fail afterwards, and does not retry by itself', async () => {
    const a = await openPr();
    a.h.overrides.conflict = () => ({ text: 'Could not.' });
    a.h.git.remote.set('r-app:main', 'b2');
    a.h.git.mergeConflicts.set(a.wt, ['src/app.ts']);
    expect((await a.poll()).sync).toMatchObject({ state: 'unresolved', files: ['src/app.ts'] });
    expect(a.h.git.resets.at(-1)).toEqual({ worktree: a.wt, ref: a.pushed });
    expect(a.h.host.pushes).toHaveLength(1);
    await a.poll();
    expect(a.conflictCalls()).toBe(1);

    // The base branch itself passes; merging it into the PR branch breaks a test.
    const b = await openPr({ process: { 'npm test': (n, cwd) => (n > 1 && !cwd.includes('.baseline') ? { exitCode: 1, stdout: 'FAIL test/app.test.ts' } : {}) } });
    b.h.git.remote.set('r-app:main', 'b2');
    b.h.git.mergeConflicts.set(b.wt, ['src/app.ts']);
    const pr = await b.poll();
    expect(pr.sync?.state).toBe('checks-failed');
    expect(b.h.git.resets.at(-1)).toEqual({ worktree: b.wt, ref: b.pushed });
    expect(b.h.host.pushes).toHaveLength(1);
    expect((await b.h.get(b.t.id)).state).toBe('PR_OPEN');
  });

  it('an owner action during a check is not lost: marking merged mid-check finishes the task right after', async () => {
    const { h, t, poll } = await openPr();
    const pr = (await h.store.prs.list(t.id))[0]!;
    const mirror = h.host.mirror.bind(h.host);
    h.host.mirror = async (repo) => {
      h.host.mirror = mirror;
      h.clock.advance(1_000);
      await h.service.markMerged(pr.id);
      return mirror(repo);
    };
    await poll();
    expect((await h.get(t.id)).state).toBe('DONE');
  });
});
