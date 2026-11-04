import { spawn, spawnSync } from 'node:child_process';
import type { ProcessResult, ProcessRunner } from '@tandem/core';

const MAX_BUFFER = 4 * 1024 * 1024;
/** Variables that look like credentials never reach repo commands (tests have no business with them). */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|ACCESS_KEY|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
const DROP_ENV = new Set(['AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'GH_HOST', 'COPILOT_GH_HOST']);

export function commandEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_ENV.test(k) && !DROP_ENV.has(k) && !k.startsWith('TANDEM_')) env[k] = v;
  return { ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** Runs owner-configured command lines (npm test, ...) through the platform shell. */
export class ShellProcessRunner implements ProcessRunner {
  async runCommand(command: string, opts: { cwd: string; timeoutMs: number; env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<ProcessResult> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: opts.cwd,
        env: commandEnv(opts.env),
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so a timeout kills everything it started
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const partial = { out: '', err: '' };
      const feed = (which: 'out' | 'err', chunk: string) => {
        if (!opts.onLine) return;
        const text = partial[which] + chunk;
        const lines = text.split(/\r?\n/);
        partial[which] = lines.pop() ?? '';
        for (const l of lines) if (l) opts.onLine(l);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
      }, opts.timeoutMs);
      // Stopped early (the owner skipped this check): end it and everything it started.
      const stop = () => {
        if (child.pid) killTree(child.pid);
      };
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener('abort', stop, { once: true });
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        stdout = (stdout + d).slice(-MAX_BUFFER);
        feed('out', d);
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        stderr = (stderr + d).slice(-MAX_BUFFER);
        feed('err', d);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', stop);
        if (partial.out) opts.onLine?.(partial.out);
        if (partial.err) opts.onLine?.(partial.err);
        resolve({ exitCode: timedOut ? null : code, timedOut, durationMs: Math.round(performance.now() - started), stdout, stderr });
      });
    });
  }
}
