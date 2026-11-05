import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NamespaceSandbox, bundledCopilotRuntime } from './namespace-sandbox.js';

/** The isolation of cloud builds, against the real kernel (Linux with user namespaces). */
const root = mkdtempSync(join(tmpdir(), 'tandem-sbx-'));
const a = join(root, 'workspaces', 'a');
const b = join(root, 'workspaces', 'b');
let sbx: NamespaceSandbox;
let supported = process.platform === 'linux';

beforeAll(async () => {
  for (const d of [join(a, 'tasks', 't1'), join(a, 'mirrors', 'r.git'), join(a, 'bin'), b]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'directory.db'), 'SECRET DIRECTORY');
  writeFileSync(join(a, 'tandem.db'), 'WORKSPACE DB');
  writeFileSync(join(a, 'bin', 'git-credential.json'), '{"key":"k"}');
  writeFileSync(join(b, 'tandem.db'), 'OTHER TENANT');
  writeFileSync(join(a, 'mirrors', 'r.git', 'config'), '[core]\n');
  try {
    sbx = new NamespaceSandbox({ hide: [root], keep: [a], readOnly: [join(a, 'mirrors')], mask: [join(a, 'tandem.db'), join(a, 'bin', 'git-credential.json')], home: join(root, 'home') });
    supported = (await sbx.run(['true'])).code === 0;
  } catch {
    supported = false;
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('isolated builds', () => {
  it('shows a build its own workspace only', async (ctx) => {
    if (!supported) return ctx.skip();
    const sh = (script: string) => sbx.run(['sh', '-c', script], { cwd: join(a, 'tasks', 't1') });
    expect(await sbx.selfTest({ hidden: b, kept: join(a, 'tasks'), readOnly: join(a, 'mirrors'), masked: join(a, 'tandem.db') })).toMatchObject({ ok: true });
    // Other workspaces and the directory are gone, also by walking up from where it starts.
    expect((await sh(`cat ${join(root, 'directory.db')} ${join(b, 'tandem.db')} ../../../b/tandem.db ../../../../directory.db 2>&1; true`)).out).not.toMatch(/SECRET|OTHER/);
    // Its own task folder is writable, and the files land in the real folder.
    expect((await sh('echo built > out.txt && pwd')).out.trim()).toBe(join(a, 'tasks', 't1'));
    expect(readFileSync(join(a, 'tasks', 't1', 'out.txt'), 'utf8')).toBe('built\n');
    // git config and hooks in the mirrors can't be planted; the database and the helper's key read empty.
    expect((await sh(`echo '[core] fsmonitor = evil' >> ${join(a, 'mirrors', 'r.git', 'config')}`)).code).not.toBe(0);
    expect(readFileSync(join(a, 'mirrors', 'r.git', 'config'), 'utf8')).toBe('[core]\n');
    expect((await sh(`cat ${join(a, 'tandem.db')} ${join(a, 'bin', 'git-credential.json')}`)).out).toBe('');
    // No process of the server is visible (its memory and environment hold the secrets).
    expect(Number((await sh("ls /proc | grep -c '^[0-9]'")).out.trim())).toBeLessThan(10);
    // Nothing of the sandbox's own variables leaks into the command.
    expect((await sh('env')).out).not.toMatch(/SBX_/);
  });

  it('finds the Copilot runtime the SDK bundles, to start it isolated', () => {
    expect(bundledCopilotRuntime()).toMatch(/copilot-runtime(\.exe)?$/);
  });
});
