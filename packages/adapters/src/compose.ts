import { randomUUID } from 'node:crypto';
import type { NamespaceSandbox } from './sandbox/namespace-sandbox.js';
import {
  Runner,
  TaskService,
  SETTING_ENV,
  effectiveSettings,
  seedSettings,
  workflowHandlers,
  type AgentRuntime,
  type Clock,
  type EventSink,
  type Logger,
  type SourceHost,
  type Tracker,
  type WorkflowDeps,
} from '@tandem/core';
import type { Repo, Settings } from '@tandem/shared';
import { CopilotRuntime } from './agent-copilot/copilot-runtime.js';
import { ScriptedAccounts, type CopilotAccounts } from './agent-copilot/accounts.js';
import type { GitHubIdentity } from './agent-copilot/copilot-runtime.js';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AwsConnections } from './aws/aws-connection.js';
import { codeCommitGitCredential, codeCommitRegion } from './aws/codecommit-credential.js';
import { installCredentialHelper, type CredentialRequest } from './git/credential-helper.js';
import { RepoGit } from './git/repo-git.js';
import { tandemPaths } from './paths.js';
import { ShellProcessRunner } from './process/process-runner.js';
import { KeychainSecrets, type SecretStore } from './secrets/keychain.js';
import { CodeCommitHost, type CodeCommitHostOptions } from './source-codecommit/codecommit-host.js';
import { GitHubHost, type GitHubHostOptions } from './source-github/github-host.js';
import { SqliteStore } from './storage-sqlite/sqlite-store.js';
import { JiraTracker } from './tracker-jira/jira-tracker.js';
import { LocalTracker } from './tracker-local/local-tracker.js';

export const systemClock: Clock = { now: () => Date.now(), iso: () => new Date().toISOString() };

export interface TandemOptions {
  home: string;
  /** Settings overrides from the environment (RuntimeConfig.overrides). */
  overrides?: Record<string, unknown>;
  /** Starting values for a new install (RuntimeConfig.seeds): saved once, never locked. */
  seeds?: Record<string, unknown>;
  agent?: AgentRuntime;
  /**
   * With a test agent: list the real Copilot models in the model picker (a free call, no prompts).
   * Picking one doesn't change what the test agent does.
   */
  realModels?: boolean;
  secrets?: SecretStore;
  clock?: Clock;
  events?: EventSink;
  logger?: Logger;
  bootId?: string;
  codecommit?: Partial<Pick<CodeCommitHostOptions, 'api' | 'sts' | 'accessOverride'>>;
  github?: Partial<Pick<GitHubHostOptions, 'fetch' | 'accountToken'>>;
  /**
   * Hosted mode: one workspace of the web app. Its secrets live in the directory (not a keychain),
   * Copilot and GitHub use the workspace's GitHub identity, and nothing of the server's own is
   * reachable: no AWS profiles or default credentials, no SSH keys, no folders on the server.
   */
  hosted?: { secrets: SecretStore; identity: () => Promise<GitHubIdentity | undefined>; accounts: CopilotAccounts };
  /** Tandem's cloud: checks, installs and the Copilot runtime run isolated (see sandbox/namespace-sandbox.ts). */
  sandbox?: NamespaceSandbox;
}

export interface Tandem {
  paths: ReturnType<typeof tandemPaths>;
  store: SqliteStore;
  deps: WorkflowDeps;
  runner: Runner;
  service: TaskService;
  settings: () => Promise<Settings>;
  /** Settings fixed by environment variables when Tandem started ("a.b" path -> variable name). */
  lockedSettings: Record<string, string>;
  codecommit: CodeCommitHost;
  github: GitHubHost;
  secrets: SecretStore;
  agent: AgentRuntime;
  /** Copilot accounts: the runtime's own sign-in, or a pretend one in test mode. */
  accounts: CopilotAccounts;
  /** The AWS connection made in the app, for CodeCommit. */
  aws: AwsConnections;
  /** Answers git's credential requests for the remotes Tandem manages (see credential-helper.ts). */
  gitCredential(req: CredentialRequest): Promise<{ username: string; password: string } | undefined>;
  /** Once the server listens: install the helper (with its own key) and use it for HTTPS git from now on. */
  useGitHelper(port: number, key: string, path?: string): void;
  localTracker: LocalTracker;
  hostFor(repo: Repo): CodeCommitHost | GitHubHost;
  close(): Promise<void>;
}

