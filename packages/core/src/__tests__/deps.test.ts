import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Repo } from '@tandem/shared';
import { DiskSpaceError, assertDiskSpace, dependencyDirs, detachDependencies, installKey, linkTree, releaseDependencies, restoreDependencies, saveDependencies } from '../workflow/deps.js';
import { FakeClock, silentLogger } from '../testing/index.js';
import { harness } from './harness.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'tandem-deps-'));
const put = (root: string, rel: string, content: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const repo = { id: 'r1', name: 'app' } as Repo;

/** A repo checkout after `npm ci`: lockfile, a workspace package, installed files and a tool cache. */
function installed(root: string, lock = '{"lockfileVersion":3}') {
  put(root, 'package.json', '{"name":"app","workspaces":["packages/*"]}');
  put(root, 'package-lock.json', lock);
  put(root, 'packages/ui/package.json', '{"name":"ui"}');
  put(root, 'node_modules/left-pad/index.js', 'module.exports = 1;');
  put(root, 'node_modules/left-pad/node_modules/inner/index.js', 'nested');
  put(root, 'node_modules/.cache/eslint.json', 'tool cache');
  put(root, 'packages/ui/node_modules/react/index.js', 'react');
  symlinkSync('../packages/ui', join(root, 'node_modules', 'ui'));
  put(root, 'src/app.ts', 'code');
}

describe('dependency cache', () => {
  it('finds install folders at the root and in workspace packages, not nested ones', async () => {
    const root = tmp();
    installed(root);
    expect(await dependencyDirs(root)).toEqual(['node_modules', join('packages', 'ui', 'node_modules')]);
  });

  it('keys an install by command, lockfile and package.json files; no lockfile, no key', async () => {
    const a = tmp();
    const b = tmp();
    installed(a);
    installed(b);
    const key = await installKey(a, 'npm ci');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(await installKey(b, 'npm ci')).toBe(key);
    expect(await installKey(a, 'npm install')).not.toBe(key);
    put(b, 'packages/ui/package.json', '{"name":"ui","dependencies":{"x":"1"}}');
    expect(await installKey(b, 'npm ci')).not.toBe(key);
    const none = tmp();
    put(none, 'package.json', '{}');
    expect(await installKey(none, 'npm ci')).toBeUndefined();
  });

  it('keeps one copy of an install and gives the next task hard links, without tool caches', async () => {
    const home = tmp();
    const deps = { paths: { home, taskDir: (id: string) => join(home, 'tasks', id), referenceRoot: () => '', referenceDir: () => '' }, clock: new FakeClock(), logger: silentLogger };
    const first = tmp();
    installed(first);
    const key = (await installKey(first, 'npm ci'))!;
    await saveDependencies(deps, repo, first, key, 'npm ci');
    const cached = join(home, 'deps', 'r1', key, 'tree', 'node_modules', 'left-pad', 'index.js');
    expect(statSync(cached).ino).toBe(statSync(join(first, 'node_modules/left-pad/index.js')).ino);
    expect(existsSync(join(home, 'deps', 'r1', key, 'tree', 'node_modules', '.cache'))).toBe(false);

    const second = tmp();
    installed(second);
    await releaseDependencies(second);
    expect(await dependencyDirs(second)).toEqual([]);
    expect(await restoreDependencies(deps, repo, second, key)).toBe(true);
    const file = join(second, 'node_modules/left-pad/index.js');
    expect(readFileSync(file, 'utf8')).toBe('module.exports = 1;');
    expect(statSync(file).ino).toBe(statSync(cached).ino);
    expect(statSync(join(second, 'packages/ui/node_modules/react/index.js')).ino).toBe(statSync(join(first, 'packages/ui/node_modules/react/index.js')).ino);
    expect(readFileSync(join(second, 'node_modules', 'ui', 'package.json'), 'utf8')).toBe('{"name":"ui"}');
    expect(existsSync(join(second, 'node_modules', '.cache'))).toBe(false);

    // A real install never writes into shared links: they are removed first.
    await detachDependencies(second);
    expect(await dependencyDirs(second)).toEqual([]);
    expect(readFileSync(cached, 'utf8')).toBe('module.exports = 1;');
    expect(await restoreDependencies(deps, repo, second, 'missing')).toBe(false);
  });

  it('keeps the three most recently used installs per repo', async () => {
    const home = tmp();
    const clock = new FakeClock(Date.parse('2026-11-03T10:00:00Z'));
    const deps = { paths: { home, taskDir: () => '', referenceRoot: () => '', referenceDir: () => '' }, clock, logger: silentLogger };
    for (let i = 0; i < 5; i++) {
      const root = tmp();
      installed(root, `{"v":${i}}`);
      clock.advance(60_000);
      await saveDependencies(deps, repo, root, (await installKey(root, 'npm ci'))!, 'npm ci');
    }
    expect(readdirSync(join(home, 'deps', 'r1')).filter((n) => !n.startsWith('.'))).toHaveLength(3);
  });

  it('copies a tree with hard links and recreates symlinks', async () => {
    const src = tmp();
    put(src, 'a/b.txt', 'b');
    symlinkSync('b.txt', join(src, 'a', 'link'));
    const dest = join(tmp(), 'copy');
    expect(await linkTree(src, dest)).toBe(1);
    expect(readFileSync(join(dest, 'a', 'link'), 'utf8')).toBe('b');
  });

  it('refuses to install when the disk is nearly full', async () => {
    const home = tmp();
    const settings = async () => ({ limits: { minFreeDiskGb: 1e9 } }) as never;
    await expect(assertDiskSpace({ paths: { home, taskDir: () => '', referenceRoot: () => '', referenceDir: () => '' }, settings })).rejects.toBeInstanceOf(DiskSpaceError);
    await assertDiskSpace({ paths: { home, taskDir: () => '', referenceRoot: () => '', referenceDir: () => '' }, settings: async () => ({ limits: { minFreeDiskGb: 0.5 } }) as never });
  });
});

describe('workflow: dependencies', () => {
  it('reuses an install for the next task with the same lockfile, and frees it while the PR waits', async () => {
    const h = harness();
    await h.ready;
    // The agent's change brings a lockfile; the fake "npm ci" leaves the install it found.
    h.overrides.implement = () => ({ text: 'Done.', edits: [{ path: 'app/package-lock.json', content: '{"lockfileVersion":3}' }, { path: 'app/node_modules/x/index.js', content: 'x' }, { path: 'app/src/health.ts', content: 'export {}' }] });
    const t1 = await h.approveAll((await h.start()).id);
    expect(t1.state).toBe('PR_OPEN');
    const wt1 = join(h.deps.paths.taskDir(t1.id), 'app');
    expect(existsSync(join(wt1, 'node_modules'))).toBe(false);
    const installs = () => h.process.calls.filter((c) => c.command === 'npm ci').length;
    expect(installs()).toBe(1);

    h.overrides.implement = () => ({ text: 'Done.', edits: [{ path: 'app/package-lock.json', content: '{"lockfileVersion":3}' }, { path: 'app/src/health.ts', content: 'export {}' }] });
    const t2 = await h.approveAll((await h.start()).id);
    expect(t2.state).toBe('PR_OPEN');
    expect(installs()).toBe(1);
    const run = (await h.store.verifyRuns.list(t2.id))[0]!;
    expect(run.results.find((r) => r.kind === 'install')).toMatchObject({ exitCode: 0, outputTail: expect.stringContaining('Reused the dependencies installed for an identical lockfile') });
  });

  it('waits on low disk space instead of failing, and continues after space is freed', async () => {
    const h = harness();
    await h.ready;
    const s = await h.store.settings.get();
    await h.store.settings.set({ ...s, limits: { ...s.limits, minFreeDiskGb: 1e9 } });
    let t = await h.approveAll((await h.start()).id);
    expect(t.state).toBe('BLOCKED');
    expect(t.blockedReason).toBe('disk-low');
    expect(t.blockedMessage).toMatch(/GB is free on the disk with Tandem's data/);
    await h.store.settings.set({ ...s, limits: { ...s.limits, minFreeDiskGb: 0.5 } });
    await h.service.resume(t.id);
    await h.runner.runUntilIdle();
    t = await h.get(t.id);
    expect(t.state).toBe('PR_OPEN');
  });
});
