import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/** Runs the system git without a shell. Network errors become RetryableError; auth errors get a fix. */
export function runGit(args: readonly string[], o: GitRun = {}): Promise<GitResult> {
  const full = [...(o.config ?? []).flatMap((c) => ['-c', c]), ...(o.gitDir ? ['--git-dir', o.gitDir] : []), ...args];
  return new Promise((resolve, reject) => {
    if (o.cwd && !existsSync(o.cwd)) {
      reject(new GitError(`Folder ${o.cwd} does not exist.`, '', null));
      return;
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
