/**
 * Real CodeCommit, no Copilot (the agent is scripted). Skipped unless TANDEM_REAL=1.
 *
 *   TANDEM_REAL=1 TANDEM_AWS_PROFILE=<profile> TANDEM_REAL_REPO=codecommit::<region>://<sandbox-repo> \
 *     pnpm vitest run --project integration packages/adapters/src/real-codecommit.it.test.ts
 *
 * Creates agent/it-* branches and pull requests in the sandbox repo, then closes the PRs and
 * deletes the branches. The default branch is never written to.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodeCommitClient, UpdatePullRequestStatusCommand } from '@aws-sdk/client-codecommit';
import { fromIni } from '@aws-sdk/credential-providers';
import { DEFAULT_SETTINGS, Requirement, type PullRequest, type Repo } from '@tandem/shared';
import { ScriptedAgent, type ScriptCall, type ScriptReply } from '@tandem/core/testing';
import { createTandem } from './compose.js';
import { runGit } from './git/git.js';
import { RepoGit } from './git/repo-git.js';
import { MemorySecrets } from './secrets/keychain.js';
import { CodeCommitHost, parseCodeCommitUrl } from './source-codecommit/codecommit-host.js';

const REAL = process.env.TANDEM_REAL === '1';
const URL = process.env.TANDEM_REAL_REPO ?? 'codecommit::eu-central-1://tandem-sandbox-backend';
const PROFILE = process.env.TANDEM_AWS_PROFILE;
const parsed = parseCodeCommitUrl(URL);
const id = randomUUID().slice(0, 8);

const repo = (createdAt = new Date().toISOString()): Repo => ({
  id: 'r-sandbox',
  url: URL,
  host: { kind: 'codecommit', region: parsed!.region, name: parsed!.name, ...(parsed?.profile ? { profile: parsed.profile } : {}) },
  name: parsed!.name,
  defaultBranch: 'main',
  role: 'backend',
  commands: { install: 'npm ci --no-audit --no-fund', lint: 'npm run lint', typecheck: 'npm run typecheck', build: 'npm run build', test: 'npm test' },
  createdAt,
});

const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const c of cleanup.reverse()) await c().catch((err: unknown) => console.warn('cleanup failed', err));
});

const api = () => new CodeCommitClient({ region: parsed!.region, credentials: fromIni(PROFILE ? { profile: PROFILE } : {}) });
const closePr = (prId: string) => () => api().send(new UpdatePullRequestStatusCommand({ pullRequestId: prId, pullRequestStatus: 'CLOSED' }));
const deleteBranch = (mirror: string, branch: string) => () => runGit(['push', 'origin', '--delete', `refs/heads/${branch}`], { gitDir: mirror, allowFail: true });

describe.skipIf(!REAL)('real CodeCommit (scripted agent, no Copilot)', () => {
  it('host: preflight, mirror, push, idempotent PR, status, description, close', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tandem-real-'));
    const settings = async () => ({ ...DEFAULT_SETTINGS, aws: { profile: PROFILE ?? '', region: '' } });
    let host!: CodeCommitHost;
    const git = new RepoGit((r) => host.mirrorPath(r));
    host = new CodeCommitHost({ home, git, settings });
    const r = repo();

    const checks = await host.preflight(r);
    expect(checks.map((c) => [c.label, c.status])).toEqual([
      [`Read ${r.name}`, 'pass'],
      ['AWS credentials', 'pass'],
      ['Create pull requests', 'pass'],
    ]);

    const info = await host.mirror(r);
    expect(info.defaultBranch).toBe('main');
    const branch = `agent/it-${id}-host`;
    const wt = await host.createWorktree(r, { path: join(home, 'tasks', id, r.name), branch });
    writeFileSync(join(wt.path, `IT-${id}.md`), `integration ${id}\n`);
    await git.commitAll(wt.path, `test: integration ${id}`);
    const pushed = await host.push(r, wt);
    expect(pushed.kind).toBe('pushed');
    cleanup.push(deleteBranch(info.path, branch));

    const req = { repo: r, sourceBranch: branch, destinationBranch: 'main', title: `Tandem integration ${id}`, description: 'Created by the Tandem integration test. Safe to close.', idempotencyKey: `it-${id}` };
    const pr1 = await host.openPullRequest(req);
    expect(pr1.kind).toBe('created');
    if (pr1.kind !== 'created') return;
    cleanup.push(closePr(pr1.providerId));
    const pr2 = await host.openPullRequest(req);
    expect(pr2).toEqual(pr1);
    const pr: PullRequest = { id: 'p', taskId: 't', repoId: r.id, providerId: pr1.providerId, url: pr1.url, title: req.title, description: req.description, status: 'open', manual: false, createdAt: '' };
    expect(await host.getPullRequestStatus(r, pr)).toBe('open');
    await host.updatePullRequestDescription(r, pr, 'Updated by the integration test.');
    await closePr(pr1.providerId)();
    expect(await host.getPullRequestStatus(r, pr)).toBe('closed');
  });

  it('workflow: request to a real PR with the sandbox npm checks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tandem-real-wf-'));
    const write = async (base: string, rel: string, content: string) => {
      await mkdir(dirname(join(base, rel)), { recursive: true });
      writeFileSync(join(base, rel), content);
    };
    const name = parsed!.name;
    const script = async (call: ScriptCall): Promise<ScriptReply> => {
      const p = call.prompt;
      if (p.startsWith('Estimate the size')) return { value: { estimatedLines: 40, perRepo: [], features: ['health'], proposedSplit: [], rationale: 'small' } };
      if (p.startsWith('Write the implementation spec')) {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(join(import.meta.dirname, '..', '..', 'core', 'src', '__tests__', 'fixtures.ts'), 'utf8');
        return { text: src.match(/`(# Add a health endpoint[\s\S]*?)`;/)![1]!.replace(/\\`/g, '`') };
      }
      if (p.startsWith('Review this change')) return { value: { findings: [] } };
      if (p.startsWith('Implement the approved spec')) {
        await write(call.opts.workspace, `${name}/src/health.ts`, "export interface Health {\n  status: 'ok';\n}\n\nexport function health(): Health {\n  return { status: 'ok' };\n}\n");
        await write(call.opts.workspace, `${name}/test/health.test.ts`, "import { describe, expect, it } from 'vitest';\nimport { health } from '../src/health.js';\n\ndescribe('health', () => {\n  it('is ok', () => {\n    expect(health()).toEqual({ status: 'ok' });\n  });\n});\n");
        return { text: 'Added health.', tools: [1, 2].map((n) => ({ name: 'tandem_record_test', args: { criterion: n, repo: name, file: 'test/health.test.ts', name: 'health is ok' } })) };
      }
      if (p.startsWith('Verification failed')) return { text: 'no change' };
      throw new Error(`unrouted: ${p.slice(0, 60)}`);
    };
    const t = await createTandem({ home, agent: new ScriptedAgent(script), secrets: new MemorySecrets(), overrides: PROFILE ? { 'aws.profile': PROFILE } : {} });
    cleanup.push(() => t.close());
    const r = repo();
    await t.store.repos.upsert(r);
    await t.store.projects.upsert({ id: 'p', name: 'Sandbox', repoIds: [r.id], contractOrder: [r.id], specRepoId: r.id, pmGate: 'tandem', pmNames: [], jiraPmAccountIds: [], keyPrefix: 'IT', createdAt: r.createdAt });
    const task = await t.service.create({ projectId: 'p', title: `Health check ${id}`, requirement: Requirement.parse({ goal: 'Expose health', userStory: 'As an operator I want health', criteria: [{ given: 'the service runs', when: 'health() is called', then: 'it returns ok' }, { given: 'a test run', when: 'tests run', then: 'health is covered' }], exampleData: '{"status":"ok"}', affectedAreas: 'src/health.ts', outOfScope: 'HTTP route' }) });
    await t.service.submit(task.id);
    await t.runner.runUntilIdle();
    await t.service.approve(task.id, 'Owner');
    await t.service.recordPmApproval(task.id, { name: 'PM', date: new Date().toISOString(), evidence: 'integration test' });
    await t.runner.runUntilIdle();
    const done = (await t.store.tasks.get(task.id))!;
    cleanup.push(deleteBranch(t.codecommit.mirrorPath(r), done.branch));
    const prs = await t.store.prs.list(task.id);
    for (const pr of prs) if (pr.providerId) cleanup.push(closePr(pr.providerId));
    expect(done.state).toBe('PR_OPEN');
    expect(done.needsAttention).toBe(false);
    const verify = (await t.store.verifyRuns.list(task.id)).at(-1)!;
    expect(verify.results.map((x) => [x.kind, x.exitCode])).toEqual([
      ['install', 0],
      ['lint', 0],
      ['typecheck', 0],
      ['build', 0],
      ['test', 0],
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ manual: false, status: 'open' });
    expect(prs[0]!.url).toMatch(/console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/.+\/pull-requests\/\d+\/details/);
    console.log(`real PR (will be closed): ${prs[0]!.url}`);
  });
});
