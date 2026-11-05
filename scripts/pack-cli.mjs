#!/usr/bin/env node
/*
 * Packs the `tandem` command as one npm package (a .tgz) that installs with plain npm:
 *
 *   npm install -g ./tandem-1.0.0.tgz        (or https://app.[domain]/download/tandem.tgz)
 *
 * Tandem's own packages (shared, core, adapters, server) are bundled into one file; the libraries
 * they use stay ordinary dependencies, so npm installs the right native builds (keychain, the
 * Copilot runtime) for the computer. The layout mirrors the repository, so the server finds the web
 * app and its version where it always does. An npm-shrinkwrap.json pins every dependency to what
 * Tandem was tested with, including the patched zod the Copilot SDK runs with.
 *
 * Run after the server's build (npx tsc -b): node scripts/pack-cli.mjs [--out dir]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, 'dist-cli'));
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const rootPkg = read('package.json');
const parts = ['packages/shared', 'packages/core', 'packages/adapters', 'apps/server'].map((p) => read(`${p}/package.json`));
const deps = {};
for (const p of parts)
  for (const [name, version] of Object.entries(p.dependencies ?? {})) {
    if (String(version).startsWith('workspace:')) continue;
    if (deps[name] && deps[name] !== version) throw new Error(`${name} is ${deps[name]} in one package and ${version} in another.`);
    deps[name] = version;
  }
for (const need of ['apps/server/dist/cli.js'])
  if (!existsSync(join(root, need))) throw new Error(`${need} is missing. Build first: npx tsc -b`);

const stage = join(out, 'package');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, 'apps', 'server', 'dist'), { recursive: true });

// One file for Tandem's own code; every library stays outside, required as installed.
const esbuild = createRequire(join(root, 'apps', 'server', 'package.json'))('esbuild');
await esbuild.build({
  entryPoints: [join(root, 'apps', 'server', 'dist', 'cli.js')],
  outfile: join(stage, 'apps', 'server', 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(deps).flatMap((d) => [d, `${d}/*`]),
  // The entry's own "#!/usr/bin/env node" is kept by esbuild.
  logLevel: 'warning',
  legalComments: 'none',
});

// A fresh build of the web app, so no older bundles come along.
execFileSync('pnpm', ['exec', 'vite', 'build', '--logLevel', 'error', '--outDir', join(stage, 'apps', 'web', 'dist'), '--emptyOutDir'], { cwd: join(root, 'apps', 'web'), stdio: 'inherit' });
cpSync(join(root, 'docs', 'legal'), join(stage, 'docs', 'legal'), { recursive: true });
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));
writeFileSync(
  join(stage, 'README.md'),
  `# Tandem\n\nThe \`tandem\` command: a company runner for a workspace of Tandem's web app (\`tandem runner --url … --key …\`), or the web app itself (\`tandem start\`, with a GitHub App).\n\nNeeds Node.js ${rootPkg.engines.node} and git. Run \`tandem doctor\` to check this computer.\n`,
);

// The versions pnpm installed and Tandem's tests ran with, per package name.
const tested = new Map();
for (const m of readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').matchAll(/^ {2}'?(@?[^@\s']+)@([^(:'\s]+)/gm)) {
  const [, name, version] = m;
  tested.set(name, new Set([...(tested.get(name) ?? []), version]));
}

const pkg = {
  name: 'tandem',
  version: rootPkg.version,
  description: 'Tandem: from a chat request to a reviewed pull request. The company runner, and the web app.',
  type: 'module',
  bin: { tandem: 'apps/server/dist/cli.js' },
  engines: rootPkg.engines,
  os: ['linux', 'darwin', 'win32'],
  dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  // Applied while the shrinkwrap is made; the shrinkwrap then carries them to every install.
  overrides: Object.fromEntries(Object.entries(rootPkg.pnpm?.overrides ?? {}).map(([k, v]) => {
    const [parent, child] = k.split('>');
    return child ? [parent, { [child]: v }] : [k, v];
  })),
};

// Pin the whole tree (npm honours a package's own npm-shrinkwrap.json, global installs included)
// to the versions in pnpm-lock.yaml: where npm would pick a newer one, it is held at the tested one.
const npm = (args, cwd = stage) => execFileSync('npm', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const untested = () => {
  const lock = JSON.parse(readFileSync(join(stage, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([k]) => k)
    .map(([k, v]) => [k.split('node_modules/').pop(), v.version])
    .filter(([name, version]) => !tested.get(name)?.has(version));
};
let off = [];
for (let round = 0; round < 4; round++) {
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  rmSync(join(stage, 'package-lock.json'), { force: true });
  npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
  off = untested();
  if (!off.length) break;
  for (const [name] of off) {
    const versions = [...(tested.get(name) ?? [])];
    if (versions.length === 1 && !deps[name]) pkg.overrides[name] = versions[0];
  }
}
if (off.length) throw new Error(`These would install untested versions: ${off.map(([n, v]) => `${n}@${v}`).join(', ')}.`);
npm(['shrinkwrap']);
const file = npm(['pack', '--pack-destination', out, '--json']);
const [{ filename, size, integrity }] = JSON.parse(file);
rmSync(stage, { recursive: true, force: true });
process.stdout.write(`${join(out, filename)}  ${(size / 1e6).toFixed(1)} MB  ${integrity}\n`);
