import { detectProject, type DetectedProject } from '@tandem/core';
import { runGit } from './git.js';

/** Reads the default branch of a mirror (no checkout) and detects language, role and commands. */
export async function inspectMirror(mirror: string, ref: string): Promise<DetectedProject> {
  const list = await runGit(['ls-tree', '-r', '--name-only', ref], { gitDir: mirror });
  const files = list.stdout.split('\n').filter(Boolean);
  const cache = new Map<string, string | undefined>();
  const readNow = async (p: string) => {
    if (!cache.has(p)) {
      const r = await runGit(['show', `${ref}:${p}`], { gitDir: mirror, allowFail: true });
      cache.set(p, r.code === 0 ? r.stdout : undefined);
    }
    return cache.get(p);
  };
  // Pre-read the root build files detection looks at, then detect synchronously.
  for (const f of ['package.json', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'go.mod', 'pom.xml']) if (files.includes(f)) await readNow(f);
  return detectProject(files, (p) => cache.get(p));
}
