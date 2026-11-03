import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CopilotRuntime, JiraTracker, type Tandem } from '@tandem/adapters';
import type { AgentRuntime, PreflightCheck } from '@tandem/core';

const pexec = promisify(execFile);

export interface DoctorCheck {
  id: string;
  group: 'Tools' | 'Copilot' | 'Repositories' | 'AWS' | 'Jira' | 'Machine';
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  message: string;
  fix?: string;
}

export interface DoctorReport {
  at: string;
  ok: boolean;
  checks: DoctorCheck[];
}

const semver = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
const atLeast = (v: string, min: string) => {
  const a = semver(v);
  const b = semver(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

async function version(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await pexec(cmd, args, { timeout: 15_000, windowsHide: true, shell: process.platform === 'win32' });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Runs every check. Nothing here sends a prompt to a model. */
export async function runDoctor(t: Tandem, agent: AgentRuntime, opts: { onCheck?: (c: DoctorCheck) => void } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => {
    checks.push(c);
    opts.onCheck?.(c);
  };

  // Tools
  const node = process.versions.node;
  add(atLeast(node, '22.13.0') ? { id: 'node', group: 'Tools', label: 'Node.js', status: 'pass', message: `Node ${node}.` } : { id: 'node', group: 'Tools', label: 'Node.js', status: 'fail', message: `Node ${node} is too old.`, fix: 'Install Node 22.13 or newer (https://nodejs.org).' });
  const gitV = (await version('git', ['--version']))?.replace(/^git version\s+/, '');
  add(
    gitV && atLeast(gitV, '2.25.0')
      ? { id: 'git', group: 'Tools', label: 'Git', status: 'pass', message: `git ${gitV}.` }
      : { id: 'git', group: 'Tools', label: 'Git', status: 'fail', message: gitV ? `git ${gitV} is too old.` : 'git was not found.', fix: 'Install git 2.25 or newer and make sure it is on PATH.' },
  );
  const settings = await t.settings();
  const repos = await t.store.repos.list();
  if (repos.some((r) => r.host.kind === 'codecommit' && !r.url.startsWith('ssh://'))) {
    const aws = await version('aws', ['--version']);
    add(aws ? { id: 'aws-cli', group: 'Tools', label: 'AWS CLI', status: 'pass', message: aws.split(' ')[0]! } : { id: 'aws-cli', group: 'Tools', label: 'AWS CLI', status: 'fail', message: 'The AWS CLI was not found; git needs it to sign in to CodeCommit over HTTPS.', fix: 'Install AWS CLI v2 (https://aws.amazon.com/cli/).' });
  }

  // Machine
  try {
    const s = await statfs(t.paths.home);
    const freeGb = (s.bavail * s.bsize) / 1024 ** 3;
    add({ id: 'disk', group: 'Machine', label: 'Disk space', status: freeGb < 1 ? 'fail' : freeGb < 5 ? 'warn' : 'pass', message: `${freeGb.toFixed(1)} GB free under ${t.paths.home}.`, ...(freeGb < 5 ? { fix: 'Free some space: each task needs a copy of its repos and their dependencies.' } : {}) });
  } catch (err) {
    add({ id: 'disk', group: 'Machine', label: 'Disk space', status: 'warn', message: `Could not check: ${String(err)}` });
  }
  const kc = await t.secrets.available();
  add(kc.ok ? { id: 'keychain', group: 'Machine', label: 'OS keychain', status: 'pass', message: kc.message } : { id: 'keychain', group: 'Machine', label: 'OS keychain', status: settings.jira.baseUrl ? 'fail' : 'warn', message: kc.message, fix: 'Only needed to save a Jira or GitHub token. Tandem never stores secrets in files.' });

  // Copilot
  if (agent instanceof CopilotRuntime) {
    const c = await agent.check();
    if (!c.version) add({ id: 'copilot-runtime', group: 'Copilot', label: 'Copilot runtime', status: 'fail', message: c.error ?? 'The Copilot runtime did not start.', fix: 'Reinstall dependencies (pnpm install), or set COPILOT_CLI_PATH to your installed copilot binary.' });
    else add({ id: 'copilot-runtime', group: 'Copilot', label: 'Copilot runtime', status: 'pass', message: `Runtime ${c.version}.` });
    if (c.version) {
      add(
        c.authenticated
          ? { id: 'copilot-auth', group: 'Copilot', label: 'Signed in', status: 'pass', message: `Signed in as ${c.login ?? 'unknown'}${c.host ? ` on ${c.host.replace(/^https:\/\//, '')}` : ''} (${c.authType ?? 'existing login'}).` }
          : { id: 'copilot-auth', group: 'Copilot', label: 'Signed in', status: 'fail', message: c.error ?? 'Not signed in.', fix: 'Run copilot and use /login, or sign in the GitHub CLI (gh auth login) on the host that provides your Copilot.' },
      );
    }
    if (c.authenticated) {
      if (c.models?.length) {
        add({ id: 'copilot-models', group: 'Copilot', label: 'Copilot access', status: 'pass', message: `${c.models.filter((m) => m.policy?.state !== 'disabled').length} models available.` });
      } else {
        const accounts = await version('gh', ['auth', 'status']);
        const others = [...(accounts ?? '').matchAll(/Logged in to (\S+) account (\S+)/g)].map((m) => m[1]!).filter((h) => h !== (settings.copilot.host || 'github.com'));
        add({
          id: 'copilot-models',
          group: 'Copilot',
          label: 'Copilot access',
          status: 'fail',
          message: `This account can't use Copilot here (${(c.error ?? 'no models').slice(0, 160)}).`,
          fix: others.length ? `If your Copilot comes from ${others.join(' or ')}, set the Copilot host to it in Settings.` : 'Ask your admin to enable the "Copilot CLI" policy for you.',
        });
      }
      const ws = mkdtempSync(join(tmpdir(), 'tandem-doctor-'));
      try {
        const st = await agent.selfTest(ws);
        add(st.failures.length === 0 ? { id: 'copilot-safety', group: 'Copilot', label: 'Safety rules', status: 'pass', message: `${st.denied} of ${st.total} forbidden actions blocked in the runtime (no model calls).` } : { id: 'copilot-safety', group: 'Copilot', label: 'Safety rules', status: 'fail', message: st.failures.join('; '), fix: 'Do not run builds until this passes; report it with the Tandem logs.' });
      } catch (err) {
        add({ id: 'copilot-safety', group: 'Copilot', label: 'Safety rules', status: 'warn', message: `Self-test could not run: ${String((err as Error).message ?? err)}` });
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    }
  } else {
    add({ id: 'copilot-runtime', group: 'Copilot', label: 'Copilot runtime', status: 'skipped', message: `Using the ${agent.name} agent (test mode).` });
  }

  // Repositories and AWS
  if (repos.length === 0) add({ id: 'repos', group: 'Repositories', label: 'Repositories', status: 'skipped', message: 'No repositories added yet.', fix: 'Add them in the setup wizard.' });
  const awsSeen = new Set<string>();
  for (const repo of repos) {
    let pre: PreflightCheck[];
    try {
      pre = await t.hostFor(repo).preflight(repo);
    } catch (err) {
      pre = [{ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'fail', message: String((err as Error).message ?? err) }];
    }
    for (const p of pre) {
      const group = p.id.startsWith('read:') ? 'Repositories' : 'AWS';
      if (group === 'AWS' && p.id.startsWith('aws:')) {
        if (awsSeen.has(p.message)) continue;
        awsSeen.add(p.message);
      }
      add({ id: p.id, group, label: p.label, status: p.status, message: p.message, ...(p.fix ? { fix: p.fix } : {}) });
    }
  }

  // Jira
  const token = settings.jira.baseUrl ? await t.secrets.get('jira-token') : undefined;
  if (!settings.jira.baseUrl || !token) {
    add({ id: 'jira', group: 'Jira', label: 'Jira', status: 'skipped', message: 'Not configured (optional).', fix: 'Add the Jira URL and a token in Settings when you want to use Jira.' });
  } else {
    try {
      const me = await new JiraTracker({ baseUrl: settings.jira.baseUrl, email: settings.jira.email, token }).myself();
      add({ id: 'jira', group: 'Jira', label: 'Jira', status: 'pass', message: `Signed in as ${me.name}.` });
    } catch (err) {
      add({ id: 'jira', group: 'Jira', label: 'Jira', status: 'fail', message: String((err as Error).message ?? err), fix: 'Check the Jira URL, email and token in Settings.' });
    }
  }
  return { at: new Date().toISOString(), ok: !checks.some((c) => c.status === 'fail'), checks };
}
