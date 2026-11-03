import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRuntime, AgentSession } from '../ports.js';
import { openSession } from '../workflow/context.js';
import { harness } from './harness.js';

describe('agent activity', () => {
  it('records what each run did, in order, with its usage', async () => {
    const h = harness();
    let t = await h.start();
    t = await h.approveAll(t.id);
    const runs = await h.store.runs.listFor({ taskId: t.id });
    const steps = await h.store.agentSteps.list({ taskId: t.id });
    const build = runs.find((r) => r.kind === 'build')!;
    const buildSteps = steps.filter((s) => s.runId === build.id);
    // The instructions first, then its edits and linked tests, then its answer.
    expect(buildSteps.map((s) => s.kind)).toEqual(expect.arrayContaining(['prompt', 'tool', 'message']));
    expect(buildSteps[0]!.kind).toBe('prompt');
    expect(buildSteps.map((s) => s.seq)).toEqual(buildSteps.map((_, i) => i));
    const edit = buildSteps.find((s) => s.kind === 'tool' && s.tool === 'edit')!;
    expect(edit).toMatchObject({ ok: true, title: expect.stringMatching(/^Edit /), files: [{ kind: 'edit', path: expect.any(String) }] });
    expect(buildSteps.some((s) => s.kind === 'tool' && s.tool === 'tandem_record_test')).toBe(true);
    // Every run's steps start with its instructions; usage is tied to the run.
    for (const r of runs) expect(steps.find((s) => s.runId === r.id)?.kind).toBe('prompt');
    const usage = await h.store.usage.list({ taskId: t.id });
    expect(usage.every((u) => runs.some((r) => r.id === u.runId))).toBe(true);
    expect(h.events.events.some((e) => e.type === 'agent.step' && e.taskId === t.id)).toBe(true);
  });

  it('pairs tool calls, keeps blocked actions, redacts secrets and shortens long output', async () => {
    const h = harness();
    const script: AgentEvent[] = [
      { type: 'intent', text: 'Looking around' },
      { type: 'intent', text: 'Looking around' },
      { type: 'reasoning', text: 'The key is AKIAABCDEFGHIJKLMNOP, I should not use it.' },
      { type: 'tool-start', id: 'a', tool: 'bash', title: 'Run tests', input: 'npm test' },
      { type: 'tool', tool: 'bash', summary: 'curl https://example.com', allowed: false, reason: 'Network tools are not allowed.' },
      { type: 'tool-end', id: 'a', ok: false, output: 'x'.repeat(10_000) },
      { type: 'message', text: 'Done.' },
    ];
    const agent: AgentRuntime = {
      name: 'stub',
      startSession: async (opts): Promise<AgentSession> => ({
        id: 's1',
        send: async () => {
          for (const e of script) opts.onEvent?.(e);
          return { text: 'Done.', usage: { model: 'm', modelCalls: 1, nanoAiu: 0 } };
        },
        sendStructured: async () => {
          throw new Error('unused');
        },
        stop: async () => undefined,
      }),
    };
    const s = await openSession({ ...h.deps, agent }, { taskId: 't1', kind: 'build', mode: 'build', workspace: '/tmp', instructions: 'x' });
    await s.send('Build it. password=hunter22');
    await s.stop();
    const steps = await h.store.agentSteps.list({ runId: s.runId });
    expect(steps.map((x) => x.kind)).toEqual(['prompt', 'intent', 'reasoning', 'blocked', 'tool', 'message']);
    expect(JSON.stringify(steps)).not.toContain('hunter22');
    expect(JSON.stringify(steps)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(steps[3]).toMatchObject({ kind: 'blocked', tool: 'bash', text: 'curl https://example.com', output: 'Network tools are not allowed.' });
    const tool = steps[4]!;
    expect(tool).toMatchObject({ kind: 'tool', tool: 'bash', title: 'Run tests', input: 'npm test', ok: false });
    expect(tool.output!.length).toBeLessThan(4_100);
    expect(tool.output).toMatch(/… \(shortened\)$/);
  });
});
