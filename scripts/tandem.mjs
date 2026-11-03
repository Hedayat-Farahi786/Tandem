#!/usr/bin/env node
/**
 * `pnpm tandem [start|doctor] [...]`: builds Tandem if the build is missing or older than the
 * source, then runs the CLI (apps/server/dist/cli.js) with the same arguments.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'apps', 'server', 'dist', 'cli.js');
const web = join(root, 'apps', 'web', 'dist', 'index.html');
const SKIP = new Set(['node_modules', 'dist', '__tests__', 'test', 'coverage']);

/** Newest modification time of the files that go into the build. */
function newest(path) {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return /\.test\.tsx?$/.test(path) ? 0 : s.mtimeMs;
  let max = 0;
  for (const name of readdirSync(path)) if (!SKIP.has(name)) max = Math.max(max, newest(join(path, name)));
  return max;
}

/** Why a build is needed, if it is: each package's sources against its own build output. */
function outputs() {
  const out = [];
  for (const group of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(root, group))) {
      const dir = join(root, group, pkg);
      if (existsSync(join(dir, 'src'))) out.push([group, pkg, dir, pkg === 'web' ? web : join(dir, 'dist', '.tsbuildinfo')]);
    }
  }
  return out;
}

function stale() {
  if (!existsSync(cli) || !existsSync(web)) return 'no build yet';
  const lock = newest(join(root, 'pnpm-lock.yaml'));
  for (const [group, pkg, dir, out] of outputs()) {
    const built = existsSync(out) ? statSync(out).mtimeMs : 0;
    const inputs = Math.max(newest(join(dir, 'src')), newest(join(dir, 'package.json')), newest(join(dir, 'index.html')), lock);
    if (inputs > built) return `${group}/${pkg} changed since the last build`;
  }
  return undefined;
}

if (!existsSync(join(root, 'node_modules'))) {
  console.error('Install the dependencies first: pnpm install');
  process.exit(1);
}
const why = stale();
if (why) {
  process.stdout.write(`Building Tandem (${why})…\n`);
  const b = spawnSync('pnpm', ['-s', 'build'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  if (b.status !== 0) {
    console.error('The build failed. Run pnpm build to see why.');
    process.exit(b.status ?? 1);
  }
  // TypeScript leaves unchanged outputs alone; mark this build as current so the next start skips it.
  const now = new Date();
  for (const [, , , out] of outputs()) if (existsSync(out)) utimesSync(out, now, now);
}
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? (r.signal ? 1 : 0));
