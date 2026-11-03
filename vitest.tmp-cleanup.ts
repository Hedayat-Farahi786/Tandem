import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests create their own temporary folders (tandem-core-…, tandem-git-it-…). This removes the ones
 * created during this run when it ends, so repeated runs don't fill the disk. Folders that existed
 * before the run, and e2e workspaces (which clean up themselves), are left alone.
 */
const TEST_DIR = /^tandem-(?!e2e-|flows-)[a-z][a-z-]*-[A-Za-z0-9]{6}$/;

export default function setup() {
  const started = Date.now() - 2_000;
  return () => {
    for (const name of readdirSync(tmpdir())) {
      if (!TEST_DIR.test(name)) continue;
      const path = join(tmpdir(), name);
      try {
        const s = statSync(path);
        if ((s.birthtimeMs || s.ctimeMs) >= started) rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // already gone or not ours
      }
    }
  };
}
