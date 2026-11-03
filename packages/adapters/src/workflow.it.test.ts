import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Requirement, type Project, type Repo } from '@tandem/shared';
import { ScriptedAgent, type ScriptCall, type ScriptReply } from '@tandem/core/testing';
import { createTandem, type Tandem } from './compose.js';
import { git } from './git/git.js';
import { plainAccess } from './git/repo-git.js';
import { MemorySecrets } from './secrets/keychain.js';

const ID = ['-c', 'user.name=Upstream', '-c', 'user.email=up@example.com'];
const SKIP = process.platform === 'win32'; // repo commands below use POSIX `test`

const REQUIREMENT = Requirement.parse({
  goal: 'Expose service health and show it on the main page',
  userStory: 'As an operator I want to see whether the service is up',
  criteria: [
    { given: 'the backend is running', when: 'GET /health is called', then: 'it returns 200 {"status":"ok"}' },
    { given: 'the main page loads', when: 'the health call succeeds', then: 'the page shows "Status: ok"' },
  ],
  exampleData: 'GET /health -> 200 {"status":"ok"}',
  affectedAreas: 'API routes, main page',
  outOfScope: 'Authentication, metrics',
});

const SPEC = readFileSync(join(import.meta.dirname, '..', '..', 'core', 'src', '__tests__', 'fixtures.ts'), 'utf8').match(/`(# Add a health endpoint[\s\S]*?)`;/)![1]!.replace(/\\`/g, '`');

async function makeRemote(root: string, name: string) {
  const bare = join(root, 'remotes', `${name}.git`);
  await git(['init', '--bare', bare]);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { gitDir: bare });
  const seed = join(root, 'seed', name);
  await git(['clone', pathToFileURL(bare).href, seed]);
  await git(['checkout', '-b', 'main'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), `# ${name}\n\nOriginal line.\n`);
  await git(['add', '.'], { cwd: seed });
  await git([...ID, 'commit', '-m', 'init'], { cwd: seed });
  await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: seed });
  return { bare, url: pathToFileURL(bare).href, seed };
}

/** Upstream work on main (another developer), in the seed clone. */
async function upstream(seed: string, file: string, content: string) {
  await git(['pull', '--ff-only', 'origin', 'main'], { cwd: seed });
  writeFileSync(join(seed, file), content);
  await git(['add', '.'], { cwd: seed });
  await git([...ID, 'commit', '-m', `upstream ${file}`], { cwd: seed });
  await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: seed });
}

