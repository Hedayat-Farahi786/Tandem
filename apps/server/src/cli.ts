#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeychainSecrets, ScriptedAgent, createTandem, defaultScript } from '@tandem/adapters';
import { runDoctor, type DoctorCheck } from './doctor.js';
import { LEGAL_DIR, VERSION, WEB_DIR, readConfig, startServer } from './start.js';
import { readHostedConfig, startHosted } from './hosted/server.js';
import { startRunner } from './runner.js';
import { Directory } from './hosted/directory.js';
import { backup, restore } from './backup.js';

const ICON: Record<DoctorCheck['status'], string> = { pass: '✔', warn: '!', fail: '✖', skipped: '–' };

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
  } catch {
    // no browser; the URL is printed
  }
}

function printCheck(c: DoctorCheck): void {
  console.log(`  ${ICON[c.status]} ${c.group.padEnd(12)} ${c.label}: ${c.message}`);
  if (c.fix && c.status !== 'pass') console.log(`    ${' '.repeat(12)} → ${c.fix}`);
}

async function doctor(json: boolean): Promise<number> {
  const config = readConfig();
  const t = await createTandem({ home: config.home, overrides: config.overrides, seeds: config.seeds, ...(config.agent === 'scripted' ? { agent: new ScriptedAgent(defaultScript) } : {}) });
  try {
    if (!json) console.log(`Tandem ${VERSION} doctor (${config.home})\n`);
    const report = await runDoctor(t, t.agent, json ? {} : { onCheck: printCheck });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      const fails = report.checks.filter((c) => c.status === 'fail').length;
      const warns = report.checks.filter((c) => c.status === 'warn').length;
      console.log(`\n${fails ? `✖ ${fails} check${fails > 1 ? 's' : ''} failed` : '✔ All required checks pass'}${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}.`);
    }
    return report.ok ? 0 : 1;
  } finally {
    await t.close();
  }
}

