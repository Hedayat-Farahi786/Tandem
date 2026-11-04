import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Repo } from '@tandem/shared';
import { git } from './git.js';
import { RepoGit, addWorktree, assertAgentBranch, ensureMirror, plainAccess, pushBranch, rebaseOnto, remoteDefaultBranch, withMirror } from './repo-git.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

/** A bare "remote" with one commit on main, plus a helper clone to make upstream changes. */
async function remote() {
  const root = mkdtempSync(join(tmpdir(), 'tandem-git-it-'));
  const bare = join(root, 'remote.git');
  await git(['init', '--bare', bare]);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { gitDir: bare });
  const url = pathToFileURL(bare).href;
  const seed = join(root, 'seed');
  await git(['clone', url, seed]);
  await git(['checkout', '-b', 'main'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), '# app\n\nline two\n');
  await git(['add', '.'], { cwd: seed });
  await git([...ID, 'commit', '-m', 'init'], { cwd: seed });
  await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: seed });
  const upstream = async (file: string, content: string) => {
    await git(['pull', '--ff-only', 'origin', 'main'], { cwd: seed });
    writeFileSync(join(seed, file), content);
    await git(['add', '.'], { cwd: seed });
    await git([...ID, 'commit', '-m', `upstream ${file}`], { cwd: seed });
    await git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: seed });
  };
  return { root, bare, url, upstream };
}

const repoOf = (_mirror: string): Repo => ({ id: 'r', url: 'x', host: { kind: 'github', owner: 'o', name: 'n' }, name: 'n', defaultBranch: 'main', role: 'other', commands: {}, createdAt: '' });

