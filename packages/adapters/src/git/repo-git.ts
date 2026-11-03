import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitOps, MirrorInfo, RebaseResult } from '@tandem/core';
import type { Repo } from '@tandem/shared';
import { GitError, git, runGit } from './git.js';

export const AGENT_REF_PREFIX = 'refs/heads/agent/';

/** Code-level guard: Tandem only ever pushes to agent/* branches. */
export function assertAgentBranch(branch: string): string {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const rest = ref.slice(AGENT_REF_PREFIX.length);
  if (!ref.startsWith(AGENT_REF_PREFIX) || !rest || ref.includes('..') || /[\s~^:?*[\\]|@\{|\/\/|^\/|\/$|\.lock$/.test(rest)) {
    throw new GitError(`Refusing to push "${branch}": Tandem only pushes to branches under agent/.`, '', null);
  }
  return ref;
}

/** How git reaches a remote: the URL plus per-call and per-mirror config (credential helper). */
export interface RemoteAccess {
  gitUrl: string;
  /** `-c` values used before the mirror exists (clone, ls-remote). */
  config: readonly string[];
  /** Local config written into the mirror so fetch/push from worktrees use the same access. */
  mirrorConfig: ReadonlyArray<[string, string]>;
}

/** CodeCommit over HTTPS signed by the AWS CLI (any sign-in method: SSO, aws login, keys). */
export function codeCommitHttpsAccess(region: string, name: string, profile?: string): RemoteAccess {
  if (profile && !/^[A-Za-z0-9._-]+$/.test(profile)) throw new GitError(`Invalid AWS profile name "${profile}".`, '', null);
  const helper = `!aws${profile ? ` --profile ${profile}` : ''} codecommit credential-helper $@`;
  return {
    gitUrl: `https://git-codecommit.${region}.amazonaws.com/v1/repos/${name}`,
    config: ['credential.helper=', `credential.helper=${helper}`, 'credential.UseHttpPath=true'],
    mirrorConfig: [
      ['credential.helper', ''],
      ['credential.helper', helper],
      ['credential.UseHttpPath', 'true'],
    ],
  };
}

export function plainAccess(url: string): RemoteAccess {
  return { gitUrl: url, config: [], mirrorConfig: [] };
}

/** GitHub over HTTPS with the GitHub CLI as credential source. */
export function ghHttpsAccess(url: string): RemoteAccess {
  return {
    gitUrl: url,
    config: ['credential.helper=', 'credential.helper=!gh auth git-credential'],
    mirrorConfig: [
      ['credential.helper', ''],
      ['credential.helper', '!gh auth git-credential'],
    ],
  };
}

/** Default branch from the HEAD symref, or (CodeCommit HTTPS has none) the branch matching HEAD's commit. */
export async function remoteDefaultBranch(access: RemoteAccess): Promise<string | undefined> {
  const out = await git(['ls-remote', '--symref', access.gitUrl, 'HEAD', 'refs/heads/*'], { config: access.config, timeoutMs: 60_000 });
  const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1];
  if (sym) return sym;
  const lines = out.split('\n').map((l) => l.trim().split(/\s+/));
  const head = lines.find((l) => l[1] === 'HEAD')?.[0];
  if (!head) return undefined;
  const candidates = lines.filter((l) => l[0] === head && l[1]?.startsWith('refs/heads/')).map((l) => l[1]!.slice('refs/heads/'.length));
  for (const p of ['main', 'master', 'develop', 'trunk']) if (candidates.includes(p)) return p;
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * The "mirror": a bare clone with remote-tracking refs (+refs/heads/*:refs/remotes/origin/*).
 * Deliberately not `clone --mirror`: with remote.origin.mirror set, git refuses explicit push
 * refspecs and a plain push would mirror every ref.
 */
/**
 * One git operation at a time per mirror (fetch, worktree add and remove). A fetch checks every
 * worktree's HEAD, and `git worktree add` writes a placeholder HEAD before the real one: run side
 * by side, the fetch fails on another task's half-made worktree.
 */
const mirrorQueues = new Map<string, Promise<unknown>>();
export async function withMirror<T>(mirror: string, fn: () => Promise<T>): Promise<T> {
  const prev = mirrorQueues.get(mirror) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mirrorQueues.set(mirror, tail);
  try {
    return await run;
  } finally {
    if (mirrorQueues.get(mirror) === tail) mirrorQueues.delete(mirror);
  }
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Removes worktrees that a killed `git worktree add` left half-made: their HEAD is still the
 * placeholder (or names a commit that isn't there), and while one exists every fetch fails with
 * "bad object worktrees/…/HEAD". Their folders hold nothing yet; the task makes a fresh one.
 * Returns the worktree folders removed.
 */
export async function repairWorktrees(mirror: string): Promise<string[]> {
  const admin = join(mirror, 'worktrees');
  if (!existsSync(admin)) return [];
  const removed: string[] = [];
  for (const name of await readdir(admin)) {
    const dir = join(admin, name);
    const head = (await readFile(join(dir, 'HEAD'), 'utf8').catch(() => '')).trim();
    if (head.startsWith('ref: ')) continue; // on a branch, even one with no commits yet: fetch is fine
    const ok = OBJECT_ID.test(head) && !/^0+$/.test(head) && (await runGit(['cat-file', '-e', `${head}^{commit}`], { gitDir: mirror, allowFail: true })).code === 0;
    if (ok) continue;
    const gitdir = (await readFile(join(dir, 'gitdir'), 'utf8').catch(() => '')).trim();
    const worktree = gitdir ? dirname(gitdir) : '';
    if (worktree && existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    removed.push(worktree || name);
  }
  if (removed.length) await runGit(['worktree', 'prune'], { gitDir: mirror, allowFail: true });
  return removed;
}

export async function ensureMirror(path: string, access: RemoteAccess, defaultBranch?: string): Promise<MirrorInfo> {
  return withMirror(path, () => ensureMirrorNow(path, access, defaultBranch));
}

async function ensureMirrorNow(path: string, access: RemoteAccess, defaultBranch?: string): Promise<MirrorInfo> {
  if (!existsSync(join(path, 'HEAD'))) {
    await mkdir(dirname(path), { recursive: true });
    await git(['clone', '--bare', '--no-tags', access.gitUrl, path], { config: access.config, timeoutMs: 900_000 });
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { gitDir: path });
    if (process.platform === 'win32') await git(['config', 'core.longpaths', 'true'], { gitDir: path });
  }
  await git(['config', 'remote.origin.url', access.gitUrl], { gitDir: path });
  await runGit(['config', '--unset-all', 'credential.helper'], { gitDir: path, allowFail: true });
  for (const [k, v] of access.mirrorConfig) await git(['config', '--add', k, v], { gitDir: path });
  await repairWorktrees(path);
  await git(['fetch', '--prune', '--no-tags', 'origin'], { gitDir: path, timeoutMs: 900_000 });
  const branch = defaultBranch ?? (await remoteDefaultBranch(access));
  if (!branch) throw new GitError('Could not tell the default branch of the repo. If it is empty, push a first commit to it.', '', null);
  return { path, defaultBranch: branch };
}

/**
 * Creates (or checks and reuses) a worktree. A detached one is a read-only reference checkout,
 * reset to `base` each time. A branch worktree that already exists is kept (it may hold work) if it
 * is sound and on its branch; if its branch has no commits of its own yet, its checkout is also
 * completed (an add killed half-way leaves files missing). Anything broken is made again.
 */
export async function addWorktree(mirror: string, opts: { path: string; branch: string; base: string; detach?: boolean }): Promise<void> {
  await withMirror(mirror, async () => {
    await repairWorktrees(mirror);
    if (existsSync(join(opts.path, '.git'))) {
      if (opts.detach) {
        const r = await runGit(['checkout', '--detach', '--force', opts.base], { cwd: opts.path, allowFail: true });
        if (r.code === 0) {
          await git(['reset', '--hard', opts.base], { cwd: opts.path });
          await git(['clean', '-fd'], { cwd: opts.path });
          return;
        }
      } else {
        const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: opts.path, allowFail: true });
        const ref = (await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: opts.path, allowFail: true })).stdout.trim();
        if (head.code === 0 && ref === `refs/heads/${opts.branch}`) {
          const own = (await runGit(['rev-list', '--count', `${opts.base}..HEAD`], { cwd: opts.path, allowFail: true })).stdout.trim();
          if (own === '0') await git(['reset', '--hard', 'HEAD'], { cwd: opts.path });
          return;
        }
      }
      // Broken or on the wrong commit: start over.
      await rm(opts.path, { recursive: true, force: true });
    }
    await mkdir(dirname(opts.path), { recursive: true });
    await git(['worktree', 'prune'], { gitDir: mirror });
    if (opts.detach) {
      await git(['worktree', 'add', '--detach', '--force', opts.path, opts.base], { gitDir: mirror });
      return;
    }
    const exists = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`], { gitDir: mirror, allowFail: true })).code === 0;
    if (exists) await git(['worktree', 'add', opts.path, opts.branch], { gitDir: mirror });
    else await git(['worktree', 'add', '-b', opts.branch, opts.path, opts.base], { gitDir: mirror });
  });
}

async function identity(cwd: string): Promise<string[]> {
  const name = (await runGit(['config', 'user.name'], { cwd, allowFail: true })).stdout.trim();
  const email = (await runGit(['config', 'user.email'], { cwd, allowFail: true })).stdout.trim();
  return [...(name ? [] : ['user.name=Tandem']), ...(email ? [] : ['user.email=tandem@localhost'])];
}

export async function rebaseOnto(worktree: string, upstream: string): Promise<RebaseResult> {
  const r = await runGit(['rebase', upstream], { cwd: worktree, config: await identity(worktree), allowFail: true });
  if (r.code === 0) return { kind: 'ok', head: await git(['rev-parse', 'HEAD'], { cwd: worktree }) };
  const files = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree })).split('\n').filter(Boolean);
  if (files.length === 0) {
    await runGit(['rebase', '--abort'], { cwd: worktree, allowFail: true });
    throw new GitError(`Rebase onto ${upstream} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' ')}`, r.stderr, r.code);
  }
  return { kind: 'conflict', files };
}

export async function pushBranch(worktree: string, branch: string, forceWithLease?: string): Promise<{ ok: true; sha: string } | { ok: false; message: string }> {
  const ref = assertAgentBranch(branch);
  const args = ['push', '--porcelain', 'origin'];
  if (forceWithLease) args.push(`--force-with-lease=${ref}:${forceWithLease}`);
  args.push(`${ref}:${ref}`);
  const r = await runGit(args, { cwd: worktree, allowFail: true, timeoutMs: 600_000 });
  if (r.code === 0) return { ok: true, sha: await git(['rev-parse', 'HEAD'], { cwd: worktree }) };
  const line = `${r.stdout}\n${r.stderr}`.split('\n').find((l) => /rejected|stale|denied|error/i.test(l)) ?? r.stderr.trim();
  if (/Could not resolve host|timed out|unable to access/i.test(r.stderr)) throw new GitError(`git push failed on the network: ${line}`, r.stderr, r.code);
  return { ok: false, message: line.trim() };
}

/** Local git operations on worktrees. `mirrorOf` maps a repo to its bare clone. */
export class RepoGit implements GitOps {
  constructor(private readonly mirrorOf: (repo: Repo) => string) {}

  async status(worktree: string): Promise<string[]> {
    return (await git(['status', '--porcelain'], { cwd: worktree })).split('\n').filter(Boolean);
  }

  async commitAll(worktree: string, message: string): Promise<string | undefined> {
    await git(['add', '-A'], { cwd: worktree });
    if ((await runGit(['diff', '--cached', '--quiet'], { cwd: worktree, allowFail: true })).code === 0) return undefined;
    // --no-verify: Tandem runs the repo's checks itself in VERIFY; hooks would need deps not yet installed.
    await git(['commit', '--no-verify', '-m', message], { cwd: worktree, config: await identity(worktree) });
    return git(['rev-parse', 'HEAD'], { cwd: worktree });
  }

  async head(worktree: string): Promise<string> {
    return git(['rev-parse', 'HEAD'], { cwd: worktree });
  }

  async diff(worktree: string, base: string): Promise<string> {
    return (await runGit(['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`], { cwd: worktree })).stdout;
  }

  async diffStat(worktree: string, base: string): Promise<{ files: number; insertions: number; deletions: number }> {
    const s = await git(['diff', '--shortstat', `${base}...HEAD`], { cwd: worktree });
    const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
    return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
  }

  async continueRebase(worktree: string): Promise<string> {
    await git(['add', '-A'], { cwd: worktree });
    await git(['rebase', '--continue'], { cwd: worktree, config: await identity(worktree) });
    return git(['rev-parse', 'HEAD'], { cwd: worktree });
  }

  async abortRebase(worktree: string): Promise<void> {
    await runGit(['rebase', '--abort'], { cwd: worktree, allowFail: true });
  }

  /**
   * Files that still need resolving: conflict markers left in the file (staged or not). A file
   * whose markers are gone counts as resolved even if nobody ran git add; continueRebase stages it.
   */
  async conflictedFiles(worktree: string): Promise<string[]> {
    const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree })).split('\n').filter(Boolean);
    const marked = new Set<string>();
    for (const f of unmerged) {
      const p = join(worktree, f);
      if (!existsSync(p)) continue; // deleted on one side: resolved by the deletion
      if (/^(<<<<<<<|>>>>>>>)( |$)|^=======$/m.test(await readFile(p, 'utf8'))) marked.add(f);
    }
    const staged = await runGit(['grep', '--cached', '-l', '-E', '^(<<<<<<<|>>>>>>>) '], { cwd: worktree, allowFail: true });
    for (const f of staged.stdout.split('\n').filter(Boolean)) marked.add(f);
    return [...marked];
  }

  async removeWorktree(repo: Repo, worktree: string): Promise<void> {
    const mirror = this.mirrorOf(repo);
    if (!existsSync(mirror)) {
      await rm(worktree, { recursive: true, force: true });
      return;
    }
    await withMirror(mirror, async () => {
      await runGit(['worktree', 'remove', '--force', worktree], { gitDir: mirror, allowFail: true });
      // A broken worktree can't be removed by git: delete the folder, then prune drops the entry.
      if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
      await runGit(['worktree', 'prune'], { gitDir: mirror, allowFail: true });
    });
  }

  async isAncestor(repo: Repo, ref: string, of: string): Promise<boolean> {
    const r = await runGit(['merge-base', '--is-ancestor', ref, of], { gitDir: this.mirrorOf(repo), allowFail: true });
    return r.code === 0;
  }

  /** Deletes the local agent branch after a task is done (the remote branch is the PR's business). */
  async deleteLocalBranch(repo: Repo, branch: string): Promise<void> {
    assertAgentBranch(branch);
    await runGit(['branch', '-D', branch], { gitDir: this.mirrorOf(repo), allowFail: true });
  }
}
