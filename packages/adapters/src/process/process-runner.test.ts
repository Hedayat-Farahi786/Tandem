import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShellProcessRunner, commandEnv } from './process-runner.js';

const cwd = mkdtempSync(join(tmpdir(), 'tandem-proc-'));
const runner = new ShellProcessRunner();

describe('ShellProcessRunner', () => {
  it('runs a command line and streams lines', async () => {
    const lines: string[] = [];
    const r = await runner.runCommand('echo one && echo two 1>&2 && exit 3', { cwd, timeoutMs: 10_000, onLine: (l) => lines.push(l) });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe('one');
    expect(r.stderr.trim()).toBe('two');
    expect(lines.sort()).toEqual(['one', 'two']);
  });

  it('kills the whole process tree on timeout', async () => {
    const r = await runner.runCommand('sleep 30 & sleep 30; echo never', { cwd, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(5_000);
  });

  it('keeps credentials out of repo commands', async () => {
    const env = commandEnv({ EXTRA: '1' }, { PATH: '/bin', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_PROFILE: 'work', TANDEM_HOME: '/t', JIRA_API_TOKEN: 'z', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', EXTRA: '1' });
    const r = await runner.runCommand('echo "[$MY_SECRET_TOKEN]"', { cwd, timeoutMs: 5_000 });
    expect(r.stdout.trim()).toBe('[]');
  });
});
