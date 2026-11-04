import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { runGit } from '@tandem/adapters';
import { HttpError } from './app.js';

/** Where people keep their clones; searched a few levels deep. */
const ROOTS = ['code', 'src', 'source', 'source/repos', 'projects', 'Projects', 'repos', 'repositories', 'workspace', 'workspaces', 'work', 'dev', 'Development', 'git', 'GitHub', 'Documents/GitHub', 'Documents/Code', 'Documents/Projects', 'IdeaProjects', 'WebstormProjects', 'personal'];
const SKIP = new Set(['node_modules', 'Library', 'AppData', 'Applications', 'vendor', 'dist', 'build', 'target', '.cache']);

async function origin(dir: string): Promise<{ remote: string; branch: string } | undefined> {
  const r = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dir, allowFail: true });
  const remote = r.stdout.trim();
  if (r.code !== 0 || !remote) return undefined;
  const b = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFail: true });
  return { remote, branch: b.stdout.trim() };
}

/** Git clones under the usual folders of the home directory (at most 60, three levels deep). */
export async function findLocalClones(home = homedir()): Promise<Array<{ path: string; remote: string; branch: string }>> {
  const out: Array<{ path: string; remote: string; branch: string }> = [];
  const seen = new Set<string>();
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= 60 || visited++ > 4000 || seen.has(dir)) return;
    seen.add(dir);
    if (existsSync(join(dir, '.git'))) {
      const o = await origin(dir);
      if (o) out.push({ path: dir, ...o });
      return;
    }
    if (depth === 0) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) await walk(join(dir, e.name), depth - 1);
  };
  for (const r of ROOTS) {
    const dir = join(home, r);
    if (existsSync(dir)) await walk(dir, 3);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A folder someone points at: a git clone with an origin, inside their home folder. */
export async function readLocalClone(input: string, home = homedir()): Promise<{ path: string; remote: string }> {
  const raw = input.trim().replace(/^~(?=$|[\\/])/, home);
  const path = resolve(isAbsolute(raw) ? raw : join(home, raw));
  const st = await stat(path).catch(() => undefined);
  if (!st?.isDirectory()) throw new HttpError(400, `There is no folder at ${path}.`);
  if (!existsSync(join(path, '.git'))) throw new HttpError(400, `${path} is not a git clone (it has no .git).`);
  const o = await origin(path);
  if (!o) throw new HttpError(400, `${path} has no origin remote. Clone it from GitHub or CodeCommit, or add the origin.`);
  return { path, remote: o.remote };
}
