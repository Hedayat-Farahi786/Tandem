import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/**
 * Reads a file of a checkout only if it really is inside it. A repository can contain symlinks,
 * and a build can make new ones: following `docs/rules.md -> /etc/passwd` (or another workspace's
 * data) into a prompt or a page would hand out files Tandem's server can read. Returns undefined for
 * a missing file or one that leads outside.
 */
export async function readInside(root: string, rel: string): Promise<string | undefined> {
  try {
    const [base, real] = await Promise.all([realpath(root), realpath(join(root, rel))]);
    const r = relative(base, real);
    if (!r || r.startsWith('..') || isAbsolute(r)) return undefined;
    return await readFile(real, 'utf8');
  } catch {
    return undefined;
  }
}
