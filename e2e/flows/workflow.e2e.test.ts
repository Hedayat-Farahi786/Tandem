/**
 * Phase 4: every row of the end-to-end table, through the real server and its HTTP API, started
 * from chat Request mode. Scripted agent (no Copilot). Local remotes by default; real CodeCommit
 * with TANDEM_E2E_REAL=1 TANDEM_AWS_PROFILE=<profile>.
 *
 *   pnpm build && pnpm test:flows
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, REAL, repoName, type Detail } from './harness.js';

const REQUEST = "Add a GET /health endpoint returning {status: 'ok'} and show the status on the main page.";
const ANSWER = 'Show "Checking status…" while loading and "Status unavailable" if it fails. Authentication and metrics are out of scope.';
const BIG = 'Add a GET /health endpoint, a metrics dashboard, CSV export of orders and email alerts when the service is down.';
const FAILING_TEST = "import { expect, it } from 'vitest';\n\nit('an upstream regression', () => {\n  expect(1 + 1).toBe(3);\n});\n";

const h = new Harness();
const ids: { shop: string; duo: string } = { shop: '', duo: '' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Request mode as a person uses it: the request, Tandem's questions, the answer, then the task. */
async function fromChat(projectId: string, request = REQUEST): Promise<{ id: string; key: string }> {
  const first = await h.request(projectId, [request]);
  expect(first.ready).toEqual([false]);
  expect(first.replies[0]).toMatch(/\?/);
  await expect(h.api('POST', `/api/threads/${first.threadId}/create-task`)).rejects.toThrow(/Not ready yet/);
  const second = await h.request(projectId, [ANSWER], first.threadId);
  expect(second.ready).toEqual([true]);
  const task = await h.api<{ id: string; key: string; source: string; state: string }>('POST', `/api/threads/${first.threadId}/create-task`);
  expect(task.source).toBe('chat');
  return task;
}

const reviewReady = (id: string) => h.waitFor(id, 'spec review', (d) => d.task.state === 'SPEC_REVIEW' && Boolean(d.spec));
const prsOpen = (id: string, n: number, ms = 420_000) => h.waitFor(id, `${n} PR(s)`, (d) => d.task.state === 'PR_OPEN' && d.prs.length === n && (n < 2 || d.prs.every((p) => d.prs.every((o) => o.id === p.id || p.description.includes(o.url)))), { ms });
const states = (d: Detail) => d.transitions.map((t) => t.to);

function expectPr(d: Detail) {
  for (const pr of d.prs) {
    expect(pr.title).toBe(`${d.task.needsAttention ? '[needs attention] ' : ''}${d.task.key}: ${d.task.title}`);
    expect(pr.description).toContain('## Acceptance criteria');
    expect(pr.description).toContain('## Verification');
    if (REAL) {
      // The profile may create PRs: Tandem opens them itself.
      expect(pr.status).toBe('open');
      expect(pr.url).toMatch(new RegExp(`^https://${process.env.TANDEM_AWS_REGION || 'eu-central-1'}\\.console\\.aws\\.amazon\\.com/codesuite/codecommit/repositories/[\\w-]+/pull-requests/\\d+`));
    } else {
      // Local remotes answer "access denied" for the PR API: a prefilled console link instead.
      expect(pr).toMatchObject({ status: 'manual-pending', manual: true });
      expect(pr.url).toContain(`/pull-requests/new/refs/heads/${h.base}/.../refs/heads/${d.task.branch}`);
    }
  }
}

beforeAll(async () => {
  await h.prepareRemotes(['fullstack', 'backend', 'frontend']);
  await h.start();
  const fullstack = await h.addRepo('fullstack');
  const backend = await h.addRepo('backend');
  const frontend = await h.addRepo('frontend');
  ids.shop = (await h.project('Shop', [fullstack.id], 'SHOP')).id;
  ids.duo = (await h.project('Shop (two repos)', [backend.id, frontend.id], 'DUO')).id;
}, 300_000);

afterAll(async () => {
  await h.stop();
  h.cleanup();
  console.warn(`Flows (${REAL ? `real CodeCommit, base ${h.base}` : 'local remotes'}): results in ${join(h.work, 'results.json')}, server log ${h.logFile}`);
});

