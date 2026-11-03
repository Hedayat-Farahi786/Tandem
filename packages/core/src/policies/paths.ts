import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Resolves symlinks of the longest existing prefix, so a link inside the root can't point outside it. */
export function canonical(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length).replace(/^[\\/]/, ''));
      cur = parent;
    }
  }
}

export function isInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (s: string) => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s);
  const r = canonical(root);
  const t = canonical(isAbsolute(target) ? target : resolve(root, target));
  const rel = relative(fold(r), fold(t));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function touchesGitInternals(root: string, target: string): boolean {
  const t = isAbsolute(target) ? target : resolve(root, target);
  return t.split(/[\\/]/).includes('.git');
}

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}
