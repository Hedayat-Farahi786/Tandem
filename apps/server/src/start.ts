import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatService, loadConfig, type Logger } from '@tandem/core';
import { ScriptedAgent, createTandem, defaultScript, plainAccess, type TandemOptions, type Tandem } from '@tandem/adapters';
import { pathToFileURL } from 'node:url';
import type { RuntimeConfig } from '@tandem/shared';
import { buildApp } from './app.js';
import { EventBus } from './events.js';
import { createLogger } from './logger.js';
import { runDoctor, type DoctorReport } from './doctor.js';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = join(here, '..', '..', 'web', 'dist');
export const VERSION = (JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

/** Reads .env from the repo root (development) before the typed config. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dotenv = join(here, '..', '..', '..', '.env');
  if (existsSync(dotenv) && env === process.env) process.loadEnvFile(dotenv);
  const e = { ...env };
  if (e.TANDEM_HOME?.startsWith('~')) e.TANDEM_HOME = join(homedir(), e.TANDEM_HOME.slice(1));
  return loadConfig(e, homedir(), join);
}

/**
 * Test mode only (TANDEM_TEST_REMOTE_ROOT set, with either agent): CodeCommit repos are served from
 * local bare repos named <repo>.git, and the PR API answers "access denied", so the console-link
 * fallback is used. Never set for real use; the start banner says when it is on.
 */
function testSeams(): Partial<TandemOptions> {
  const root = process.env.TANDEM_TEST_REMOTE_ROOT;
  if (!root) return {};
  const denied = Object.assign(new Error('AccessDeniedException (test mode)'), { name: 'AccessDeniedException' });
  return {
    codecommit: {
      accessOverride: (repo) => {
        const bare = join(root, `${repo.name}.git`);
        return existsSync(bare) ? plainAccess(pathToFileURL(bare).href) : undefined;
      },
      // Listing repositories works on the local copies (so the picker can be shown); pull requests stay denied.
      api: () => ({
        send: async (cmd: unknown) => {
          const c = cmd as { constructor: { name: string }; input?: { repositoryNames?: string[] } };
          const names = () => readdirSync(root).filter((f) => f.endsWith('.git')).map((f) => f.slice(0, -4)).sort();
          if (c.constructor.name === 'ListRepositoriesCommand') return { repositories: names().map((repositoryName) => ({ repositoryName })) };
          if (c.constructor.name === 'BatchGetRepositoriesCommand') return { repositories: (c.input?.repositoryNames ?? []).map((repositoryName) => ({ repositoryName, defaultBranch: 'main', repositoryDescription: 'Local test copy' })) };
          return Promise.reject(denied);
        },
      }),
      sts: () => ({ send: async () => Promise.reject(denied) }),
    },
  };
}

export interface Running {
  url: string;
  token: string;
  tandem: Tandem;
  bus: EventBus;
  logger: Logger;
  stop(): Promise<void>;
  firstDoctor?: Promise<DoctorReport>;
}

/** Starts the server on 127.0.0.1, recovers interrupted work and starts the runner and pollers. */
export async function startServer(config: RuntimeConfig, o: { webDir?: string; quiet?: boolean } = {}): Promise<Running> {
  const logger = createLogger(join(config.home, 'logs'), config.logLevel === 'silent' ? 'silent' : config.logLevel);
  const bus = new EventBus();
  const tandem = await createTandem({
    home: config.home,
    overrides: config.overrides,
    seeds: config.seeds,
    ...(config.agent === 'scripted' ? { agent: new ScriptedAgent(defaultScript), realModels: process.env.TANDEM_REAL_MODELS === '1' } : {}),
    ...testSeams(),
    events: bus,
    logger,
  });
  if (process.env.TANDEM_TEST_REMOTE_ROOT) logger.warn('test mode: CodeCommit repos are served from local copies', { root: process.env.TANDEM_TEST_REMOTE_ROOT });
  const recovered = await tandem.runner.recover();
  await tandem.service.renameUnbuiltBranches().catch((err: unknown) => logger.warn('could not rename task branches', { error: String(err) }));
  const chat = new ChatService(tandem.deps, tandem.service);
  await chat.nameUntitled().catch((err: unknown) => logger.warn('could not name untitled chats', { error: String(err) }));
  // When a task gets stuck, Tandem asks for help in the task's chat.
  bus.subscribe(({ event: e }) => {
    const stuck = e.type === 'task.blocked' || (e.type === 'task.transition' && (e.to === 'FAILED' || e.to === 'PR_OPEN'));
    if (stuck) void chat.notifyStuck(e.taskId).catch((err: unknown) => logger.warn('could not post to the task chat', { taskId: e.taskId, error: String(err) }));
    if (e.type === 'task.transition' && (e.to === 'PR_OPEN' || e.to === 'DONE')) void chat.notifyResolved(e.taskId).catch((err: unknown) => logger.warn('could not post to the task chat', { taskId: e.taskId, error: String(err) }));
  });
  // Chats can't still be answering after a restart: clear their busy marks and say so in each.
  await chat.clearStaleBusy().catch((err: unknown) => logger.warn('could not clear busy chats', { error: String(err) }));
  // A "needs you" message whose problem was sorted out while Tandem was off (or before it said so).
  for (const t of await tandem.store.tasks.listByState(['PR_OPEN', 'DONE'])) void chat.notifyResolved(t.id).catch(() => undefined);
  const ctx = { tandem, bus, chat, logger, doctor: {} as { last?: DoctorReport; running?: Promise<DoctorReport> } };
  const { app, token, gitKey } = await buildApp(ctx, { port: config.port, webDir: o.webDir ?? WEB_DIR, version: VERSION });
  try {
    await app.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    await tandem.close();
    if ((err as { code?: string }).code === 'EADDRINUSE') throw new Error(`Port ${config.port} is in use. Is Tandem already running? Set TANDEM_PORT to use another port.`, { cause: err });
    throw err;
  }
  // HTTPS git from now on asks Tandem for credentials (AWS connection, connected GitHub account).
  tandem.useGitHelper(config.port, gitKey);
  tandem.runner.start(1_000);

  // Jira: import ready issues on a timer when Jira is configured.
  const jiraTimer = setInterval(() => {
    void (async () => {
      const tracker = await tandem.deps.tracker();
      if (tracker.kind !== 'jira') return;
      // A project with its own query is polled with it. With one project, the Settings query is enough;
      // with several, each needs its own query so an issue can't land in the wrong project.
      const projects = await tandem.store.projects.list();
      for (const p of projects) {
        if (!p.jiraJql?.trim() && projects.length > 1) continue;
        await tandem.service.importFromTracker(p).catch((err: unknown) => logger.warn('jira poll failed', { project: p.id, error: String(err) }));
      }
    })();
  }, Math.max(1, (await tandem.settings()).jira.pollIntervalMin) * 60_000);
  jiraTimer.unref();

  // First launch: run doctor once so the setup wizard can show it.
  let firstDoctor: Promise<DoctorReport> | undefined;
  if ((await tandem.store.projects.list()).length === 0) {
    firstDoctor = runDoctor(tandem, tandem.agent).then((r) => (ctx.doctor.last = r));
    firstDoctor.catch((err: unknown) => logger.warn('first-run doctor failed', { error: String(err) }));
  }
  logger.info('tandem started', { port: config.port, recovered, agent: tandem.agent.name });
  const url = `http://127.0.0.1:${config.port}`;
  let stopping = false;
  return {
    url,
    token,
    tandem,
    bus,
    logger,
    ...(firstDoctor ? { firstDoctor } : {}),
    stop: async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(jiraTimer);
      await app.close();
      // Running steps are not interrupted; whatever is unfinished resumes on the next start.
      await Promise.race([tandem.close(), new Promise((r) => setTimeout(r, 5_000))]);
    },
  };
}
