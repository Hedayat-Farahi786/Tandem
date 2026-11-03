import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatService, extractRefs } from '../chat/chat-service.js';
import { GOOD_REQUIREMENT, SINGLE_SPEC, harness } from './harness.js';

function chat(h: ReturnType<typeof harness>) {
  return new ChatService(h.deps, h.service);
}

describe('chat: Ask', () => {
  it('answers read-only with checked file references and resumes the session', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    h.overrides.chat = (call) => {
      expect(call.opts.mode).toBe('read-only');
      expect(call.opts.tools ?? []).toEqual([]);
      return { text: 'The route is in app/src/app.ts:12 and tests in test/app.test.ts:3; also see src/missing.ts:9.' };
    };
    const t = await c.createThread({ projectId: 'p1', mode: 'ask' });
    // The reference checkout the agent reads.
    const ref = h.deps.paths.referenceDir('p1', 'app');
    mkdirSync(join(ref, 'src'), { recursive: true });
    mkdirSync(join(ref, 'test'), { recursive: true });
    writeFileSync(join(ref, 'src', 'app.ts'), 'x');
    writeFileSync(join(ref, 'test', 'app.test.ts'), 'x');
    const r = await c.send(t.id, 'Where is the greeting route?');
    expect(r.message.role).toBe('assistant');
    expect(r.message.refs).toEqual([
      { path: 'src/app.ts', line: 12, repoId: 'r-app' },
      { path: 'test/app.test.ts', line: 3, repoId: 'r-app' },
    ]);
    expect(h.agent.calls[0]!.prompt).toContain('Question: Where is the greeting route?');
    expect(h.agent.calls[0]!.opts.workspace).toBe(h.deps.paths.referenceRoot('p1'));
    await c.send(t.id, 'And the tests?');
    expect(h.agent.calls[1]!.opts.resumeId).toBe((await h.store.threads.get(t.id))!.sessionId);
    expect((await c.messages(t.id)).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(await h.store.usage.prompts({})).toBe(2);
    expect(h.events.events.some((e) => e.type === 'chat.done')).toBe(true);
    await expect(c.send(t.id, '   ')).rejects.toThrow(/Write a message/);
  });
});

describe('chat: Request', () => {
  it('asks until the Definition of Ready is met, then creates the task without a size call', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    let turn = 0;
    h.overrides.chat = (call) => {
      turn++;
      if (turn === 1) {
        expect(call.prompt).toContain('Still missing for the Definition of Ready');
        return { text: 'What should the main page show when the backend is down?', tools: [{ name: 'tandem_update_draft', args: { title: 'Health endpoint', goal: GOOD_REQUIREMENT.goal, criteria: [GOOD_REQUIREMENT.criteria[0]] } }] };
      }
      return {
        text: 'Thanks, that covers it.',
        tools: [{ name: 'tandem_update_draft', args: { ...GOOD_REQUIREMENT, affectedRepos: ['app'], size: { estimatedLines: 50, perRepo: [], features: ['health'], proposedSplit: [], rationale: 'small' } } }],
      };
    };
    const t = await c.createThread({ projectId: 'p1', mode: 'request' });
    const r1 = await c.send(t.id, 'Add a GET /health endpoint returning {status: "ok"} and show the status on the main page.');
    expect(r1.readiness?.ready).toBe(false);
    expect(r1.thread.title).toBe('Health endpoint');
    await expect(c.createTask(t.id)).rejects.toThrow(/Not ready yet/);
    const r2 = await c.send(t.id, 'Show "Status unavailable". Out of scope: auth.');
    expect(r2.readiness?.ready).toBe(true);
    expect(h.agent.calls.every((x) => x.opts.tools?.some((tool) => tool.name === 'tandem_update_draft'))).toBe(true);

    const task = await c.createTask(t.id);
    expect(task).toMatchObject({ state: 'READINESS', source: 'chat', title: 'Health endpoint', affectedRepoIds: ['r-app'] });
    await h.runner.runUntilIdle();
    expect((await h.get(task.id)).state).toBe('SPEC_REVIEW');
    expect(h.agent.calls.filter((x) => x.prompt.startsWith('Estimate the size'))).toHaveLength(0);
    expect((await h.get(task.id)).sizeEstimate?.estimatedLines).toBe(50);
    await expect(c.createTask(t.id)).rejects.toThrow(/already became a task/);
    await expect(c.send(t.id, 'more')).rejects.toThrow(/already became a task/);
    expect((await c.messages(t.id)).at(-1)!.content).toMatch(/^Created TND-1/);
  });
});

describe('chat: task thread', () => {
  it('proposes a spec redraft that the owner confirms', async () => {
    const h = harness();
    const task = await h.start();
    const c = chat(h);
    const th = await c.taskThread(task.id);
    expect((await c.taskThread(task.id)).id).toBe(th.id);
    h.overrides.chat = (call) => {
      expect(call.prompt).toContain('Current spec (version 1)');
      return { text: 'I proposed the change.', tools: [{ name: 'tandem_request_spec_change', args: { kind: 'redraft', summary: 'Return the version too', feedback: 'Also return the version number in /health.' } }] };
    };
    await c.send(th.id, 'Can /health also return the version?');
    expect((await h.store.threads.get(th.id))!.pendingSpecChange).toMatchObject({ kind: 'redraft', summary: 'Return the version too' });
    expect(await h.store.usage.prompts({ taskId: task.id })).toBeGreaterThan(0); // task chat counts against the task
    await c.applySpecChange(th.id);
    await h.runner.runUntilIdle();
    expect((await h.store.specs.list(task.id)).map((s) => [s.version, s.feedback])).toEqual([
      [1, undefined],
      [2, 'Also return the version number in /health.'],
    ]);
    await expect(c.applySpecChange(th.id)).rejects.toThrow(/no proposed spec change/);
  });

  it('applies an exact spec edit, and can dismiss a proposal', async () => {
    const h = harness();
    const task = await h.start();
    const c = chat(h);
    const th = await c.taskThread(task.id);
    h.overrides.chat = () => ({ text: 'ok', tools: [{ name: 'tandem_request_spec_change', args: { kind: 'edit', summary: 'Flag', markdown: SINGLE_SPEC.replace('No flags needed.', 'Behind a flag.') } }] });
    await c.send(th.id, 'Put it behind a flag.');
    await c.applySpecChange(th.id);
    expect((await h.store.specs.latest(task.id))!.markdown).toContain('Behind a flag.');
    await c.send(th.id, 'And another change.');
    await c.dismissSpecChange(th.id);
    expect((await h.store.threads.get(th.id))!.pendingSpecChange).toBeUndefined();
  });
});

describe('extractRefs', () => {
  it('ignores URLs, versions and missing files', () => {
    const h = harness();
    const root = h.deps.paths.referenceRoot('p1');
    mkdirSync(join(root, 'app', 'src'), { recursive: true });
    writeFileSync(join(root, 'app', 'src', 'x.ts'), '');
    const refs = extractRefs('see src/x.ts:4-9, https://host:443/a.js:3, v1.2:3, app/src/x.ts:4 again, other/y.ts:1', root, h.repos);
    expect(refs).toEqual([{ path: 'src/x.ts', line: 4, repoId: 'r-app' }]);
  });
});
