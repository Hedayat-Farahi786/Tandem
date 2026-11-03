/**
 * Starts Tandem in test mode for the browser tests: a fresh TANDEM_HOME, local bare "remotes"
 * seeded from spikes/sandbox (served instead of CodeCommit), the scripted agent, port 4399.
 *
 *   node e2e/support/serve.mjs            (Playwright's webServer runs this)
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = process.env.TANDEM_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'tandem-e2e-'));
const remotes = join(work, 'remotes');
const home = join(work, 'home');
rmSync(home, { recursive: true, force: true });
// The browser tests' own fixed folder: start from empty (Playwright's results/ aside).
if (process.env.TANDEM_E2E_OWN_DIR === '1' && existsSync(work)) for (const name of readdirSync(work)) if (name !== 'results') rmSync(join(work, name), { recursive: true, force: true });
mkdirSync(remotes, { recursive: true });
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString();

for (const t of ['fullstack', 'backend', 'frontend']) {
  const name = `tandem-sandbox-${t}`;
  const bare = join(remotes, `${name}.git`);
  if (existsSync(bare)) continue;
  git(['init', '--bare', bare]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  const seed = join(work, 'seed', name);
  rmSync(seed, { recursive: true, force: true });
  git(['clone', pathToFileURL(bare).href, seed]);
  git(['checkout', '-b', 'main'], seed);
  const src = join(repoRoot, 'spikes', 'sandbox', t);
  cpSync(src, seed, { recursive: true, filter: (p) => !/[\\/](node_modules|dist|coverage)([\\/]|$)/.test(p.slice(src.length)) });
  git(['add', '-A'], seed);
  git(['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.com', 'commit', '-m', `seed ${t}`], seed);
  git(['push', 'origin', 'HEAD:refs/heads/main'], seed);
}
writeFileSync(join(work, 'README.txt'), `Tandem e2e workspace\nremotes: ${remotes}\nhome: ${home}\n`);

const child = spawn(process.execPath, [join(repoRoot, 'apps', 'server', 'dist', 'cli.js'), 'start', '--no-open'], {
  stdio: 'inherit',
  env: { ...process.env, TANDEM_AGENT: 'scripted', TANDEM_HOME: home, TANDEM_PORT: process.env.TANDEM_PORT ?? '4399', TANDEM_TEST_REMOTE_ROOT: remotes, TANDEM_LOG_LEVEL: 'info', COPILOT_GH_HOST: '' },
});
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => {
  // A workspace this script made for itself goes away with it (sandbox installs are ~600 MB).
  if (!process.env.TANDEM_E2E_DIR) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  process.exit(code ?? 0);
});
