import { existsSync } from 'node:fs';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSecret } from './redact.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SPIKES_DIR = join(here, '..', '..');
export const SANDBOX_DIR = join(SPIKES_DIR, 'sandbox');

// Values for spikes come from the environment or spikes/.env (never committed).
const envFile = join(SPIKES_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export interface SpikeEnv {
  /** SSH URL of a CodeCommit sandbox repo (spikes a, b, c). */
  repoUrl?: string;
  awsProfile?: string;
  awsRegion?: string;
  copilotCliPath?: string;
  model?: string;
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraToken?: string;
  jiraIssue?: string;
  jiraJql: string;
}

function opt(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function spikeEnv(): SpikeEnv {
  const env: SpikeEnv = { jiraJql: opt('JIRA_SPIKE_JQL') ?? 'status = "Ready for AI"' };
  const assign = <K extends keyof SpikeEnv>(key: K, value: SpikeEnv[K] | undefined) => {
    if (value !== undefined) env[key] = value;
  };
  assign('repoUrl', opt('TANDEM_SPIKE_REPO_URL'));
  assign('awsProfile', opt('TANDEM_SPIKE_AWS_PROFILE') ?? opt('AWS_PROFILE'));
  assign('awsRegion', opt('TANDEM_SPIKE_AWS_REGION'));
  assign('copilotCliPath', opt('COPILOT_CLI_PATH'));
  assign('model', opt('TANDEM_SPIKE_MODEL'));
  assign('jiraBaseUrl', opt('JIRA_BASE_URL'));
  assign('jiraEmail', opt('JIRA_EMAIL'));
  assign('jiraToken', opt('JIRA_API_TOKEN'));
  assign('jiraIssue', opt('JIRA_SPIKE_ISSUE'));
  registerSecret(env.jiraToken);
  return env;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export async function workDir(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `tandem-${prefix}-`));
  return { path, cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

/** Copies a sandbox template, without node_modules or build output. */
export async function copyTemplate(template: 'backend' | 'frontend' | 'fullstack', dest: string): Promise<void> {
  const src = join(SANDBOX_DIR, template);
  await cp(src, dest, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|dist|coverage)([\\/]|$)/.test(p.slice(src.length)),
  });
}

export function shortId(): string {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
}