describe(`Phase 4 flows · scripted agent · ${REAL ? 'real CodeCommit' : 'local remotes'}`, () => {
  it('(a) one full-stack repo, with clarifying questions: spec → both keys → build → verify → self-review → PR', async () => {
    const baseBefore = h.remoteBranches('fullstack').get(h.base);
    const task = await fromChat(ids.shop);
    let d = await reviewReady(task.id);
    expect(d.spec!.version).toBe(1);
    expect(d.specCheck).toMatchObject({ valid: true, openQuestions: [] });
    // One key is not enough.
    await h.api('POST', `/api/tasks/${task.id}/approve`, {});
    await sleep(2_500);
    d = await h.detail(task.id);
    expect(d.task.state).toBe('SPEC_REVIEW');
    expect(d.approvalState).toMatchObject({ owner: { specVersion: 1 }, complete: false });
    await h.api('POST', `/api/tasks/${task.id}/pm-approval`, { name: 'Pat Lee', date: new Date().toISOString(), evidence: 'Approved in the planning channel' });

    d = await prsOpen(task.id, 1);
    expect(states(d)).toEqual(['DRAFT', 'READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN']);
    expect(d.verifyRuns).toHaveLength(1);
    expect(d.verifyRuns[0]!.passed).toBe(true);
    expect(d.verifyRuns[0]!.results.map((r) => r.kind)).toEqual(expect.arrayContaining(['install', 'lint', 'typecheck', 'build', 'test', 'test-single']));
    expect([...new Set(d.tests.filter((t) => t.result === 'pass').map((t) => t.criterion))].sort()).toEqual([1, 2]);
    expect(d.task.needsAttention).toBe(false);
    expectPr(d);
    const branches = h.remoteBranches('fullstack');
    expect(branches.has(d.task.branch)).toBe(true);
    expect(branches.get(h.base)).toBe(baseBefore);
    expect(h.remoteFile('fullstack', d.task.branch, 'src/server/app.ts')).toContain("app.get('/health'");
    // Traceability: the commit the audit log records is the one on the remote branch, each
    // criterion has a passing test, both approvals belong to the approved version, and the chain verifies.
    const trace = await h.api<{
      criteria: Array<{ status: string; tests: unknown[] }>;
      specs: Array<{ version: number; status: string; approvals: Array<{ role: string; name: string }> }>;
      commits: Array<{ commit: string; branch: string }>;
      pullRequests: Array<{ status: string }>;
      audit: Array<{ action: string }>;
      integrity: { ok: boolean };
    }>('GET', `/api/tasks/${task.id}/trace`);
    expect(trace.criteria.map((c) => c.status)).toEqual(['pass', 'pass']);
    expect(trace.specs).toEqual([expect.objectContaining({ version: 1, status: 'approved', approvals: [expect.objectContaining({ role: 'owner' }), expect.objectContaining({ role: 'pm', name: 'Pat Lee' })] })]);
    expect(trace.commits).toEqual([expect.objectContaining({ branch: d.task.branch, commit: branches.get(d.task.branch) })]);
    expect(trace.audit.map((e) => e.action)).toEqual(expect.arrayContaining(['task.created', 'spec.approved', 'git.pushed', 'task.state']));
    expect(trace.audit.some((e) => e.action === 'pr.prepared' || e.action === 'pr.opened')).toBe(true);
    expect(trace.integrity.ok).toBe(true);
    expect(await h.api('GET', '/api/audit/verify')).toMatchObject({ ok: true });
    h.record('(a) one full-stack repo', d);
  });

  it('(b) separate backend and frontend repos: an API contract and two linked PRs', async () => {
    const task = await fromChat(ids.duo);
    let d = await reviewReady(task.id);
    expect(d.spec!.markdown).toMatch(/## API contract\n\nRequest:/);
    await h.approveBoth(task.id);
    d = await prsOpen(task.id, 2);
    expect(d.verifyRuns.at(-1)!.passed).toBe(true);
    expectPr(d);
    const [a, b] = d.prs;
    expect(a!.description).toContain(b!.url);
    expect(b!.description).toContain(a!.url);
    for (const shape of ['backend', 'frontend'] as const) expect(h.remoteBranches(shape).has(d.task.branch)).toBe(true);
    h.record('(b) separate frontend and backend repos', d);
  });

  it('too big: a split is proposed and accepted into smaller tasks, or overridden with a reason', async () => {
    const big = await fromChat(ids.shop, BIG);
    let d = await h.waitFor(big.id, 'split proposal', (x) => x.task.state === 'BLOCKED' && x.task.blockedReason === 'split-proposed', { allowBlocked: true });
    expect(d.task.sizeEstimate).toMatchObject({ estimatedLines: 880 });
    expect(d.task.blockedMessage).toContain('Proposed split:');
    const children = await h.api<Array<{ id: string; key: string; source: string; parentTaskId: string }>>('POST', `/api/tasks/${big.id}/accept-split`);
    expect(children).toHaveLength(4);
    expect(children.every((c) => c.source === 'split' && c.parentTaskId === big.id)).toBe(true);
    d = await h.detail(big.id);
    expect(d.task.state).toBe('CANCELLED');
    expect(d.transitions.at(-1)!.reason).toBe(`Split into ${children.map((c) => c.key).join(', ')}.`);
    // Each part goes through readiness and gets its own spec.
    for (const c of children) await reviewReady(c.id);
    for (const c of children) await h.api('POST', `/api/tasks/${c.id}/cancel`, {});

    const kept = await fromChat(ids.shop, BIG);
    await h.waitFor(kept.id, 'split proposal', (x) => x.task.blockedReason === 'split-proposed', { allowBlocked: true });
    await h.api('POST', `/api/tasks/${kept.id}/override-split`, { reason: 'The dashboard and the export ship together for the launch.' });
    d = await reviewReady(kept.id);
    expect(d.transitions.some((t) => t.reason === 'Size check overridden: The dashboard and the export ship together for the launch.')).toBe(true);
    await h.api('POST', `/api/tasks/${kept.id}/cancel`, {});
  });

  it('request changes from the task chat redrafts the spec; a spec edit resets approvals', async () => {
    const task = await fromChat(ids.shop);
    let d = await reviewReady(task.id);
    expect(d.spec!.version).toBe(1);
    const thread = await h.api<{ id: string }>('GET', `/api/tasks/${task.id}/thread`);
    const r = await h.request(ids.shop, ['Can the endpoint also return the app version?'], thread.id);
    expect(r.replies[0]).toContain('confirm it to redraft');
    const view = await h.api<{ thread: { pendingSpecChange?: { kind: string } } }>('GET', `/api/threads/${thread.id}`);
    expect(view.thread.pendingSpecChange?.kind).toBe('redraft');
    await h.api('POST', `/api/threads/${thread.id}/spec-change/apply`);
    d = await h.waitFor(task.id, 'spec version 2', (x) => x.task.state === 'SPEC_REVIEW' && x.spec?.version === 2);
    expect(d.spec!.markdown).toContain('Can the endpoint also return the app version?');
    expect(d.specs.map((s) => s.source)).toEqual(['draft', 'redraft']);

    await h.api('POST', `/api/tasks/${task.id}/approve`, {});
    d = await h.detail(task.id);
    expect(d.approvalState?.owner?.specVersion).toBe(2);
    await h.api('PUT', `/api/tasks/${task.id}/spec`, { markdown: d.spec!.markdown.replace('## Rollout notes\n\n', '## Rollout notes\n\nMention the endpoint in the changelog. ') });
    d = await h.detail(task.id);
    expect(d.spec!.version).toBe(3);
    expect(d.specs.at(-1)!.source).toBe('edit');
    expect(d.approvalState?.owner).toBeUndefined();
    expect(d.task.state).toBe('SPEC_REVIEW');

    await h.approveBoth(task.id);
    d = await h.waitFor(task.id, 'the build to start on version 3', (x) => ['BUILDING', 'VERIFYING'].includes(x.task.state));
    expect(d.approvalState).toMatchObject({ owner: { specVersion: 3 }, pm: { specVersion: 3 }, complete: true });
    await h.api('POST', `/api/tasks/${task.id}/cancel`, {});
    await h.waitFor(task.id, 'cancelled', (x) => x.task.state === 'CANCELLED');
  });

  it('cancel while verifying: the work stops, the task folder goes, nothing is pushed', async () => {
    const task = await fromChat(ids.shop);
    await reviewReady(task.id);
    await h.approveBoth(task.id);
    await h.waitFor(task.id, 'verification', (x) => x.task.state === 'VERIFYING');
    await sleep(1_500);
    await h.api('POST', `/api/tasks/${task.id}/cancel`, {});
    await h.waitFor(task.id, 'cancelled', (x) => x.task.state === 'CANCELLED');
    const folder = join(h.home, 'tasks', task.id, repoName('fullstack'));
    const end = Date.now() + 90_000;
    while (existsSync(folder) && Date.now() < end) await sleep(500);
    expect(existsSync(folder)).toBe(false);
    await sleep(3_000);
    const d = await h.detail(task.id);
    expect(d.task.state).toBe('CANCELLED');
    expect(d.prs).toHaveLength(0);
    expect(h.remoteBranches('fullstack').has(d.task.branch)).toBe(false);
  });

  it('restart mid-build: kill -9 during verification, start again, the task resumes and finishes', async () => {
    const task = await fromChat(ids.shop);
    await reviewReady(task.id);
    await h.approveBoth(task.id);
    await h.waitFor(task.id, 'verification', (x) => x.task.state === 'VERIFYING');
    await sleep(2_000);
    h.kill();
    await sleep(1_000);
    await h.start();
    const d = await prsOpen(task.id, 1);
    expect(h.starts).toBe(2);
    expect(d.verifyRuns.at(-1)!.passed).toBe(true);
    expect(states(d)).toEqual(['DRAFT', 'READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN']);
    expectPr(d);
    h.record('restart mid-build', d);
  });

  it('rebase conflict: the base branch moves under the task; the agent resolves it and checks run again', async () => {
    const task = await fromChat(ids.shop);
    await reviewReady(task.id);
    await h.approveBoth(task.id);
    await h.waitFor(task.id, 'verification', (x) => x.task.state === 'VERIFYING');
    // Another developer adds a route at the same place the agent did.
    h.upstream('fullstack', 'src/server/app.ts', (src) => src!.replace(/\n(\s*)return app;/, "\n$1app.get('/version', async () => ({ version: '1.0.0' }));\n$1return app;"), 'Add GET /version');
    const d = await prsOpen(task.id, 1);
    expect(d.runs.some((r) => r.kind === 'conflict' && r.status === 'succeeded')).toBe(true);
    expect(d.verifyRuns.length).toBeGreaterThanOrEqual(2);
    expect(d.verifyRuns.at(-1)!.passed).toBe(true);
    const merged = h.remoteFile('fullstack', d.task.branch, 'src/server/app.ts');
    expect(merged).toContain("app.get('/health'");
    expect(merged).toContain("app.get('/version'");
    expect(merged).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expectPr(d);
    h.record('rebase conflict', d);
  });

  it('conflict after the PR is open: the base changes under the open PR; Tandem merges it in, resolves, checks and pushes without force', async () => {
    const task = await fromChat(ids.shop);
    await reviewReady(task.id);
    await h.approveBoth(task.id);
    const open = await prsOpen(task.id, 1);
    const before = h.remoteBranches('fullstack').get(open.task.branch)!;
    // Merged elsewhere while the PR waits for review: a route at the same place the agent added one.
    h.upstream('fullstack', 'src/server/app.ts', (src) => src!.replace(/\n(\s*)return app;/, "\n$1app.get('/ready', async () => ({ ready: true }));\n$1return app;"), 'Add GET /ready');
    // The 5-minute PR check would find it; "Fix conflicts" runs that check now.
    await h.api('POST', `/api/tasks/${task.id}/fix-conflicts`);
    const d = await h.waitFor(task.id, 'PR updated from main', (x) => x.prs[0]?.sync?.state === 'updated', { ms: 300_000 });
    expect(d.task.state).toBe('PR_OPEN');
    expect(d.prs[0]!.sync!.files).toEqual(['src/server/app.ts']);
    const after = h.remoteBranches('fullstack').get(d.task.branch)!;
    expect(after).not.toBe(before);
    expect(h.gitLog('fullstack', d.task.branch, `${before}..${after}`)).toMatch(/^Merge \S+ into agent\//m); // a merge commit on top: nothing rewritten
    expect(h.isAncestorOnRemote('fullstack', d.task.branch, before, after)).toBe(true);
    const merged = h.remoteFile('fullstack', d.task.branch, 'src/server/app.ts');
    expect(merged).toContain("app.get('/health'");
    expect(merged).toContain("app.get('/ready'");
    expect(merged).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(d.verifyRuns.at(-1)!.passed).toBe(true);
    expect(d.prs[0]!.description).toContain('| Check | Command | Result | Time |');
    h.record('conflict after the PR is open', d);
  });

  it('failing tests: two fix attempts, then a PR marked "needs attention"', async () => {
    h.upstream('fullstack', 'test/upstream-regression.test.ts', () => FAILING_TEST, 'Add a failing test');
    try {
      const task = await fromChat(ids.shop);
      await reviewReady(task.id);
      await h.approveBoth(task.id);
      const d = await prsOpen(task.id, 1, 600_000);
      expect(d.task.needsAttention).toBe(true);
      expect(d.task.attentionNotes.join('\n')).toMatch(/test/);
      expect(d.verifyRuns.map((v) => v.passed)).toEqual([false, false, false]);
      expect(d.runs.filter((r) => r.kind === 'fix')).toHaveLength(2);
      expect(d.prs[0]!.title.startsWith('[needs attention] ')).toBe(true);
      expect(d.prs[0]!.description).toContain('**Needs attention.**');
      expectPr(d);
      h.record('failing tests → needs attention', d);
    } finally {
      h.upstream('fullstack', 'test/upstream-regression.test.ts', () => null, 'Remove the failing test');
    }
  });
});