/** A reviewer merges the agent branch into main. */
async function mergeBranch(seed: string, branch: string) {
  await git(['fetch', 'origin'], { cwd: seed });
  await git(['checkout', 'main'], { cwd: seed });
  await git(['pull', '--ff-only', 'origin', 'main'], { cwd: seed });
  await git([...ID, 'merge', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`], { cwd: seed });
  await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: seed });
}

interface Scenario {
  shape: 'single' | 'split';
  testCommand?: string;
  onImplement?: (repo: string) => Promise<void>;
  conflict?: (call: ScriptCall) => ScriptReply;
}

const opened: Tandem[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) await t.close().catch(() => undefined);
});

async function setup(s: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'tandem-wf-it-'));
  const names = s.shape === 'split' ? ['backend', 'frontend'] : ['app'];
  const remotes = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await makeRemote(root, n)] as const)));
  const script = async (call: ScriptCall): Promise<ScriptReply> => {
    const p = call.prompt;
    if (p.startsWith('Estimate the size')) return { value: { estimatedLines: 60, perRepo: [], features: ['health'], proposedSplit: [], rationale: 'small' } };
    if (p.startsWith('Write the implementation spec')) return { text: SPEC };
    if (p.startsWith('Review this change')) return { value: { findings: [] } };
    if (p.startsWith('Implement the approved spec')) {
      const repo = /in the `([^`]+)` repo/.exec(p)![1]!;
      await s.onImplement?.(repo);
      return {
        text: `Implemented ${repo}`,
        edits: [
          { path: `${repo}/src/health.js`, content: "export const health = () => ({ status: 'ok' });\n" },
          { path: `${repo}/test/health.test.js`, content: "// criterion 1 and 2\n" },
          { path: `${repo}/README.md`, content: `# ${repo}\n\nAgent line.\n` },
        ],
        tools: [1, 2].map((n) => ({ name: 'tandem_record_test', args: { criterion: n, repo, file: 'test/health.test.js', name: `criterion ${n}` } })),
      };
    }
    if (p.startsWith('Verification failed')) return { text: 'Tried.' };
    if (p.startsWith('Rebasing')) return s.conflict?.(call) ?? { text: 'nothing' };
    throw new Error(`unrouted prompt: ${p.slice(0, 60)}`);
  };
  const agent = new ScriptedAgent(script);
  const denied = Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' });
  const make = (bootId: string) =>
    createTandem({
      home: join(root, 'home'),
      agent,
      secrets: new MemorySecrets(),
      bootId,
      codecommit: {
        accessOverride: (repo) => plainAccess(remotes[repo.name]!.url),
        api: () => ({ send: async () => Promise.reject(denied) }),
      },
    });
  const t = await make('boot-1');
  opened.push(t);
  const now = new Date().toISOString();
  const repos: Repo[] = names.map((n) => ({
    id: `r-${n}`,
    url: `codecommit::eu-central-1://${n}`,
    host: { kind: 'codecommit', region: 'eu-central-1', name: n },
    name: n,
    defaultBranch: 'main',
    role: n === 'frontend' ? 'frontend' : n === 'backend' ? 'backend' : 'full-stack',
    commands: { install: 'true', lint: 'test -f README.md', test: s.testCommand ?? 'test -f src/health.js' },
    createdAt: now,
  }));
  for (const r of repos) await t.store.repos.upsert(r);
  const project: Project = {
    id: 'p1',
    name: 'Sandbox',
    repoIds: repos.map((r) => r.id),
    contractOrder: s.shape === 'split' ? ['r-backend', 'r-frontend'] : ['r-app'],
    specRepoId: s.shape === 'split' ? 'r-backend' : 'r-app',
    pmGate: 'tandem',
    pmNames: ['Pat'],
    jiraPmAccountIds: [],
    keyPrefix: 'TND',
    createdAt: now,
  };
  await t.store.projects.upsert(project);
  return { root, remotes, agent, t, make, repos, project };
}

async function toPrOpen(t: Tandem) {
  const task = await t.service.create({ projectId: 'p1', title: 'Add a GET /health endpoint', requirement: REQUIREMENT });
  await t.service.submit(task.id);
  await t.runner.runUntilIdle();
  expect((await t.store.tasks.get(task.id))!.state).toBe('SPEC_REVIEW');
  await t.service.approve(task.id, 'Owner');
  await t.service.recordPmApproval(task.id, { name: 'Pat', date: new Date().toISOString(), evidence: 'Approved in the team channel' });
  await t.runner.runUntilIdle();
  return (await t.store.tasks.get(task.id))!;
}

async function wakePoll(t: Tandem, taskId: string) {
  const job = await t.store.jobs.get(taskId);
  if (job) await t.store.jobs.upsert({ ...job, notBefore: Date.now() });
  await t.runner.runUntilIdle();
}

describe.skipIf(SKIP)('workflow on real git (SQLite, local remotes, scripted agent)', () => {
  it('one full-stack repo: request to merged PR, with the spec committed and the default branch untouched', async () => {
    const { t, remotes } = await setup({ shape: 'single' });
    const mainBefore = await git(['rev-parse', 'refs/heads/main'], { gitDir: remotes.app!.bare });
    const task = await toPrOpen(t);
    expect(task.state).toBe('PR_OPEN');
    expect(task.needsAttention).toBe(false);

    // The branch exists on the remote with the work and the spec; main did not move.
    expect(await git(['rev-parse', 'refs/heads/main'], { gitDir: remotes.app!.bare })).toBe(mainBefore);
    const files = await git(['ls-tree', '-r', '--name-only', `refs/heads/${task.branch}`], { gitDir: remotes.app!.bare });
    expect(files.split('\n').sort()).toEqual(['README.md', 'specs/TND-1-add-a-get-health-endpoint.md', 'src/health.js', 'test/health.test.js']);
    const log = await git(['log', '--format=%s', `refs/heads/${task.branch}`], { gitDir: remotes.app!.bare });
    expect(log.split('\n')[0]).toBe('feat(TND-1): Add a GET /health endpoint');

    // No AWS permission: a console-link PR with a ready description.
    const prs = await t.store.prs.list(task.id);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ manual: true, status: 'manual-pending' });
    expect(prs[0]!.url).toContain('/pull-requests/new/refs/heads/main/.../refs/heads/agent/TND-1-add-a-get-health-endpoint');
    expect(prs[0]!.description).toContain('| Criterion | Test | Result |');
    expect(prs[0]!.description).toContain('✅ pass');
    const comments = await t.store.trackerComments.list(task.key);
    expect(comments.at(-1)!.body).toContain('Pull requests for TND-1 are ready for review');

    // A reviewer merges; the poller notices through git and finishes the task.
    await mergeBranch(remotes.app!.seed, task.branch);
    await wakePoll(t, task.id);
    const done = (await t.store.tasks.get(task.id))!;
    expect(done.state).toBe('DONE');
    expect(existsSync(t.paths.taskDir(task.id))).toBe(false);
    expect((await t.store.transitions.list(task.id)).map((x) => x.to)).toEqual(['DRAFT', 'READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN', 'DONE']);
  });

  it('separate backend and frontend repos: contract order, two PRs, spec in the backend', async () => {
    const { t, remotes, agent } = await setup({ shape: 'split' });
    const task = await toPrOpen(t);
    expect(task.state).toBe('PR_OPEN');
    const order = agent.calls.filter((c) => c.prompt.startsWith('Implement')).map((c) => /in the `([^`]+)`/.exec(c.prompt)![1]);
    expect(order).toEqual(['backend', 'frontend']);
    for (const n of ['backend', 'frontend']) {
      const files = await git(['ls-tree', '-r', '--name-only', `refs/heads/${task.branch}`], { gitDir: remotes[n]!.bare });
      expect(files.includes('specs/TND-1-add-a-get-health-endpoint.md')).toBe(n === 'backend');
      expect(files).toContain('src/health.js');
    }
    const prs = await t.store.prs.list(task.id);
    expect(prs).toHaveLength(2);
    expect(prs.every((p) => p.description.includes('## Links'))).toBe(true);
    expect(prs.find((p) => p.repoId === 'r-backend')!.description).toContain('- frontend:');
  });

  it('resolves a real rebase conflict with upstream main, then pushes the rebased branch', async () => {
    let seed = '';
    const s = await setup({
      shape: 'single',
      onImplement: async () => upstream(seed, 'README.md', '# app\n\nUpstream line.\n'),
      conflict: (call) => ({ text: 'merged', edits: [{ path: 'app/README.md', content: '# app\n\nUpstream line.\nAgent line.\n' }], ...(call ? {} : {}) }),
    });
    seed = s.remotes.app!.seed;
    const task = await toPrOpen(s.t);
    expect(task.state).toBe('PR_OPEN');
    expect(s.agent.calls.some((c) => c.prompt.startsWith('Rebasing app onto the latest main hit conflicts in: README.md'))).toBe(true);
    const readme = await git(['show', `refs/heads/${task.branch}:README.md`], { gitDir: s.remotes.app!.bare });
    expect(readme).toBe('# app\n\nUpstream line.\nAgent line.');
    const base = await git(['merge-base', `refs/heads/${task.branch}`, 'refs/heads/main'], { gitDir: s.remotes.app!.bare });
    expect(base).toBe(await git(['rev-parse', 'refs/heads/main'], { gitDir: s.remotes.app!.bare }));
  });

  it('blocks with a clear message when the conflict is left unresolved', async () => {
    let seed = '';
    const s = await setup({ shape: 'single', onImplement: async () => upstream(seed, 'README.md', '# app\n\nUpstream line.\n'), conflict: () => ({ text: 'gave up' }) });
    seed = s.remotes.app!.seed;
    const task = await toPrOpen(s.t);
    expect(task.state).toBe('BLOCKED');
    expect(task.blockedReason).toBe('rebase-conflict');
    expect(task.blockedMessage).toContain('could not resolve README.md');
    expect(await git(['status', '--porcelain'], { cwd: join(s.t.paths.taskDir(task.id), 'app') })).toBe('');
  });

  it('continues with "needs attention" when the repo tests keep failing', async () => {
    const { t, agent } = await setup({ shape: 'single', testCommand: 'test -f src/never.js' });
    const task = await toPrOpen(t);
    expect(task.state).toBe('PR_OPEN');
    expect(task.needsAttention).toBe(true);
    expect(task.attentionNotes).toEqual(['app: test failed (`test -f src/never.js`, exit 1)']);
    expect(agent.calls.filter((c) => c.prompt.startsWith('Verification failed'))).toHaveLength(2);
    const pr = (await t.store.prs.list(task.id))[0]!;
    expect(pr.title).toMatch(/^\[needs attention\]/);
    const logs = (await t.store.verifyRuns.list(task.id)).flatMap((v) => v.results.map((r) => r.logPath!));
    expect(logs.every((p) => existsSync(p))).toBe(true);
  });

  it('survives a restart: the database is reopened and the runner recovers', async () => {
    const s = await setup({ shape: 'single' });
    const task = await s.t.service.create({ projectId: 'p1', title: 'Add a GET /health endpoint', requirement: REQUIREMENT });
    await s.t.service.submit(task.id);
    await s.t.runner.runUntilIdle();
    await s.t.service.approve(task.id, 'Owner');
    await s.t.service.recordPmApproval(task.id, { name: 'Pat', date: new Date().toISOString(), evidence: 'chat' });
    // Simulate a crash right after approval: a running lease from the old process.
    const job = (await s.t.store.jobs.get(task.id))!;
    await s.t.store.jobs.upsert({ ...job, status: 'running', leaseBootId: 'boot-1' });
    await s.t.close();
    opened.length = 0;

    const again = await s.make('boot-2');
    opened.push(again);
    expect(await again.runner.recover()).toEqual({ requeued: 1, created: 0 });
    await again.runner.runUntilIdle();
    const after = (await again.store.tasks.get(task.id))!;
    expect(after.state).toBe('PR_OPEN');
    expect((await again.store.transitions.list(task.id)).map((x) => x.to)).toContain('BUILDING');
  });
});
