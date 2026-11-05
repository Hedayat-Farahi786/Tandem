import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join as joinPath, relative, resolve as resolvePath, sep } from 'node:path';
import { RetryableError } from '@tandem/core';

export class GitError extends Error {
  override readonly name = 'GitError';
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const NETWORK = /(Could not resolve host|Connection (timed out|reset|refused)|Operation timed out|unable to access|early EOF|remote end hung up|RPC failed|The requested URL returned error: 5\d\d|TLS|Temporary failure|Network is unreachable|kex_exchange_identification)/i;
const AUTH = /(Permission denied \(publickey\)|Authentication failed|could not read Username|The requested URL returned error: 403|unable to get credentials|does not have credentials|ExpiredToken|InvalidClientTokenId|security token included in the request is (invalid|expired))/i;

const EXPIRED = /(session has expired|Please reauthenticate|ExpiredToken|token (has|is) expired|The SSO session associated with this profile has expired)/i;
/** git's progress chatter ("Cloning into …", counting objects, the credential-prompt fallout) is not a reason. */
const NOISE = /^(Cloning into|remote: (Counting|Compressing|Enumerating|Total)|Receiving objects|Resolving deltas|fatal: could not read (Username|Password) for .*terminal prompts disabled)/i;

/** The lines of git's output that explain a failure, without progress messages. */
export function reasonOf(stderr: string): string {
  return stderr
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l))
    .slice(-6)
    .join('\n');
}

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', ...extra };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
  return env;
}

export interface GitRun {
  cwd?: string;
  gitDir?: string;
  /** `-c key=value` pairs for this call only (for example the CodeCommit credential helper). */
  config?: readonly string[];
  timeoutMs?: number;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFail?: boolean;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/*
 * Tandem's cloud: builds run isolated, but their task folders are shared with Tandem's own git. A
 * build could replace a worktree's `.git` link to make Tandem's git read a config it wrote (an
 * fsmonitor or a filter runs commands). So under these roots ('<root>/<workspace>/…'), a `.git`
 * must be a plain file that links into that same workspace's mirrors, which builds can't write;
 * and hooks and fsmonitor are off for every call.
 */
let guarded: string[] = [];
export function guardWorktrees(roots: readonly string[]): void {
  guarded = roots.map((r) => resolvePath(r));
}
const HARDENED = ['core.hooksPath=/dev/null', 'core.fsmonitor=false'];

function checkGitLinks(o: GitRun): void {
  const under = (p: string) => guarded.map((root) => ({ root, rel: relative(root, resolvePath(p)) })).find((x) => x.rel && !x.rel.startsWith('..') && !isAbsolute(x.rel));
  const inMirrors = (base: string, p: string) => {
    const rel = relative(joinPath(base, 'mirrors'), resolvePath(p));
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const refuse = (why: string) => new GitError(`Tandem refused to run git: ${why}. The task folder was changed by something other than Tandem.`, '', null);
  if (o.gitDir) {
    const g = under(o.gitDir);
    if (g && !inMirrors(joinPath(g.root, g.rel.split(sep)[0]!), o.gitDir)) throw refuse(`${o.gitDir} is not one of this workspace's mirrors`);
  }
  if (!o.cwd) return;
  const c = under(o.cwd);
  if (!c) return;
  const base = joinPath(c.root, c.rel.split(sep)[0]!);
  if (inMirrors(base, o.cwd)) return;
  for (let dir = resolvePath(o.cwd); dir.startsWith(base + sep); dir = dirname(dir)) {
    const link = joinPath(dir, '.git');
    let st;
    try {
      st = lstatSync(link);
    } catch {
      continue;
    }
    if (!st.isFile()) throw refuse(`${link} is not the link git made`);
    const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(link, 'utf8'))?.[1]?.trim();
    if (!target || !inMirrors(base, resolvePath(dir, target))) throw refuse(`${link} points outside this workspace's mirrors`);
    return;
  }
  throw refuse(`${o.cwd} is not inside a worktree`);
}

/** Runs the system git without a shell. Network errors become RetryableError; auth errors get a fix. */
export function runGit(args: readonly string[], o: GitRun = {}): Promise<GitResult> {
  const config = guarded.length ? [...HARDENED, ...(o.config ?? [])] : (o.config ?? []);
  const full = [...config.flatMap((c) => ['-c', c]), ...(o.gitDir ? ['--git-dir', o.gitDir] : []), ...args];
  return new Promise((resolve, reject) => {
    if (o.cwd && !existsSync(o.cwd)) {
      reject(new GitError(`Folder ${o.cwd} does not exist.`, '', null));
      return;
    }
    if (guarded.length) {
      try {
        checkGitLinks(o);
      } catch (err) {
        reject(err as Error);
        return;
      }
    }
    const child = spawn('git', full, { cwd: o.cwd, env: gitEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 300_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new GitError(`git could not start: ${err.message}. Install git and make sure it is on PATH.`, '', null));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || o.allowFail) {
        resolve({ code, stdout, stderr });
        return;
      }
      const what = `git ${args.slice(0, 3).join(' ')}`;
      const tail = reasonOf(stderr) || stdout.trim().split('\n').slice(-6).join('\n');
      if (code === null) reject(new RetryableError(`${what} timed out.`));
      else if (EXPIRED.test(stderr)) reject(new GitError(`Your AWS sign-in has expired, so git could not reach CodeCommit. Connect AWS again in Settings › AWS, then try again.`, stderr, code));
      else if (AUTH.test(stderr)) reject(new GitError(`${what} was refused: ${tail}\nCheck your access: for CodeCommit, connect AWS again in Settings › AWS (or check your SSH key); for GitHub, connect the account that can see the repository in Settings › Copilot.`, stderr, code));
      else if (NETWORK.test(stderr)) reject(new RetryableError(`${what} failed on the network: ${tail}`));
      else reject(new GitError(`${what} failed: ${tail}`, stderr, code));
    });
  });
}

export async function git(args: readonly string[], o: GitRun = {}): Promise<string> {
  return (await runGit(args, o)).stdout.trim();
}
