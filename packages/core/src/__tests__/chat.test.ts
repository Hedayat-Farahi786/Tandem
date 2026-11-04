import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatService, extractRefs, shortTitle } from '../chat/chat-service.js';
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
    expect((await h.store.threads.get(t.id))!.title).toBe('Where is the greeting route?');
    await c.send(t.id, 'And the tests?');
    expect((await h.store.threads.get(t.id))!.title).toBe('Where is the greeting route?');
    expect(h.agent.calls[1]!.opts.resumeId).toBe((await h.store.threads.get(t.id))!.sessionId);
    expect((await c.messages(t.id)).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(await h.store.usage.prompts({})).toBe(2);
    expect(h.events.events.some((e) => e.type === 'chat.done')).toBe(true);
    await expect(c.send(t.id, '   ')).rejects.toThrow(/Write a message/);
  });
});

describe('chat: answering survives reloads and navigation', () => {
  it('marks the chat busy while Copilot answers, refuses a second message meanwhile, and clears it after', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    let release!: () => void;
    h.overrides.chat = () => new Promise((r) => (release = () => r({ text: 'Done.' })));
    const t = await c.createThread({ projectId: 'p1', mode: 'ask' });
    const first = c.send(t.id, 'Where is the health route?');
    for (let i = 0; i < 50 && !(await c.thread(t.id)).busy?.runId; i++) await new Promise((r) => setTimeout(r, 5));
    const busy = (await c.thread(t.id)).busy!;
    expect(busy.runId).toBeTruthy(); // a reloaded page can follow this run's steps
    expect((await c.messages(t.id)).map((m) => m.role)).toEqual(['user']); // the question is saved at once
    await expect(c.send(t.id, 'And the tests?')).rejects.toThrow(/still answering/);
    release();
    await first;
    expect((await c.thread(t.id)).busy).toBeUndefined();
    expect((await c.messages(t.id)).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('a failed answer leaves a note in the chat and frees it', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    h.overrides.chat = () => {
      throw new Error('Copilot is unavailable right now.');
    };
    const t = await c.createThread({ projectId: 'p1', mode: 'ask' });
    await expect(c.send(t.id, 'Hello?')).rejects.toThrow(/unavailable/);
    expect((await c.thread(t.id)).busy).toBeUndefined();
    expect((await c.messages(t.id)).at(-1)).toMatchObject({ role: 'system', content: expect.stringContaining("Copilot couldn't answer: Copilot is unavailable right now.") });
  });

  it('after a restart, no chat is left answering forever', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    const t = await c.createThread({ projectId: 'p1', mode: 'ask' });
    await h.store.threads.upsert({ ...(await c.thread(t.id)), busy: { since: h.clock.iso() } });
    expect(await c.clearStaleBusy()).toBe(1);
    expect((await c.thread(t.id)).busy).toBeUndefined();
    expect((await c.messages(t.id)).at(-1)!.content).toMatch(/Tandem restarted while Copilot was answering/);
    await c.send(t.id, 'Again, please.');
  });
});

