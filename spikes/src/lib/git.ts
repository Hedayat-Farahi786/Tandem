import { run, type RunResult } from './exec.js';

/**
 * Prototype of packages/adapters/src/git. Uses the system git and the user's own
 * ~/.ssh/config. BatchMode stops ssh from hanging on a passphrase or host-key prompt;
 * an existing GIT_SSH_COMMAND / GIT_SSH (for example plink on Windows) is respected.
 */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...extra };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
  return env;
}

export interface GitOptions {
  cwd?: string;
  gitDir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function args(base: string[], opts: GitOptions): string[] {
  return opts.gitDir ? ['--git-dir', opts.gitDir, ...base] : base;
}

export async function tryGit(gitArgs: string[], opts: GitOptions = {}): Promise<RunResult> {
  return run('git', args(gitArgs, opts), {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: gitEnv(opts.env),
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
}

export async function git(gitArgs: string[], opts: GitOptions = {}): Promise<string> {
  const r = await tryGit(gitArgs, opts);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-12).join('\n');
    throw new Error(`git ${gitArgs.join(' ')} failed (${r.timedOut ? 'timeout' : `exit ${r.code}`}): ${tail}`);
  }
  return r.stdout.trim();
}

/** Identity used only when the user has no git identity configured. */
export async function commitIdentityArgs(cwd: string): Promise<string[]> {
  const name = (await tryGit(['config', 'user.name'], { cwd })).stdout.trim();
  const email = (await tryGit(['config', 'user.email'], { cwd })).stdout.trim();
  const out: string[] = [];
  if (!name) out.push('-c', 'user.name=Tandem');
  if (!email) out.push('-c', 'user.email=tandem@localhost');
  return out;
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(['add', '-A'], { cwd });
  await git([...(await commitIdentityArgs(cwd)), 'commit', '-m', message], { cwd });
  return git(['rev-parse', 'HEAD'], { cwd });
}

/** Returns the default branch name from the remote's HEAD symref, or undefined for an empty repo. */
export async function remoteDefaultBranch(url: string, timeoutMs = 30_000): Promise<string | undefined> {
  const out = await git(['ls-remote', '--symref', url, 'HEAD'], { timeoutMs });
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out);
  return m?.[1];
}

export async function lsRemoteHeads(url: string): Promise<Map<string, string>> {
  const out = await git(['ls-remote', '--heads', url]);
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) map.set(ref, sha);
  }
  return map;
}

/**
 * The "mirror": a bare clone with remote-tracking refs. Not `--mirror`: with
 * remote.origin.mirror=true git refuses explicit push refspecs and a plain push
 * would mirror every ref.
 */
export async function bareClone(url: string, dir: string): Promise<void> {
  await git(['clone', '--bare', '--no-tags', url, dir], { timeoutMs: 600_000 });
  await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { gitDir: dir });
  if (process.platform === 'win32') await git(['config', 'core.longpaths', 'true'], { gitDir: dir });
  await fetchMirror(dir);
}

export async function fetchMirror(dir: string): Promise<void> {
  await git(['fetch', '--prune', '--no-tags', 'origin'], { gitDir: dir, timeoutMs: 600_000 });
}

export async function addWorktree(mirror: string, path: string, branch: string, startPoint: string): Promise<void> {
  await git(['worktree', 'add', '-b', branch, path, startPoint], { gitDir: mirror });
}

export async function removeWorktree(mirror: string, path: string): Promise<void> {
  await tryGit(['worktree', 'remove', '--force', path], { gitDir: mirror });
  await tryGit(['worktree', 'prune'], { gitDir: mirror });
}

export const AGENT_REF_PREFIX = 'refs/heads/agent/';

/** Code-level guard: Tandem only ever pushes to agent/* branches. */
export function assertAgentBranch(branch: string): string {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  if (!ref.startsWith(AGENT_REF_PREFIX) || ref.includes('..') || /[\s~^:?*[\\]/.test(ref.slice(AGENT_REF_PREFIX.length))) {
    throw new Error(`Refusing to push "${branch}": Tandem only pushes to branches under agent/.`);
  }
  return ref;
}

export interface PushOptions {
  /** Expected remote sha for --force-with-lease (used only after a rebase of an already pushed branch). */
  forceWithLease?: string;
}

export async function pushBranch(worktree: string, branch: string, opts: PushOptions = {}): Promise<RunResult> {
  const ref = assertAgentBranch(branch);
  const pushArgs = ['push', '--porcelain', 'origin'];
  if (opts.forceWithLease) pushArgs.push(`--force-with-lease=${ref}:${opts.forceWithLease}`);
  pushArgs.push(`${ref}:${ref}`);
  return tryGit(pushArgs, { cwd: worktree, timeoutMs: 300_000 });
}

export async function deleteRemoteBranch(worktreeOrGitDir: { cwd?: string; gitDir?: string }, branch: string): Promise<void> {
  const ref = assertAgentBranch(branch);
  await git(['push', 'origin', '--delete', ref], { ...worktreeOrGitDir, timeoutMs: 120_000 });
}

export type RebaseResult = { kind: 'ok'; head: string } | { kind: 'conflict'; files: string[] };

export async function rebaseOnto(worktree: string, upstream: string): Promise<RebaseResult> {
  const r = await tryGit([...(await commitIdentityArgs(worktree)), 'rebase', upstream], { cwd: worktree });
  if (r.code === 0) return { kind: 'ok', head: await git(['rev-parse', 'HEAD'], { cwd: worktree }) };
  const files = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree })).split('\n').filter(Boolean);
  if (files.length === 0) throw new Error(`git rebase failed without conflicts: ${(r.stderr || r.stdout).trim()}`);
  return { kind: 'conflict', files };
}

export async function continueRebase(worktree: string): Promise<string> {
  await git([...(await commitIdentityArgs(worktree)), 'rebase', '--continue'], { cwd: worktree });
  return git(['rev-parse', 'HEAD'], { cwd: worktree });
}

export async function abortRebase(worktree: string): Promise<void> {
  await git(['rebase', '--abort'], { cwd: worktree });
}

export type CodeCommitTransport = 'ssh' | 'https' | 'grc';

/** Parses SSH, HTTPS and git-remote-codecommit (codecommit::region://[profile@]repo) URLs. */
export function parseCodeCommitUrl(url: string): { region: string; name: string; transport: CodeCommitTransport; profile?: string } | undefined {
  const ssh = /^ssh:\/\/(?:[^@/]+@)?git-codecommit\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([^/\s]+?)\/?$/.exec(url);
  if (ssh?.[1] && ssh[2]) return { region: ssh[1], name: ssh[2], transport: 'ssh' };
  const https = /^https:\/\/git-codecommit\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([^/\s]+?)\/?$/.exec(url);
  if (https?.[1] && https[2]) return { region: https[1], name: https[2], transport: 'https' };
  const grc = /^codecommit::([a-z0-9-]+):\/\/(?:([^@/\s]+)@)?([^/\s@]+)$/.exec(url);
  if (grc?.[1] && grc[3]) return { region: grc[1], name: grc[3], transport: 'grc', ...(grc[2] ? { profile: grc[2] } : {}) };
  return undefined;
}
