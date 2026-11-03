/**
 * Live Copilot, end to end: the two project shapes with the real agent. This spends AI credits on
 * the owner's Copilot plan, so it is skipped unless TANDEM_E2E_COPILOT=1 and runs only with the
 * owner's go-ahead. Hard limits: TANDEM_E2E_CREDITS_PER_TASK (default 15) and
 * TANDEM_E2E_CREDITS_PER_DAY (default 40); a run that reaches one stops at once.
 *
 *   TANDEM_E2E_COPILOT=1 COPILOT_GH_HOST=<host> [TANDEM_E2E_MODEL=gpt-6-luna] pnpm test:flows e2e/flows/copilot.e2e.test.ts
 *
 * Add TANDEM_E2E_REAL=1 (and the AWS settings) to run against the sandbox repos on CodeCommit.
 * Requests are worded with everything the Definition of Ready asks for, so the agent needs few turns.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, REAL, type Detail } from './harness.js';

const ON = process.env.TANDEM_E2E_COPILOT === '1';
const MODEL = process.env.TANDEM_E2E_MODEL ?? 'gpt-6-luna';
const PER_TASK = process.env.TANDEM_E2E_CREDITS_PER_TASK ?? '15';
const PER_DAY = process.env.TANDEM_E2E_CREDITS_PER_DAY ?? '40';

const FULLSTACK = [
  'Add a health check. The server gets GET /api/health returning 200 {"status":"ok"}, and the main page shows "Status: ok" under the heading.',
  'Acceptance criteria: (1) Given the server is running, when GET /api/health is called, then it returns 200 with {"status":"ok"}. (2) Given the main page loads, when the health call succeeds, then the page shows "Status: ok"; when it fails, the page shows "Status unavailable".',
  'Example data: GET /api/health -> 200 {"status":"ok"}. Affected areas: src/server/app.ts, src/web/api.ts, src/web/App.tsx and their tests.',
  'Out of scope: authentication, metrics, styling. No open questions.',
].join(' ');

const DUO = [
  'Add a health check across both repos. The backend gets GET /api/health returning 200 {"status":"ok"}; the frontend main page shows "API: ok" under the heading.',
  'Acceptance criteria: (1) Given the backend is running, when GET /api/health is called, then it returns 200 with {"status":"ok"}. (2) Given the frontend main page loads, when the health call succeeds, then it shows "API: ok"; when it fails, it shows "API: unavailable".',
  'Example data: GET /api/health -> 200 {"status":"ok"}. Affected areas: backend src/app.ts and its tests; frontend src/api.ts, src/App.tsx and their tests.',
  'Out of scope: authentication, metrics, styling. No open questions.',
].join(' ');

const NUDGE = 'That is all the detail there is. Use sensible defaults for anything else, record the draft with no open questions, and tell me when it is ready.';

describe.skipIf(!ON)('live Copilot (real agent; costs AI credits)', () => {
  const h = new Harness({ agent: 'copilot', env: { TANDEM_CREDITS_PER_TASK: PER_TASK, TANDEM_CREDITS_PER_DAY: PER_DAY } });
  const summary: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    await h.prepareRemotes(['fullstack', 'backend', 'frontend']);
    await h.start();
    const catalog = await h.api<{ models: Array<{ id: string; estimate?: number }> }>('GET', '/api/copilot/models');
    const m = catalog.models.find((x) => x.id === MODEL);
    if (!m) throw new Error(`${MODEL} is not available to this Copilot account.`);
  }, 300_000);

  afterAll(async () => {
    const usage = await h.api<{ credits: { today: number } }>('GET', '/api/usage').catch(() => undefined);
    writeFileSync(join(h.work, 'copilot-summary.json'), JSON.stringify({ model: MODEL, mode: REAL ? 'real' : 'local', creditsToday: usage?.credits.today, scenarios: summary }, null, 2));
    await h.stop();
  });

  /** Chat until the draft is ready (at most two nudges), then create the task. */
  async function fromChat(projectId: string, text: string): Promise<{ id: string; key: string; turns: number }> {
    let r = await h.request(projectId, [text], undefined, MODEL);
    let turns = 1;
    while (!r.ready.at(-1) && turns < 3) {
      r = await h.request(projectId, [NUDGE], r.threadId);
      turns++;
    }
    expect(r.ready.at(-1), `the draft never became ready: ${r.replies.at(-1)}`).toBe(true);
    const task = await h.api<{ id: string; key: string; model?: string }>('POST', `/api/threads/${r.threadId}/create-task`);
    expect(task.model).toBe(MODEL);
    return { ...task, turns };
  }

  /** Spec review, handling what a real model may do: propose a split, or leave open questions. */
  async function approveSpec(id: string): Promise<Detail> {
    let d = await h.waitFor(id, 'spec review', (x) => (x.task.state === 'SPEC_REVIEW' && Boolean(x.spec)) || (x.task.state === 'BLOCKED' && x.task.blockedReason === 'split-proposed'), { ms: 900_000, allowBlocked: true });
    if (d.task.state === 'BLOCKED') {
      await h.api('POST', `/api/tasks/${id}/override-split`, { reason: 'One small health check: keep it as one task.' });
      d = await h.waitFor(id, 'spec review', (x) => x.task.state === 'SPEC_REVIEW' && Boolean(x.spec), { ms: 900_000 });
    }
    if (d.specCheck?.openQuestions.length) {
      await h.api('POST', `/api/tasks/${id}/request-changes`, { feedback: 'Answer the open questions with sensible defaults and remove them.' });
      d = await h.waitFor(id, 'the redrafted spec', (x) => x.task.state === 'SPEC_REVIEW' && (x.spec?.version ?? 0) > 1, { ms: 900_000 });
    }
    await h.approveBoth(id);
    return d;
  }

  async function run(scenario: string, projectId: string, text: string, prCount: number): Promise<Detail> {
    const started = Date.now();
    let taskId = '';
    let d: Detail;
    try {
      const task = await fromChat(projectId, text);
      taskId = task.id;
      await approveSpec(task.id);
      d = await h.waitFor(task.id, `${prCount} PR(s)`, (x) => x.task.state === 'PR_OPEN' && x.prs.length === prCount, { ms: 2_700_000 });
    } catch (err) {
      // Keep what it cost and where it stopped, then fail.
      const last = taskId ? await h.detail(taskId).catch(() => undefined) : undefined;
      const usage = await h.api<{ credits: { today: number } }>('GET', '/api/usage').catch(() => undefined);
      summary.push({ scenario, task: last?.task.key, state: last?.task.state, blocked: last?.task.blockedMessage, credits: last?.usage.aiCredits, creditsToday: usage?.credits.today, minutes: Math.round((Date.now() - started) / 6000) / 10, error: String(err).slice(0, 600) });
      throw err;
    }
    const verify = d.verifyRuns.map((v) => v.passed);
    const row = {
      scenario,
      task: d.task.key,
      model: d.task.model,
      minutes: Math.round((Date.now() - started) / 6000) / 10,
      credits: Math.round(d.usage.aiCredits * 100) / 100,
      prompts: d.usage.prompts,
      modelCalls: d.usage.modelCalls,
      verify,
      tests: d.tests.map((t) => `${t.criterion}:${t.result}`),
      findings: d.findings.map((f) => `${f.severity}/${f.status}: ${f.title}`),
      needsAttention: d.task.needsAttention,
      attentionNotes: d.task.attentionNotes,
      states: d.transitions.map((t) => t.to),
    };
    summary.push(row);
    h.record(scenario, d, row);
    expect(d.task.model).toBe(MODEL);
    expect(d.usage.aiCredits).toBeLessThanOrEqual(Number(PER_TASK) + 1);
    for (const pr of d.prs) {
      expect(pr.description).toContain('## Acceptance criteria');
      if (REAL) expect(pr.status).toBe('open');
      else expect(pr.status).toBe('manual-pending');
    }
    if (prCount === 2) expect(d.prs.every((p) => d.prs.every((o) => o.id === p.id || p.description.includes(o.url)))).toBe(true);
    return d;
  }

  it('(a) one full-stack repo: chat request to a reviewed pull request', async () => {
    const repo = await h.addRepo('fullstack');
    const p = await h.project('Live shop', [repo.id], 'LIVE');
    await run('(a) full-stack, live Copilot', p.id, FULLSTACK, 1);
  }, 3_600_000);

  it('(b) separate frontend and backend: two linked pull requests', async () => {
    const be = await h.addRepo('backend');
    const fe = await h.addRepo('frontend');
    const p = await h.project('Live duo', [be.id, fe.id], 'LDUO');
    await run('(b) frontend + backend, live Copilot', p.id, DUO, 2);
  }, 3_600_000);
});