async function startHostedMode(): Promise<void> {
  const cfg = readHostedConfig(process.env);
  const h = await startHosted(cfg, { webDir: WEB_DIR, legalDir: LEGAL_DIR });
  console.log(`Tandem ${VERSION} (hosted) is running on ${cfg.listenHost}:${new URL(h.url).port} for ${cfg.publicUrl}`);
  const shutdown = async () => {
    await h.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

async function start(open: boolean): Promise<void> {
  // Hosted: the web app with GitHub sign-in and one workspace per team (see docs/WEB_PLAN.md).
  if (process.env.TANDEM_MODE === 'hosted') return startHostedMode();
  const config = readConfig();
  const r = await startServer(config);
  console.log(`Tandem ${VERSION} is running at ${r.url}`);
  console.log(`Data: ${config.home} · Agent: ${r.tandem.agent.name}${process.env.TANDEM_TEST_REMOTE_ROOT ? " · Test mode: local copies of CodeCommit repos" : ""} · Stop with Ctrl+C`);
  if (r.firstDoctor) {
    console.log('\nFirst launch: running doctor…');
    const report = await r.firstDoctor.catch(() => undefined);
    if (report) for (const c of report.checks) printCheck(c);
    console.log('\nOpen the setup wizard in your browser to add repositories.');
  }
  if (open) openBrowser(r.url);
  const shutdown = async () => {
    console.log('\nStopping Tandem… (unfinished work resumes on the next start)');
    await r.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

/**
 * `tandem runner [--url <web app>] [--key <runner key>]`: a web app workspace, working on this
 * computer. The key goes to the OS keychain and the address to <home>/runner.json, so the next
 * start is just `tandem runner`. Its data lives apart from the local app's (~/.tandem-runner).
 */
async function runner(): Promise<void> {
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const config = readConfig();
  if (!process.env.TANDEM_HOME) config.home = join(homedir(), '.tandem-runner');
  if (!process.env.TANDEM_PORT) config.port = 0;
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const savedFile = join(config.home, 'runner.json');
  const saved = existsSync(savedFile) ? (JSON.parse(readFileSync(savedFile, 'utf8')) as { url?: string }) : {};
  const url = (flag('url') ?? process.env.TANDEM_RUNNER_URL ?? saved.url)?.replace(/\/+$/, '');
  if (!url || !/^https?:\/\//.test(url)) throw new Error('Give the web app\'s address: tandem runner --url https://app.example.com --key <runner key> (Settings › Workspace shows the whole command).');
  const keychain = new KeychainSecrets();
  const given = flag('key') ?? process.env.TANDEM_RUNNER_KEY;
  const key = given ?? (await keychain.get('runner-key').catch(() => undefined));
  if (!key) throw new Error('No runner key yet. An owner makes one in the web app, Settings › Workspace › "Use a company computer", which shows the command to run here.');
  if (flag('key')) {
    const kc = await keychain.available();
    if (kc.ok) await keychain.set('runner-key', key);
    else console.log('No OS keychain here, so the key is not saved: pass it again next time, or set TANDEM_RUNNER_KEY.');
  }
  writeFileSync(savedFile, JSON.stringify({ url }, null, 2), { mode: 0o600 });
  console.log(`Tandem ${VERSION} runner · data in ${config.home}`);
  const r = await startRunner({
    url,
    key,
    config,
    onRefused: (why) => {
      console.error(why);
      void keychain.delete('runner-key').catch(() => undefined);
      void r.stop().finally(() => process.exit(3));
    },
  });
  const shutdown = async () => {
    await r.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

/**
 * `tandem migrate-directory --to postgres://…`: copies the web app's directory from this server's
 * SQLite (TANDEM_HOME/directory.db) into Postgres, before running several replicas.
 */
async function migrateDirectory(): Promise<void> {
  const i = args.indexOf('--to');
  const to = i >= 0 ? args[i + 1] : process.env.TANDEM_DATABASE_URL;
  const home = process.env.TANDEM_HOME;
  const key = process.env.TANDEM_SECRET_KEY;
  if (!to || !/^postgres(ql)?:\/\//.test(to)) throw new Error('Give the Postgres database: tandem migrate-directory --to postgres://…');
  if (!home || !key) throw new Error('Set TANDEM_HOME and TANDEM_SECRET_KEY as the web app has them.');
  const from = join(home.replace(/^~/, homedir()), 'directory.db');
  if (!existsSync(from)) throw new Error(`There is no directory at ${from}.`);
  const source = await Directory.open(from, key);
  const target = await Directory.open(to, key);
  try {
    const counts = await target.copyFrom(source);
    console.log(`Copied ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ')}.`);
  } finally {
    await source.close();
    await target.close();
  }
}

/** `tandem backup --to <folder>` and `tandem restore --from <folder> [--force]`, for TANDEM_HOME (or ~/.tandem). */
async function backupOrRestore(kind: 'backup' | 'restore'): Promise<void> {
  const flagValue = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const home = (process.env.TANDEM_HOME ?? join(homedir(), '.tandem')).replace(/^~/, homedir());
  if (kind === 'backup') {
    const to = flagValue('to');
    if (!to) throw new Error('Say where: tandem backup --to /backups/tandem-2026-11-05');
    const m = await backup(home, to, VERSION);
    console.log(`Backed up ${m.databases.length} database${m.databases.length === 1 ? '' : 's'} from ${home} to ${to}.`);
  } else {
    const from = flagValue('from');
    if (!from) throw new Error('Say which: tandem restore --from /backups/tandem-2026-11-05 (with Tandem stopped)');
    const m = restore(from, home, { force: args.includes('--force') });
    console.log(`Restored ${m.databases.length} database${m.databases.length === 1 ? '' : 's'} from the backup of ${m.createdAt} into ${home}. Start Tandem.`);
  }
}

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'start';
try {
  if (args.includes('--version') || args.includes('-v')) console.log(VERSION);
  else if (cmd === 'doctor') process.exitCode = await doctor(args.includes('--json'));
  else if (cmd === 'start') await start(!args.includes('--no-open'));
  else if (cmd === 'runner') await runner();
  else if (cmd === 'migrate-directory') await migrateDirectory();
  else if (cmd === 'backup' || cmd === 'restore') await backupOrRestore(cmd);
  else {
    console.error(`Unknown command "${cmd}". Use: tandem [start] [--no-open] | tandem doctor [--json] | tandem runner [--url <web app>] [--key <runner key>] | tandem backup --to <folder> | tandem restore --from <folder> [--force] | tandem migrate-directory --to postgres://…`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`Tandem could not ${cmd === 'doctor' ? 'run doctor' : cmd === 'runner' ? 'start the runner' : 'start'}: ${(err as Error).message ?? String(err)}`);
  process.exitCode = 1;
}