/** Composition root: wires every adapter into core. Used by the server, the CLI and the e2e tests. */
export async function createTandem(o: TandemOptions): Promise<Tandem> {
  const paths = tandemPaths(o.home);
  const store = await SqliteStore.open(paths.db);
  const clock = o.clock ?? systemClock;
  const ids = () => randomUUID();
  const secrets = o.hosted?.secrets ?? o.secrets ?? new KeychainSecrets();
  const ambient = !o.hosted;
  await seedSettings(store.settings, o.seeds ?? {});
  const settings = async () => effectiveSettings(await store.settings.get(), o.overrides ?? {});

  // The git ops need the hosts' mirror paths and the hosts need the git ops: resolve lazily.
  const hostRef: { current?: { codecommit: CodeCommitHost; github: GitHubHost } } = {};
  const hostFor = (repo: Repo) => (repo.host.kind === 'codecommit' ? hostRef.current!.codecommit : hostRef.current!.github);
  const git = new RepoGit((repo) => hostFor(repo).mirrorPath(repo));
  // Connections made in the app: AWS (for CodeCommit) here, GitHub through the Copilot sign-in.
  const aws = new AwsConnections({ secrets, ...(ambient ? {} : { profiles: () => [] }) });
  const helper: { path?: string } = {};
  const accountsRef: { current?: CopilotAccounts } = {};
  const hosts = {
    codecommit: new CodeCommitHost({ home: paths.home, git, settings, aws, ambient, gitHelper: () => helper.path, ...o.codecommit }),
    github: new GitHubHost({ home: paths.home, settings, secrets, ambient, gitHelper: () => helper.path, accountToken: async (h) => accountsRef.current?.tokenFor(h).catch(() => undefined), ...o.github }),
  };
  hostRef.current = hosts;

  const localTracker = new LocalTracker(store, clock, ids, async () => (await settings()).ownerName || 'Owner');
  let jira: { key: string; tracker: JiraTracker } | undefined;
  const tracker = async (): Promise<Tracker> => {
    const s = await settings();
    if (!s.jira.baseUrl) return localTracker;
    const token = await secrets.get('jira-token');
    if (!token) return localTracker;
    const key = `${s.jira.baseUrl}|${s.jira.email}|${token.length}`;
    if (jira?.key !== key) jira = { key, tracker: new JiraTracker({ baseUrl: s.jira.baseUrl, email: s.jira.email, token }) };
    return jira.tracker;
  };

  // A Copilot sign-in or account switch keeps its host in Settings.
  const useHost = async (host: string) => {
    const s = await store.settings.get();
    if (s && s.copilot.host !== host) await store.settings.set({ ...s, copilot: { ...s.copilot, host } });
  };
  const agent = o.agent ?? new CopilotRuntime({ settings, useHost, home: paths.home, ...(o.hosted ? { identity: o.hosted.identity } : {}), ...(o.sandbox ? { sandbox: o.sandbox } : {}), ...(o.logger ? { logger: o.logger } : {}) });
  const catalog = o.agent && o.realModels ? new CopilotRuntime({ settings, ...(o.logger ? { logger: o.logger } : {}) }) : undefined;
  if (catalog) {
    agent.models = () => catalog.models();
    agent.defaultModel = (tier) => catalog.defaultModel(tier);
  }
  const accounts: CopilotAccounts = o.hosted?.accounts ?? (agent instanceof CopilotRuntime ? agent.accounts : new ScriptedAccounts());
  accountsRef.current = accounts;
  const deps: WorkflowDeps = {
    store,
    clock,
    ids,
    paths,
    hosts: hostFor as (repo: Repo) => SourceHost,
    git,
    tracker,
    agent,
    process: new ShellProcessRunner(o.sandbox),
    settings,
    ...(o.events ? { events: o.events } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  };
  const runner = new Runner({
    store,
    clock,
    bootId: o.bootId ?? randomUUID(),
    handlers: workflowHandlers(deps),
    capacity: async () => {
      const l = (await settings()).limits;
      return { build: l.maxConcurrentBuilds, read: l.maxConcurrentReadOnly, io: 4 };
    },
    ...(o.events ? { events: o.events } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  });
  const service = new TaskService(deps, { onCancel: (id) => runner.abort(id), onWake: () => void runner.tick().catch(() => undefined) });

  return {
    paths,
    store,
    deps,
    runner,
    service,
    settings,
    lockedSettings: Object.fromEntries(Object.keys(o.overrides ?? {}).map((p) => [p, SETTING_ENV[p] ?? 'an environment variable'])),
    codecommit: hosts.codecommit,
    github: hosts.github,
    secrets,
    agent,
    accounts,
    aws,
    gitCredential: async (req) => {
      const host = (req.host ?? '').toLowerCase().replace(/:\d+$/, '');
      if (req.protocol && req.protocol !== 'https') return undefined;
      const region = codeCommitRegion(host);
      if (region) {
        // The AWS connection made in the app; for a local setup from before it, the profile in Settings
        // (or the default chain). Hosted: only the workspace's own connection, never the server's.
        const profile = (await settings()).aws.profile;
        const keys = (await aws.credentials().catch(() => undefined)) ?? (ambient ? await (profile ? fromIni({ profile }) : fromNodeProviderChain())().catch(() => undefined) : undefined);
        return keys ? codeCommitGitCredential(keys, region, host, `/${(req.path ?? '').replace(/^\/+/, '')}`) : undefined;
      }
      if (host === 'github.com' || host.endsWith('.ghe.com')) {
        const token = (await accounts.tokenFor(host).catch(() => undefined)) ?? (await secrets.get('github-token').catch(() => undefined));
        return token ? { username: 'x-access-token', password: token } : undefined;
      }
      return undefined;
    },
    useGitHelper: (port, key, path) => {
      helper.path = installCredentialHelper(paths.home, port, key, path);
    },
    localTracker,
    hostFor,
    close: async () => {
      await runner.stop();
      if (agent instanceof CopilotRuntime) await agent.stop();
      await catalog?.stop();
      store.close();
    },
  };
}
