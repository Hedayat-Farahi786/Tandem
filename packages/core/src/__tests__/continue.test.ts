import { describe, expect, it } from 'vitest';
import { harness } from './harness.js';

describe('continue with the owner’s guidance', () => {
  it('gives a PR whose checks still fail another fix round, with the guidance in every prompt', async () => {
    // The first run and both fix attempts fail; after the owner's guidance one more fix makes it pass.
    const h = harness({ process: { 'npm test': (n) => (n <= 4 ? { exitCode: 1, stdout: 'expected 2026-11-03T00:00:00Z' } : { exitCode: 0 }) } });
    let t = await h.approveAll((await h.start()).id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: true });

    const r = await h.service.continueWith(t.id, 'The test expects UTC dates, so use UTC everywhere. password=hunter22');
    expect(r.action).toBe('fixing');
    expect(r.task).toMatchObject({ state: 'VERIFYING', needsAttention: false });
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: false, attentionNotes: [] });
    expect(t.guidance).toEqual([{ text: expect.stringContaining('use UTC everywhere'), at: expect.any(String) }]);
    expect(JSON.stringify(t.guidance)).not.toContain('hunter22');

    // The new fix prompt carries the guidance; the PR now describes passing checks.
    const fix = h.agent.calls.filter((c) => c.prompt.startsWith('Verification failed')).at(-1)!;
    expect(fix.prompt).toContain('Guidance from the owner for this task');
    expect(fix.prompt).toContain('use UTC everywhere');
    const pr = (await h.store.prs.list(t.id))[0]!;
    expect(pr.title).toBe('Add a GET /health endpoint');
    expect(h.host.updatedDescriptions.at(-1)?.description).not.toContain('**Needs attention.**');
    expect(t.progress.refreshPrs).toBe(false);
    expect((await h.store.audit.list({ taskId: t.id })).some((e) => e.action === 'task.guidance')).toBe(true);
  });

  it('resumes a blocked task, redrafts a spec in review, notes guidance while working, and refuses finished tasks', async () => {
    const h = harness();
    let t = await h.start();
    expect(t.state).toBe('SPEC_REVIEW');
    expect((await h.service.continueWith(t.id, 'Also return the version.')).action).toBe('redrafting');
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(h.agent.calls.filter((c) => c.prompt.startsWith('Write the implementation spec')).at(-1)!.prompt).toContain('Also return the version.');

    await h.store.tasks.upsert({ ...t, state: 'BLOCKED', blockedReason: 'rebase-conflict', blockedMessage: 'Conflict in app.ts', resumeTo: { state: 'SPEC_REVIEW' } });
    await h.store.jobs.delete(t.id);
    const resumed = await h.service.continueWith(t.id, 'Keep our version of app.ts.');
    expect(resumed).toMatchObject({ action: 'resumed', task: { state: 'SPEC_REVIEW' } });

    await h.store.tasks.upsert({ ...(await h.get(t.id)), state: 'BUILDING', step: 'implement' });
    expect((await h.service.continueWith(t.id, 'Use the existing date helper.')).action).toBe('noted');
    expect((await h.get(t.id)).guidance.map((g) => g.text)).toEqual(['Keep our version of app.ts.', 'Use the existing date helper.']);

    await expect(h.service.continueWith(t.id, '  ')).rejects.toThrow(/Write what Copilot should do/);
    await h.store.tasks.upsert({ ...(await h.get(t.id)), state: 'DONE' });
    await expect(h.service.continueWith(t.id, 'More')).rejects.toThrow(/finished/);
  });
});
