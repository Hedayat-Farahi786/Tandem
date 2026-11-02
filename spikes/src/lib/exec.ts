import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Run through the platform shell. Only for owner-configured command lines (npm test, etc.). */
  shell?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Math.round(performance.now() - started), timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Runs and throws with the command's output when it exits non-zero. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const what = [cmd, ...args].join(' ');
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-15).join('\n');
    throw new Error(`${what} exited with ${r.timedOut ? 'timeout' : r.code}: ${tail}`);
  }
  return r;
}

/** Finds an executable on PATH (PATHEXT-aware on Windows). */
export async function which(name: string): Promise<string | undefined> {
  const { access, constants } = await import('node:fs/promises');
  const { delimiter, join } = await import('node:path');
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      const candidateUpper = join(dir, name + ext);
      for (const c of new Set([candidate, candidateUpper])) {
        try {
          await access(c, constants.X_OK);
          return c;
        } catch {
          // keep looking
        }
      }
    }
  }
  return undefined;
}

/** npm/pnpm are .cmd shims on Windows and must be run through the shell there. */
export function packageManagerCommand(pm: 'npm' | 'pnpm' | 'yarn', args: string[]): { cmd: string; args: string[]; shell: boolean } {
  if (process.platform === 'win32') return { cmd: [pm, ...args].join(' '), args: [], shell: true };
  return { cmd: pm, args, shell: false };
}
