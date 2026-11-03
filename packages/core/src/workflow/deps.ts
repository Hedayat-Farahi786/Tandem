import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, readlink, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Repo } from '@tandem/shared';
import type { WorkflowDeps } from './context.js';

/**
 * Installed dependencies (node_modules) are 99% of a task's disk use; the git checkout itself shares
 * one history per repo. So installs are cached per repo and lockfile, the way pnpm does it: after a
 * clean install Tandem keeps the dependency folders once, and every later task (or retry) with the
 * same lockfile gets them as hard links, which take no extra space and appear in a second or two.
 * A task waiting on review drops its links; they come back instantly if it needs to run checks.
 */

export class DiskSpaceError extends Error {
  override readonly name = 'DiskSpaceError';
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
/** Tool caches inside node_modules are written in place, so they are never shared. */
const UNSHARED = new Set(['.cache', '.vite', '.tandem-deps']);
const MARKER = '.tandem-deps';
const KEEP_PER_REPO = 3;
const MAX_IDLE_MS = 14 * 86_400_000;
const SEARCH_DEPTH = 4;

const cacheRoot = (deps: Pick<WorkflowDeps, 'paths'>, repo: Repo) => join(deps.paths.home, 'deps', repo.id);

/** node_modules folders an install fills: at the root and in workspace packages, relative to root. */
export async function dependencyDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === '.tandem') continue;
      const child = rel ? join(rel, e.name) : e.name;
      if (e.name === 'node_modules') out.push(child);
      else if (depth < SEARCH_DEPTH) await walk(child, depth + 1);
    }
  };
  await walk('', 0);
  return out.sort();
}

async function manifests(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? join(rel, e.name) : e.name;
      if (e.isFile() && e.name === 'package.json') out.push(child);
      else if (e.isDirectory() && depth < SEARCH_DEPTH && !['node_modules', '.git', '.tandem', 'dist', 'build', 'coverage'].includes(e.name)) await walk(child, depth + 1);
    }
  };
  await walk('', 0);
  return out.sort();
}

/**
 * Identity of an install: the command, the lockfiles, every package.json, and the Node version and
 * platform. Undefined without a lockfile: such an install is not reproducible, so it is not shared.
 */
