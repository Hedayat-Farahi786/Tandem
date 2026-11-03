/**
 * Spike b: CodeCommit with the system git: over SSH (the user's ~/.ssh/config) or through
 * git-remote-codecommit (codecommit::<region>://[profile@]<repo>, the user's AWS credentials).
 *
 *   TANDEM_SPIKE_REPO_URL=ssh://git-codecommit.<region>.amazonaws.com/v1/repos/<name> pnpm spike:b
 *   pnpm spike:b -- --local      (rehearsal against a local bare repo; proves the git logic, not SSH)
 *
 * Only branches under agent/spike-<id>-* are created on the remote, and all of them are deleted
 * at the end. The default branch is never written to.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flag, shortId, spikeEnv, workDir } from './lib/env.js';
import {
  abortRebase,
  addWorktree,
  assertAgentBranch,
  bareClone,
  commitAll,
  commitIdentityArgs,
  continueRebase,
  deleteRemoteBranch,
  fetchMirror,
  git,
  lsRemoteHeads,
  parseCodeCommitUrl,
  resolveRemote,
  pushBranch,
  rebaseOnto,
  remoteDefaultBranch,
  removeWorktree,
  tryGit,
} from './lib/git.js';
import { Report, check } from './lib/report.js';
import { createLocalRemote } from './lib/sandbox.js';

const env = spikeEnv();
const local = flag('local');
const report = new Report(local ? 'b-git-local' : 'b-codecommit-git', local ? 'Spike b (rehearsal): git workflow against a local bare repo' : 'Spike b: CodeCommit over SSH');
const work = await workDir('spike-b');
const id = shortId();
const base = `agent/spike-${id}-base`;
const branch = `agent/spike-${id}-work`;
const createdRemoteBranches = new Set<string>();

const originalUrl = env.repoUrl;
const resolved = env.repoUrl && !local ? resolveRemote(env.repoUrl, env.awsProfile) : undefined;
let url = resolved?.gitUrl;
const gitVersion = (await git(['--version'])).replace('git version ', '');

try {
  if (local) {
    url = await report.step('Create local stand-in remote (seeded with the backend template)', async (ctx) => {
      const u = await createLocalRemote(work.path, 'backend');
      ctx.detail(`remote: ${u}`);
      return u;
    });
  } else if (!url) {
    report.skip('All steps', 'Set TANDEM_SPIKE_REPO_URL to the SSH URL of a CodeCommit sandbox repo (or run with --local for a rehearsal).');
  }

  if (url) {
    const remoteUrl = url;
    if (!local) {
      await report.step('URL is a CodeCommit URL (SSH or git-remote-codecommit)', async (ctx) => {
        const parsed = parseCodeCommitUrl(originalUrl ?? remoteUrl);
        check(parsed, `Not a CodeCommit URL: ${originalUrl ?? remoteUrl}`);
        ctx.detail(`git uses: ${resolved?.transport ?? 'as given'}${resolved?.profile ? ` (AWS profile ${resolved.profile})` : ''}`);
        ctx.fact('git.transport', resolved?.transport ?? 'as given');
        ctx.detail(`region ${parsed.region}, repo ${parsed.name}, transport ${parsed.transport}${parsed.profile ? `, AWS profile ${parsed.profile}` : ''}`);
        ctx.fact('transport', parsed.transport);
        if (parsed.transport === 'ssh') {
          const sshCfg = await tryGitless(['-G', `git-codecommit.${parsed.region}.amazonaws.com`]);
          const user = /^user (\S+)/m.exec(sshCfg)?.[1];
          ctx.detail(`ssh config resolves a user for the host: ${user ? 'yes' : 'no'}`);
          ctx.fact('ssh.userConfigured', Boolean(user && user !== process.env.USER && user !== process.env.USERNAME));
        } else {
          const { which } = await import('./lib/exec.js');
          check(await which('aws'), 'The AWS CLI is needed for CodeCommit over HTTPS (git uses it as the credential helper).');
          ctx.detail('AWS CLI found; git signs CodeCommit requests with it, using your AWS sign-in');
        }
      });
    }

    const defaultBranch = await report.step('Read access and default branch (ls-remote --symref)', async (ctx) => {
      const started = performance.now();
      const b = await remoteDefaultBranch(remoteUrl);
      ctx.fact('lsRemote.ms', Math.round(performance.now() - started));
      check(b, 'Could not tell the default branch. If the repo is empty, seed it first: pnpm spike:seed -- backend <url>');
      ctx.detail(`default branch: ${b}`);
      ctx.fact('defaultBranch', b);
      return b;
    });

    const mirror = join(work.path, 'mirrors', 'sandbox.git');
    const cloned = defaultBranch
      ? await report.step('Bare clone with remote-tracking refspec ("mirror")', async (ctx) => {
          const started = performance.now();
          await mkdir(join(work.path, 'mirrors'), { recursive: true });
          await bareClone(remoteUrl, mirror);
          ctx.fact('clone.ms', Math.round(performance.now() - started));
          const fetchSpec = await git(['config', '--get-all', 'remote.origin.fetch'], { gitDir: mirror });
          check(fetchSpec === '+refs/heads/*:refs/remotes/origin/*', `unexpected fetch refspec ${fetchSpec}`);
          const mirrorFlag = (await tryGit(['config', 'remote.origin.mirror'], { gitDir: mirror })).stdout.trim();
          check(mirrorFlag !== 'true', 'remote.origin.mirror must not be set');
          const sha = await git(['rev-parse', `refs/remotes/origin/${defaultBranch}`], { gitDir: mirror });
          ctx.detail(`origin/${defaultBranch} = ${sha.slice(0, 10)}`);
          const t2 = performance.now();
          await fetchMirror(mirror);
          ctx.fact('fetch.noop.ms', Math.round(performance.now() - t2));
          return true;
        })
      : undefined;

    let wt = '';
    let headAfterPush = '';
    if (cloned && defaultBranch) {
      await report.step(`Create spike base branch ${base} from ${defaultBranch} (stands in for the default branch)`, async (ctx) => {
        const sha = await git(['rev-parse', `refs/remotes/origin/${defaultBranch}`], { gitDir: mirror });
        // Harness setup: push an existing commit to a new agent/* ref.
        await git(['push', 'origin', `${sha}:${assertAgentBranch(base)}`], { gitDir: mirror });
        createdRemoteBranches.add(base);
        await fetchMirror(mirror);
        ctx.detail(`origin/${base} = ${sha.slice(0, 10)}`);
      });

      const made = await report.step(`Worktree on ${branch} from origin/${base}`, async (ctx) => {
        wt = join(work.path, 'tasks', id, 'sandbox');
        await mkdir(join(work.path, 'tasks', id), { recursive: true });
        await addWorktree(mirror, wt, branch, `origin/${base}`);
        const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt });
        check(current === branch, `worktree is on ${current}`);
        const status = await git(['status', '--porcelain'], { cwd: wt });
        check(status === '', 'new worktree is not clean');
        ctx.detail(`worktree: ${wt}`);
        return true;
      });

      if (made) {
        await report.step('Commit in the worktree', async (ctx) => {
          await writeFile(join(wt, `spike-${id}.txt`), `spike ${id}\n`);
          const sha = await commitAll(wt, `test: spike ${id} change`);
          ctx.detail(`commit ${sha.slice(0, 10)}`);
        });

        await report.step('Push guard refuses anything outside agent/*', async (ctx) => {
          for (const bad of ['main', 'refs/heads/main', 'master', 'agent', 'feature/x', 'refs/tags/v1', 'agent/../main']) {
            let threw = false;
            try {
              await pushBranch(wt, bad);
            } catch {
              threw = true;
            }
            check(threw, `pushBranch did not refuse "${bad}"`);
          }
          const heads = await lsRemoteHeads(remoteUrl);
          check(heads.get(`refs/heads/${defaultBranch}`) !== undefined, 'default branch missing?');
          ctx.detail('refused: main, refs/heads/main, master, agent, feature/x, refs/tags/v1, agent/../main');
        });

        await report.step('Push with explicit refspec', async (ctx) => {
          const started = performance.now();
          const r = await pushBranch(wt, branch);
          check(r.code === 0, `push failed: ${r.stderr.trim()}`);
          createdRemoteBranches.add(branch);
          ctx.fact('push.ms', Math.round(performance.now() - started));
          headAfterPush = await git(['rev-parse', 'HEAD'], { cwd: wt });
          const heads = await lsRemoteHeads(remoteUrl);
          check(heads.get(`refs/heads/${branch}`) === headAfterPush, 'remote branch does not point at the pushed commit');
          ctx.detail(`remote ${branch} = ${headAfterPush.slice(0, 10)}`);
        });

        // Someone else moves the base branch (non-conflicting change).
        const helper = join(work.path, 'helper');
        await report.step('Base branch moves (non-conflicting commit from another clone)', async (ctx) => {
          await git(['clone', '--branch', base, remoteUrl, helper], { timeoutMs: 300_000 });
          await writeFile(join(helper, `upstream-${id}.txt`), 'upstream change\n');
          const sha = await commitAll(helper, `test: upstream change ${id}`);
          await git(['push', 'origin', `HEAD:${assertAgentBranch(base)}`], { cwd: helper });
          ctx.detail(`origin/${base} moved to ${sha.slice(0, 10)}`);
        });

        await report.step('Clean rebase onto the moved base', async (ctx) => {
          await fetchMirror(mirror);
          const r = await rebaseOnto(wt, `origin/${base}`);
          check(r.kind === 'ok', `expected a clean rebase, got conflicts in ${r.kind === 'conflict' ? r.files.join(', ') : ''}`);
          const log = await git(['log', '--format=%s', '-3'], { cwd: wt });
          check(log.includes(`upstream change ${id}`), 'rebased branch does not contain the upstream commit');
          ctx.detail(`history now:\n${log}`);
        });

        await report.step('Re-push after rebase with --force-with-lease (lease = last pushed sha)', async (ctx) => {
          const r = await pushBranch(wt, branch, { forceWithLease: headAfterPush });
          check(r.code === 0, `lease push failed: ${r.stderr.trim()}`);
          headAfterPush = await git(['rev-parse', 'HEAD'], { cwd: wt });
          const heads = await lsRemoteHeads(remoteUrl);
          check(heads.get(`refs/heads/${branch}`) === headAfterPush, 'remote branch not updated');
        });

        await report.step('Stale lease is rejected (someone else pushed to the agent branch)', async (ctx) => {
          // Another clone pushes to the agent branch, so our lease is stale.
          await git(['fetch', 'origin', branch], { cwd: helper });
          await git(['checkout', '-b', 'other', `origin/${branch}`], { cwd: helper });
          await writeFile(join(helper, `other-${id}.txt`), 'other\n');
          await commitAll(helper, 'test: someone else pushed');
          await git(['push', 'origin', `HEAD:${assertAgentBranch(branch)}`], { cwd: helper });
          await git([...(await commitIdentityArgs(wt)), 'commit', '--allow-empty', '-m', 'test: local change'], { cwd: wt });
          const r = await pushBranch(wt, branch, { forceWithLease: headAfterPush });
          check(r.code !== 0, 'push with a stale lease should have been rejected');
          ctx.detail(`rejected as expected: ${(r.stdout + r.stderr).trim().split('\n').find((l) => /rejected|stale/i.test(l)) ?? r.stderr.trim()}`);
          // Reset our branch to the remote state for the next steps.
          await fetchMirror(mirror);
          await git(['reset', '--hard', `origin/${branch}`], { cwd: wt });
          headAfterPush = await git(['rev-parse', 'HEAD'], { cwd: wt });
        });

        await report.step('Conflicting rebase is detected and aborted cleanly', async (ctx) => {
          // Base changes README line 1; the agent branch changes the same line.
          await git(['checkout', base], { cwd: helper });
          await git(['pull', '--ff-only', 'origin', base], { cwd: helper });
          const readmeHelper = join(helper, 'README.md');
          const original = await readFile(readmeHelper, 'utf8');
          await writeFile(readmeHelper, original.replace(/^.*$/m, `# upstream title ${id}`));
          await commitAll(helper, 'test: upstream edits README title');
          await git(['push', 'origin', `HEAD:${assertAgentBranch(base)}`], { cwd: helper });

          const readmeWt = join(wt, 'README.md');
          const mine = await readFile(readmeWt, 'utf8');
          await writeFile(readmeWt, mine.replace(/^.*$/m, `# agent title ${id}`));
          const before = await commitAll(wt, 'test: agent edits README title');

          await fetchMirror(mirror);
          const r = await rebaseOnto(wt, `origin/${base}`);
          check(r.kind === 'conflict', 'expected a conflict');
          check(r.files.includes('README.md'), `conflict files: ${r.files.join(', ')}`);
          ctx.detail(`conflicting files: ${r.files.join(', ')}`);
          await abortRebase(wt);
          const after = await git(['rev-parse', 'HEAD'], { cwd: wt });
          check(after === before, 'HEAD changed after abort');
          check((await git(['status', '--porcelain'], { cwd: wt })) === '', 'worktree not clean after abort');
          ctx.detail('abort restored the branch and left a clean worktree');
        });

        await report.step('Conflict resolved (as the agent would), rebase continued, re-pushed with lease', async (ctx) => {
          const r = await rebaseOnto(wt, `origin/${base}`);
          check(r.kind === 'conflict', 'expected the conflict again');
          const readmeWt = join(wt, 'README.md');
          const conflicted = await readFile(readmeWt, 'utf8');
          check(conflicted.includes('<<<<<<<'), 'no conflict markers');
          const resolved = conflicted.replace(/<<<<<<<[^\n]*\n[\s\S]*?=======\n[\s\S]*?>>>>>>>[^\n]*\n/, `# agent title ${id} (merged with upstream title ${id})\n`);
          await writeFile(readmeWt, resolved);
          await git(['add', 'README.md'], { cwd: wt });
          const head = await continueRebase(wt);
          const p = await pushBranch(wt, branch, { forceWithLease: headAfterPush });
          check(p.code === 0, `push failed: ${p.stderr.trim()}`);
          const heads = await lsRemoteHeads(remoteUrl);
          check(heads.get(`refs/heads/${branch}`) === head, 'remote not updated after resolution');
          ctx.detail(`resolved and pushed ${head.slice(0, 10)}`);
        });

        await report.step('Default branch untouched', async (ctx) => {
          const heads = await lsRemoteHeads(remoteUrl);
          const now = heads.get(`refs/heads/${defaultBranch}`);
          const before = await git(['rev-parse', `refs/remotes/origin/${defaultBranch}`], { gitDir: mirror });
          check(now === before, `default branch moved from ${before} to ${now}`);
        });
      }
    }

    await report.step('Cleanup: delete spike branches on the remote, remove worktree', async (ctx) => {
      for (const b of createdRemoteBranches) {
        await deleteRemoteBranch({ gitDir: mirror }, b);
        ctx.detail(`deleted ${b}`);
      }
      createdRemoteBranches.clear();
      if (wt) await removeWorktree(mirror, wt);
      const heads = await lsRemoteHeads(remoteUrl);
      const leftovers = [...heads.keys()].filter((r) => r.includes(`spike-${id}`));
      check(leftovers.length === 0, `left on remote: ${leftovers.join(', ')}`);
      if (existsSync(mirror)) {
        const list = await git(['worktree', 'list', '--porcelain'], { gitDir: mirror });
        check(!list.includes(id), 'worktree still registered');
      }
    });
  }
} finally {
  // Best effort if a step failed before cleanup.
  for (const b of createdRemoteBranches) {
    await tryGit(['push', 'origin', '--delete', `refs/heads/${b}`], { gitDir: join(work.path, 'mirrors', 'sandbox.git') });
  }
  await work.cleanup();
  await report.finish({ git: gitVersion, mode: local ? 'local rehearsal' : 'CodeCommit over SSH' });
}

async function tryGitless(sshArgs: string[]): Promise<string> {
  const { run } = await import('./lib/exec.js');
  try {
    const r = await run('ssh', sshArgs, { timeoutMs: 10_000 });
    return r.stdout;
  } catch {
    return '';
  }
}