describe('git layer (real git, local bare remote)', () => {
  it('mirrors, branches, commits, rebases, pushes with a lease and guards refs', async () => {
    const r = await remote();
    const access = plainAccess(r.url);
    expect(await remoteDefaultBranch(access)).toBe('main');
    const mirror = join(r.root, 'mirrors', 'n.git');
    const info = await ensureMirror(mirror, access);
    expect(info.defaultBranch).toBe('main');
    expect(await git(['config', '--get-all', 'remote.origin.fetch'], { gitDir: mirror })).toBe('+refs/heads/*:refs/remotes/origin/*');
    await ensureMirror(mirror, access); // second call fetches, no error

    const wt = join(r.root, 'tasks', 't1', 'n');
    await addWorktree(mirror, { path: wt, branch: 'agent/T-1-x', base: 'origin/main' });
    await addWorktree(mirror, { path: wt, branch: 'agent/T-1-x', base: 'origin/main' }); // idempotent
    const ops = new RepoGit(() => mirror);
    expect(await ops.status(wt)).toEqual([]);
    expect(await ops.commitAll(wt, 'nothing')).toBeUndefined();
    writeFileSync(join(wt, 'feature.txt'), 'x\n');
    expect(await ops.status(wt)).toEqual(['?? feature.txt']);
    const c1 = await ops.commitAll(wt, 'feat: x');
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    // What a check changed (lint --fix) is kept; files a check created (reports) are not.
    expect(await ops.commitTracked(wt, 'nothing')).toBeUndefined();
    writeFileSync(join(wt, 'feature.txt'), 'x fixed\n');
    writeFileSync(join(wt, 'coverage.json'), '{}\n');
    expect(await ops.commitTracked(wt, 'style: keep lint fixes')).toMatch(/^[0-9a-f]{40}$/);
    expect(await ops.status(wt)).toEqual(['?? coverage.json']);
    rmSync(join(wt, 'coverage.json'));
    const c2 = await ops.head(wt);

    await expect(pushBranch(wt, 'main')).rejects.toThrow(/only pushes to branches under agent/);
    const p1 = await pushBranch(wt, 'agent/T-1-x');
    expect(p1).toEqual({ ok: true, sha: c2 });

    await r.upstream('other.txt', 'upstream\n');
    await ensureMirror(mirror, access);
    const rb = await rebaseOnto(wt, 'origin/main');
    expect(rb.kind).toBe('ok');
    expect(await ops.isAncestor(repoOf(mirror), 'origin/main', 'HEAD').catch(() => false)).toBe(false); // HEAD is a worktree ref; checked below
    const stale = await pushBranch(wt, 'agent/T-1-x');
    expect(stale.ok).toBe(false); // non-fast-forward after rebase without a lease
    const leased = await pushBranch(wt, 'agent/T-1-x', c2);
    expect(leased.ok).toBe(true);
    const stat = await ops.diffStat(wt, 'origin/main');
    expect(stat).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(await ops.diff(wt, 'origin/main')).toContain('+x');
  });

  it('detects conflicts, aborts cleanly, and continues after a resolution', async () => {
    const r = await remote();
    const access = plainAccess(r.url);
    const mirror = join(r.root, 'm.git');
    await ensureMirror(mirror, access);
    const wt = join(r.root, 'wt');
    await addWorktree(mirror, { path: wt, branch: 'agent/T-2-y', base: 'origin/main' });
    const ops = new RepoGit(() => mirror);
    writeFileSync(join(wt, 'README.md'), '# mine\n\nline two\n');
    await ops.commitAll(wt, 'mine');
    await r.upstream('README.md', '# theirs\n\nline two\n');
    await ensureMirror(mirror, access);
    const before = await ops.head(wt);
    const rb = await rebaseOnto(wt, 'origin/main');
    expect(rb).toEqual({ kind: 'conflict', files: ['README.md'] });
    expect(await ops.conflictedFiles(wt)).toEqual(['README.md']);
    await ops.abortRebase(wt);
    expect(await ops.head(wt)).toBe(before);
    expect(await ops.status(wt)).toEqual([]);

    expect((await rebaseOnto(wt, 'origin/main')).kind).toBe('conflict');
    writeFileSync(join(wt, 'README.md'), '# mine and theirs\n\nline two\n');
    expect(await ops.conflictedFiles(wt)).toEqual([]); // markers gone: resolved, even before git add
    const head = await ops.continueRebase(wt);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toContain('mine and theirs');
  });

  it('keeps an open PR branch mergeable: probes, merges the base in, resolves, takes others\' commits, resets', async () => {
    const r = await remote();
    const access = plainAccess(r.url);
    const mirror = join(r.root, 'm.git');
    await ensureMirror(mirror, access);
    const wt = join(r.root, 'wt');
    await addWorktree(mirror, { path: wt, branch: 'agent/T-3-z', base: 'origin/main' });
    const ops = new RepoGit(() => mirror);
    const repo = repoOf(mirror);
    writeFileSync(join(wt, 'README.md'), '# mine\n\nline two\n');
    const mine = (await ops.commitAll(wt, 'mine'))!;
    expect((await pushBranch(wt, 'agent/T-3-z')).ok).toBe(true);
    await ensureMirror(mirror, access);
    expect(await ops.remoteHead(repo, 'agent/T-3-z')).toBe(mine);
    expect(await ops.remoteHead(repo, 'nope')).toBeUndefined();
    const b1 = (await ops.remoteHead(repo, 'main'))!;
    expect(await ops.isAncestor(repo, b1, mine)).toBe(true);

    // The base moves without touching our file: mergeable, and the probe leaves no trace.
    await r.upstream('other.txt', 'x\n');
    await ensureMirror(mirror, access);
    const b2 = (await ops.remoteHead(repo, 'main'))!;
    expect(await ops.isAncestor(repo, b2, mine)).toBe(false);
    expect(await ops.probeMerge(wt, b2)).toEqual([]);
    expect(await ops.head(wt)).toBe(mine);
    expect(await ops.status(wt)).toEqual([]);

    // Then it conflicts: the probe names the file and still leaves the worktree as it was.
    await r.upstream('README.md', '# theirs\n\nline two\n');
    await ensureMirror(mirror, access);
    const b3 = (await ops.remoteHead(repo, 'main'))!;
    expect(await ops.probeMerge(wt, b3)).toEqual(['README.md']);
    expect(await ops.head(wt)).toBe(mine);
    expect(await ops.status(wt)).toEqual([]);

    // Merge, give up, merge again, resolve: a merge commit on top of ours, pushed without force.
    expect(await ops.merge(wt, b3, 'Merge main into agent/T-3-z')).toEqual({ kind: 'conflict', files: ['README.md'] });
    await ops.resetTo(wt, mine);
    expect(await ops.head(wt)).toBe(mine);
    expect((await ops.merge(wt, b3, 'Merge main into agent/T-3-z')).kind).toBe('conflict');
    writeFileSync(join(wt, 'README.md'), '# mine and theirs\n\nline two\n');
    expect(await ops.conflictedFiles(wt)).toEqual([]);
    const merged = await ops.continueMerge(wt);
    expect(await git(['log', '-1', '--format=%P%n%s', merged], { cwd: wt })).toBe(`${mine} ${b3}\nMerge main into agent/T-3-z`);
    const pushed = await pushBranch(wt, 'agent/T-3-z');
    expect(pushed).toEqual({ ok: true, sha: merged });
    await ensureMirror(mirror, access);
    expect(await ops.isAncestor(repo, b3, merged)).toBe(true);

    // Someone else adds a commit to the PR branch: Tandem starts from theirs.
    const other = join(r.root, 'other');
    await git(['clone', '--branch', 'agent/T-3-z', r.url, other]);
    writeFileSync(join(other, 'theirs.txt'), 'dev\n');
    await git(['add', '.'], { cwd: other });
    await git([...ID, 'commit', '-m', 'dev commit'], { cwd: other });
    await git(['push', 'origin', 'HEAD:refs/heads/agent/T-3-z'], { cwd: other });
    await ensureMirror(mirror, access);
    const dev = (await ops.remoteHead(repo, 'agent/T-3-z'))!;
    expect(await ops.isAncestor(repo, merged, dev)).toBe(true);
    await ops.resetTo(wt, dev);
    expect(readFileSync(join(wt, 'theirs.txt'), 'utf8')).toBe('dev\n');
  });

  it('keeps a detached reference checkout up to date and cleans worktrees up', async () => {
    const r = await remote();
    const access = plainAccess(r.url);
    const mirror = join(r.root, 'm.git');
    await ensureMirror(mirror, access);
    const ref = join(r.root, 'projects', 'p', 'n');
    await addWorktree(mirror, { path: ref, branch: 'main', base: 'origin/main', detach: true });
    expect(readFileSync(join(ref, 'README.md'), 'utf8')).toContain('# app');
    await r.upstream('README.md', '# updated\n');
    await ensureMirror(mirror, access);
    writeFileSync(join(ref, 'stray.txt'), 'x');
    await addWorktree(mirror, { path: ref, branch: 'main', base: 'origin/main', detach: true });
    expect(readFileSync(join(ref, 'README.md'), 'utf8')).toContain('# updated');
    const ops = new RepoGit(() => mirror);
    expect(await ops.status(ref)).toEqual([]);
    await ops.removeWorktree(repoOf(mirror), ref);
    expect(await git(['worktree', 'list'], { gitDir: mirror })).not.toContain(ref);
  });

  it('recovers from a `git worktree add` killed half-way (placeholder HEAD): fetch works, the task gets a fresh worktree', async () => {
    const r = await remote();
    const access = plainAccess(r.url);
    const mirror = join(r.root, 'm.git');
    await ensureMirror(mirror, access);
    const wt = join(r.root, 'tasks', 't1', 'n');
    await addWorktree(mirror, { path: wt, branch: 'agent/T-1-x', base: 'origin/main' });
    // What git leaves when killed between writing its placeholder HEAD and the real one.
    const [admin] = readdirSync(join(mirror, 'worktrees'));
    writeFileSync(join(mirror, 'worktrees', admin!, 'HEAD'), `${'0'.repeat(40)}\n`);
    await expect(git(['fetch', '--prune', '--no-tags', 'origin'], { gitDir: mirror })).rejects.toThrow(/bad object/);

    await r.upstream('NEW.md', 'new\n');
    await ensureMirror(mirror, access); // repairs, then fetches
    expect(existsSync(wt)).toBe(false);
    expect(await git(['rev-parse', 'origin/main:NEW.md'], { gitDir: mirror })).toMatch(/^[0-9a-f]{40}$/);
    await addWorktree(mirror, { path: wt, branch: 'agent/T-1-x', base: 'origin/main' });
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toContain('# app');
    expect(await new RepoGit(() => mirror).status(wt)).toEqual([]);
  });

  it('completes a half-done checkout on resume, keeps a worktree with commits, and removes broken ones', async () => {
    const r = await remote();
    const access = plainAccess(r.url);
    const mirror = join(r.root, 'm.git');
    await ensureMirror(mirror, access);
    const ops = new RepoGit(() => mirror);
    const wt = join(r.root, 'tasks', 't2', 'n');
    const opts = { path: wt, branch: 'agent/T-2-x', base: 'origin/main' };
    await addWorktree(mirror, opts);
    rmSync(join(wt, 'README.md')); // a checkout killed before writing every file
    await addWorktree(mirror, opts); // resumed prepare
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toContain('# app');

    writeFileSync(join(wt, 'work.txt'), 'agent work\n');
    await ops.commitAll(wt, 'work');
    writeFileSync(join(wt, 'uncommitted.txt'), 'more\n');
    await addWorktree(mirror, opts); // a sound worktree with its own commits is left alone
    expect(readFileSync(join(wt, 'uncommitted.txt'), 'utf8')).toBe('more\n');

    const [admin] = readdirSync(join(mirror, 'worktrees'));
    writeFileSync(join(mirror, 'worktrees', admin!, 'HEAD'), `${'0'.repeat(40)}\n`);
    await ops.removeWorktree(repoOf(mirror), wt);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(mirror, 'worktrees'))).toBe(false);
  });

  it('runs one operation at a time per mirror', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      order.push(`${name}+`);
      await new Promise((res) => setTimeout(res, ms));
      order.push(`${name}-`);
      if (name === 'b') throw new Error('b failed');
      return name;
    };
    const results = await Promise.allSettled([withMirror('/m1', slow('a', 30)), withMirror('/m1', slow('b', 5)), withMirror('/m1', slow('c', 5)), withMirror('/m2', slow('x', 1))]);
    expect(results.map((x) => x.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    expect(order.filter((o) => !o.startsWith('x'))).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
    expect(order.indexOf('x+')).toBeLessThan(order.indexOf('a-'));
  });

  it('refuses dangerous branch names', () => {
    for (const bad of ['main', 'refs/heads/main', 'agent', 'agent/', 'agent/../main', 'agent/a b', 'agent/x:y', 'refs/tags/v1', 'agent/x.lock', 'agent//x']) {
      expect(() => assertAgentBranch(bad), bad).toThrow();
    }
    expect(assertAgentBranch('agent/TND-1-health')).toBe('refs/heads/agent/TND-1-health');
  });
});