export async function installKey(root: string, command: string): Promise<string | undefined> {
  const locks = LOCKFILES.filter((f) => existsSync(join(root, f)));
  if (!locks.length) return undefined;
  const h = createHash('sha256');
  h.update(`${command}\0${process.versions.node.split('.')[0]}\0${process.platform}\0${process.arch}\0`);
  for (const f of [...locks, ...(await manifests(root))]) {
    h.update(`${f}\0`);
    h.update(await readFile(join(root, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 32);
}

/** Copies a folder tree as hard links (a plain copy where links are impossible); symlinks are recreated. */
export async function linkTree(src: string, dest: string, skip: (name: string, depth: number) => boolean = () => false, depth = 0): Promise<number> {
  await mkdir(dest, { recursive: true });
  let files = 0;
  const entries = await readdir(src, { withFileTypes: true });
  for (let i = 0; i < entries.length; i += 64) {
    const counts = await Promise.all(
      entries.slice(i, i + 64).map(async (e) => {
        if (skip(e.name, depth)) return 0;
        const s = join(src, e.name);
        const d = join(dest, e.name);
        if (e.isDirectory()) return linkTree(s, d, skip, depth + 1);
        if (e.isSymbolicLink()) {
          const target = await readlink(s);
          const isDir = await stat(s).then((x) => x.isDirectory(), () => false);
          await symlink(target, d, isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
          return 0;
        }
        if (!e.isFile()) return 0;
        await link(s, d).catch(async (err: NodeJS.ErrnoException) => {
          if (['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code ?? '')) await copyFile(s, d);
          else throw err;
        });
        return 1;
      }),
    );
    files += counts.reduce((a, b) => a + b, 0);
  }
  return files;
}

/** Bytes free on the disk that holds `path` (undefined where the platform can't tell). */
export async function freeBytes(path: string): Promise<number | undefined> {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  try {
    const s = await statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

/** Throws DiskSpaceError when the disk under Tandem's home has less free space than the minimum. */
export async function assertDiskSpace(deps: Pick<WorkflowDeps, 'paths' | 'settings'>): Promise<void> {
  const min = (await deps.settings()).limits.minFreeDiskGb;
  const free = await freeBytes(deps.paths.home);
  if (free === undefined || free >= min * 1e9) return;
  throw new DiskSpaceError(`Only ${(free / 1e9).toFixed(1)} GB is free on the disk with Tandem's data (${deps.paths.home}); installing dependencies needs at least ${min} GB. Free some space, then resume.`);
}

/** Removes a worktree's dependency folders; a cached install stays in the cache. */
export async function releaseDependencies(cwd: string): Promise<void> {
  for (const rel of await dependencyDirs(cwd)) await rm(join(cwd, rel), { recursive: true, force: true, maxRetries: 3 });
}

interface CacheManifest {
  key: string;
  command: string;
  dirs: string[];
  files: number;
  createdAt: string;
}

/** Puts the cached install for `key` into the worktree (replacing what is there). False on a cache miss. */
export async function restoreDependencies(deps: Pick<WorkflowDeps, 'paths' | 'clock'>, repo: Repo, cwd: string, key: string): Promise<boolean> {
  const dir = join(cacheRoot(deps, repo), key);
  let manifest: CacheManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as CacheManifest;
  } catch {
    return false;
  }
  await releaseDependencies(cwd);
  for (const rel of manifest.dirs) await linkTree(join(dir, 'tree', rel), join(cwd, rel));
  // The marker says these folders are shared links: a real install removes them first.
  await writeFile(join(cwd, manifest.dirs[0] ?? 'node_modules', MARKER), `${key}\n`);
  await writeFile(join(dir, 'last-used'), deps.clock.iso());
  return true;
}

/** Before a real install: shared links must never be written to, so they are removed first. */
export async function detachDependencies(cwd: string): Promise<void> {
  const dirs = await dependencyDirs(cwd);
  if (dirs.some((rel) => existsSync(join(cwd, rel, MARKER)))) await releaseDependencies(cwd);
}

/** After a clean install: keeps the dependency folders once, as hard links, and trims old entries. */
export async function saveDependencies(deps: Pick<WorkflowDeps, 'paths' | 'clock' | 'logger'>, repo: Repo, cwd: string, key: string, command: string): Promise<void> {
  const root = cacheRoot(deps, repo);
  const final = join(root, key);
  if (existsSync(join(final, 'manifest.json'))) return;
  const dirs = await dependencyDirs(cwd);
  if (!dirs.length) return;
  const tmp = join(root, `.tmp-${randomUUID()}`);
  try {
    let files = 0;
    for (const rel of dirs) files += await linkTree(join(cwd, rel), join(tmp, 'tree', rel), (name, depth) => depth === 0 && UNSHARED.has(name));
    const manifest: CacheManifest = { key, command, dirs, files, createdAt: deps.clock.iso() };
    await writeFile(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(tmp, 'last-used'), deps.clock.iso());
    await rename(tmp, final).catch(async () => rm(tmp, { recursive: true, force: true }));
    await writeFile(join(cwd, dirs[0]!, MARKER), `${key}\n`);
  } catch (err) {
    deps.logger?.warn('could not cache dependencies', { repo: repo.name, error: String(err) });
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  await trimCache(deps, repo, key);
}

/** Keeps the most recently used installs per repo and drops any unused for two weeks. */
async function trimCache(deps: Pick<WorkflowDeps, 'paths' | 'clock'>, repo: Repo, keep: string): Promise<void> {
  const root = cacheRoot(deps, repo);
  const entries = await Promise.all(
    (await readdir(root).catch(() => [] as string[]))
      .filter((n) => !n.startsWith('.'))
      .map(async (name) => ({ name, used: Date.parse(await readFile(join(root, name, 'last-used'), 'utf8').catch(() => '1970-01-01T00:00:00Z')) || 0 })),
  );
  entries.sort((a, b) => b.used - a.used);
  const now = deps.clock.now();
  for (const [i, e] of entries.entries()) {
    if (e.name === keep) continue;
    if (i >= KEEP_PER_REPO || now - e.used > MAX_IDLE_MS) await rm(join(root, e.name), { recursive: true, force: true, maxRetries: 3 });
  }
}

/** How much the dependency cache holds: entries and (unique) files. For doctor. */
export async function cacheSummary(home: string): Promise<{ entries: number; files: number }> {
  let entries = 0;
  let files = 0;
  for (const repo of await readdir(join(home, 'deps')).catch(() => [] as string[])) {
    for (const key of await readdir(join(home, 'deps', repo)).catch(() => [] as string[])) {
      if (key.startsWith('.')) continue;
      const m = await readFile(join(home, 'deps', repo, key, 'manifest.json'), 'utf8').catch(() => '');
      if (!m) continue;
      entries++;
      files += (JSON.parse(m) as CacheManifest).files;
    }
  }
  return { entries, files };
}