describe('shortTitle', () => {
  it('keeps short first lines and cuts long ones at a word boundary', () => {
    expect(shortTitle('  Where is X?\nmore detail')).toBe('Where is X?');
    const t = shortTitle('How does the checkout service decide which payment provider to call when the primary one is down?');
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toBe('How does the checkout service decide which payment provider…');
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

describe('chat: questions for the owner', () => {
  it('shows the agent questions as choices, keeps the answers, and closes them on reply', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    h.overrides.chat = () => ({
      text: 'Two quick questions.',
      tools: [
        {
          name: 'tandem_ask_owner',
          args: {
            questions: [
              { header: 'When it fails, what should the page show in its place', question: 'What should the page show if the backend is down?', options: [{ label: 'Status unavailable', description: 'A short line' }, { label: 'Other', description: 'dropped' }, { label: 'An error banner' }] },
              { header: 'Out of scope', question: 'What should this leave out?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Metrics' }] },
            ],
          },
        },
      ],
    });
    const t = await c.createThread({ projectId: 'p1', mode: 'request' });
    await c.send(t.id, 'Add a health endpoint.');
    expect(h.agent.calls.at(-1)!.opts.tools?.map((x) => x.name)).toContain('tandem_ask_owner');
    // The page reloads the chat as soon as the questions arrive.
    expect(h.events.events.some((e) => e.type === 'thread.updated' && e.threadId === t.id)).toBe(true);
    const asked = (await c.thread(t.id)).pendingQuestions!;
    expect(asked.questions).toHaveLength(2);
    // Headers are kept short; an "Other" option is dropped (the owner can always write their own).
    expect(asked.questions[0]!).toMatchObject({ id: 'q1', header: 'When it fails, what', options: [{ label: 'Status unavailable', description: 'A short line' }, { label: 'An error banner' }], multiSelect: false });
    expect(asked.questions[1]!.multiSelect).toBe(true);

    h.overrides.chat = () => ({ text: 'Thanks.' });
    const answers = [
      { questionId: 'q1', header: 'Fails', question: 'What should the page show if the backend is down?', answers: ['Status unavailable'] },
      { questionId: 'q2', header: 'Out of scope', question: 'What should this leave out?', answers: ['Auth', 'Metrics'] },
    ];
    await c.send(t.id, 'Fails: Status unavailable\nOut of scope: Auth, Metrics', undefined, answers);
    expect((await c.thread(t.id)).pendingQuestions).toBeUndefined();
    expect((await c.messages(t.id)).filter((m) => m.role === 'user').at(-1)).toMatchObject({ content: 'Fails: Status unavailable\nOut of scope: Auth, Metrics', answers });
    expect(h.agent.calls.at(-1)!.prompt).toContain('Out of scope: Auth, Metrics');
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

  it('renames the task when asked, and its open pull request takes the name at once', async () => {
    const h = harness();
    await h.ready;
    const task = await h.approveAll((await h.start()).id);
    expect(task.state).toBe('PR_OPEN');
    const c = chat(h);
    const th = await c.taskThread(task.id);
    h.overrides.chat = (call) => {
      // The chat knows the pull requests and their titles.
      expect(call.prompt).toContain('Pull requests:\n- app: "Add a GET /health endpoint" (open)');
      expect(call.opts.tools?.map((t) => t.name)).toContain('tandem_rename_task');
      return { text: 'Done.', tools: [{ name: 'tandem_rename_task', args: { title: 'TND-1: Health check endpoint.' } }] };
    };
    await c.send(th.id, 'Call it Health check endpoint');
    expect((await h.get(task.id)).title).toBe('Health check endpoint');
    const [pr] = await h.store.prs.list(task.id);
    expect(pr!.title).toBe('Health check endpoint');
    expect(h.host.updatedTitles.at(-1)).toEqual({ prId: pr!.id, title: 'Health check endpoint' });
    expect((await h.store.audit.list({ taskId: task.id })).some((e) => e.action === 'task.renamed')).toBe(true);
  });

  it('after asking for help, says so when the problem resolved itself', async () => {
    const h = harness({ process: { 'npm test': { exitCode: 1 } } });
    await h.ready;
    let task = await h.approveAll((await h.start()).id);
    const c = chat(h);
    await c.notifyStuck(task.id);
    const th = await c.taskThread(task.id);
    expect((await c.messages(th.id)).at(-1)!.content).toMatch(/^I need your help with TND-1\./);
    task = (await h.service.continueWith(task.id, 'No Chrome here.', { skip: [{ repoId: 'r-app', kind: 'test' }] })).task;
    await h.runner.runUntilIdle();
    await c.notifyResolved(task.id);
    expect((await c.messages(th.id)).at(-1)!.content).toBe("That's sorted: the checks pass and the pull request is up to date. Nothing needs you right now.");
    await c.notifyResolved(task.id); // said once
    expect((await c.messages(th.id)).filter((m) => m.content.startsWith("That's sorted"))).toHaveLength(1);
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

describe('chat: model', () => {
  it('keeps a picked model per chat, passes it to the task, and lets a task chat change the task model', async () => {
    const h = harness();
    await h.ready;
    const c = chat(h);
    await expect(c.createThread({ projectId: 'p1', mode: 'ask', model: 'gpt-nope' })).rejects.toThrow(/not available/);
    const ask = await c.createThread({ projectId: 'p1', mode: 'ask', model: 'scripted-steady' });
    expect(await c.modelOf(ask)).toBe('scripted-steady');
    await c.send(ask.id, 'Where is the greeting route?');
    expect(h.agent.calls.at(-1)!.opts.model).toBe('scripted-steady');
    const cleared = await c.setModel(ask.id, '');
    expect(cleared.model).toBeUndefined();
    await c.send(ask.id, 'And the tests?');
    expect(h.agent.calls.at(-1)!.opts.model).toBeUndefined();

    const req = await c.createThread({ projectId: 'p1', mode: 'request' });
    await c.setModel(req.id, 'scripted-swift');
    await h.store.threads.upsert({ ...(await h.store.threads.get(req.id))!, draft: GOOD_REQUIREMENT, draftTitle: 'Health' });
    const task = await c.createTask(req.id);
    expect(task.model).toBe('scripted-swift');
    await expect(c.setModel(req.id, 'scripted-steady')).rejects.toThrow(/already became a task/);

    const tc = await c.taskThread(task.id);
    expect(await c.modelOf(tc)).toBe('scripted-swift');
    await c.setModel(tc.id, 'scripted-steady');
    expect((await h.store.tasks.get(task.id))!.model).toBe('scripted-steady');
    expect(await c.modelOf(tc)).toBe('scripted-steady');
  });
});

describe('chat: a stuck task', () => {
  it('asks for help in the task chat, takes a proposal or a message, and continues the task', async () => {
    const h = harness({ process: { 'npm test': (n) => (n <= 4 ? { exitCode: 1 } : { exitCode: 0 }) } });
    const c = chat(h);
    let t = await h.approveAll((await h.start()).id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: true });

    // Tandem asks once, in plain words.
    await c.notifyStuck(t.id);
    await c.notifyStuck(t.id);
    const thread = await c.taskThread(t.id);
    const asked = (await h.store.messages.list(thread.id)).filter((m) => m.role === 'assistant');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.content).toMatch(/^I need your help with TND-1\. The pull request is open, but some checks still fail:/);

    // Copilot proposes how to go on; its answer links to the run that wrote it.
    h.overrides.chat = (call) => {
      expect(call.opts.tools?.map((x) => x.name)).toEqual(['tandem_request_spec_change', 'tandem_continue_task', 'tandem_rename_task']);
      return { text: 'The date test compares local time. I suggest using UTC.', tools: [{ name: 'tandem_continue_task', args: { summary: 'Use UTC in the date test', guidance: 'Compare dates in UTC in test/health.test.ts.' } }] };
    };
    const reply = await c.send(thread.id, 'Why do the checks fail?');
    expect(reply.message.runId).toEqual(expect.any(String));
    expect((await c.thread(thread.id)).pendingContinue).toEqual({ summary: 'Use UTC in the date test', guidance: 'Compare dates in UTC in test/health.test.ts.' });

    // Confirming it continues the task with that guidance.
    const r = await c.continueTask(thread.id);
    expect(r.action).toBe('fixing');
    expect((await c.thread(thread.id)).pendingContinue).toBeUndefined();
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t).toMatchObject({ state: 'PR_OPEN', needsAttention: false, guidance: [{ text: 'Compare dates in UTC in test/health.test.ts.' }] });
    const last = (await h.store.messages.list(thread.id)).at(-1)!;
    expect(last).toMatchObject({ role: 'system', content: expect.stringContaining('another round of fixes') });

    // A message typed in the chat can continue it too, and stays in the conversation.
    await h.store.tasks.upsert({ ...t, state: 'BLOCKED', blockedReason: 'push-rejected', blockedMessage: 'Rejected', resumeTo: { state: 'SELF_REVIEW', step: 'push' } });
    await h.store.jobs.delete(t.id);
    const typed = await c.continueTask(thread.id, 'Pull first, then push again.');
    expect(typed.action).toBe('resumed');
    expect((await h.store.messages.list(thread.id)).slice(-2).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Pull first, then push again.'],
      ['system', 'Continuing the task with your guidance.'],
    ]);
    await expect(c.continueTask((await c.createThread({ projectId: 'p1', mode: 'ask' })).id, 'x')).rejects.toThrow(/Only a task chat/);
  });
});
