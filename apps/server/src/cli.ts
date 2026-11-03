#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { ScriptedAgent, createTandem, defaultScript } from '@tandem/adapters';
import { runDoctor, type DoctorCheck } from './doctor.js';
import { VERSION, readConfig, startServer } from './start.js';

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
  const t = await createTandem({ home: config.home, overrides: config.overrides, ...(config.agent === 'scripted' ? { agent: new ScriptedAgent(defaultScript) } : {}) });
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

async function start(open: boolean): Promise<void> {
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

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'start';
try {
  if (args.includes('--version') || args.includes('-v')) console.log(VERSION);
  else if (cmd === 'doctor') process.exitCode = await doctor(args.includes('--json'));
  else if (cmd === 'start') await start(!args.includes('--no-open'));
  else {
    console.error(`Unknown command "${cmd}". Use: tandem [start] [--no-open] | tandem doctor [--json]`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`Tandem could not ${cmd === 'doctor' ? 'run doctor' : 'start'}: ${(err as Error).message ?? String(err)}`);
  process.exitCode = 1;
}
