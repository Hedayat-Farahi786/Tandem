import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { loadConfig, type Logger } from '@tandem/core';
import type { RuntimeConfig } from '@tandem/shared';
import { JiraError, NamespaceSandbox, atlassianOAuth, guardWorktrees, restrictOutbound, serverRoleSource, type Fetch as JiraFetch, type JiraOAuth, type RoleSource } from '@tandem/adapters';
import { createLogger } from '../logger.js';
import { openCell, type Cell } from '../start.js';
import { JiraFrom, jiraBack } from '../routes/jira.js';
import { Directory, type Session } from './directory.js';
import { legalPage } from './legal-pages.js';
import { signInPage } from './sign-in-page.js';
import { RunnerHub, safeRunnerHeaders } from './runner-hub.js';
import { Metrics, RateLimiter, type Policy } from './limits.js';
import { GitHubTokens, WorkspaceAccounts, WorkspaceSecrets } from './workspace.js';

/*
 * Tandem as a hosted web app. One front server: GitHub sign-in, sessions, workspaces. Behind it,
 * one cell per workspace (its own database, engine and runner), reached only through the front.
 * Every request is checked here first: signed in, member of the workspace, and for changes, the
 * session's own CSRF token. Cookies are host-only, HttpOnly, Secure and SameSite=Lax.
 */

export const HostedConfig = z.object({
  home: z.string().min(1),
  /** 0 picks a free port (tests). */
  port: z.number().int().min(0).max(65535),
  listenHost: z.string().default('0.0.0.0'),
  /** The app's public address, e.g. https://app.example.com (no trailing slash). */
  publicUrl: z.string().url().transform((u) => u.replace(/\/+$/, '')),
  github: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    /** Test seams: GitHub's web and API addresses. */
    webUrl: z.string().url().default('https://github.com'),
    apiUrl: z.string().url().default('https://api.github.com'),
    /** The GitHub App's URL name (github.com/apps/<slug>), for "install on your account or organization". */
    appSlug: z.string().optional(),
    /** The GitHub App's webhook secret: with it, pull request changes reach tasks at once (else they are polled). */
    webhookSecret: z.string().min(16).optional(),
  }),
  /** 32 random bytes, base64: seals stored tokens. */
  secretKey: z.string().min(40),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  agent: z.enum(['copilot', 'scripted']).default('copilot'),
  /** Operator settings for every workspace (models, build limits), as "a.b" paths. */
  overrides: z.record(z.string(), z.unknown()).default({}),
  /** Starting values for a new workspace (its Copilot budget), which its owners can change. */
  seeds: z.record(z.string(), z.unknown()).default({}),
  /**
   * CodeCommit through roles in customers' accounts: this server's own AWS identity (its instance
   * or task role) assumes them, and is used for nothing else.
   */
  aws: z
    .object({
      roleSource: z.boolean().default(false),
      /** The ARN customers' roles trust, when it can't be read from the identity (a role with a path). */
      principal: z.string().optional(),
      /** The role template on S3, for CloudFormation's one-click "quick create" link. */
      templateUrl: z.string().url().optional(),
    })
    .default({ roleSource: false }),
  /** Builds in the cloud run isolated ('on'); 'off' only for trying Tandem out, never with real users. */
  sandbox: z.enum(['on', 'off']).default('on'),
  /** Postgres for the directory, shared by every replica; without it, SQLite in `home` (one replica). */
  databaseUrl: z.string().regex(/^postgres(ql)?:\/\//, 'TANDEM_DATABASE_URL must be a postgres:// URL.').optional(),
  /** Who may sign up: anyone with GitHub, or only people invited (and the GitHub logins listed). */
  signup: z.object({ mode: z.enum(['open', 'invite']).default('open'), allow: z.array(z.string()).default([]) }).default({ mode: 'open', allow: [] }),
  /** Quotas per person and workspace (abuse brakes; Copilot use has its own budget). */
  limits: z
    .object({ workspacesPerPerson: z.number().int().min(1).default(10), membersPerWorkspace: z.number().int().min(2).default(100), invitesPerDay: z.number().int().min(1).default(50) })
    .default({ workspacesPerPerson: 10, membersPerWorkspace: 100, invitesPerDay: 50 }),
  /** How many proxies in front add X-Forwarded-For (the load balancer: 1); a client's own entries are ignored. */
  trustProxy: z.number().int().min(0).max(5).default(1),
  /** Tandem's Atlassian app, for "Connect Jira" with Atlassian's sign-in (callback <publicUrl>/auth/jira/callback). */
  jira: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }).optional(),
  /** The `tandem` command as an npm package (scripts/pack-cli.mjs), offered at /download/tandem.tgz for company runners. */
  cliPackage: z.string().optional(),
  /** Bearer token for GET /metrics (Prometheus); without it, /metrics is off. */
  metricsToken: z.string().min(16).optional(),
  /** This replica: a stable name (a StatefulSet pod's), and where the other replicas reach it. */
  replica: z.object({ id: z.string().regex(/^[\w.-]{1,100}$/).default('main'), url: z.string().url().optional() }).default({ id: 'main' }),
});
export type HostedConfig = z.infer<typeof HostedConfig>;

/** Hosted settings from the environment; every address is configuration, none is in the code. */
export function readHostedConfig(env: NodeJS.ProcessEnv): HostedConfig {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required in hosted mode.`);
    return v;
  };
  return HostedConfig.parse({
    home: need('TANDEM_HOME'),
    port: Number(env.TANDEM_PORT ?? 8080),
    listenHost: env.TANDEM_LISTEN_HOST ?? '0.0.0.0',
    publicUrl: need('TANDEM_PUBLIC_URL'),
    github: { clientId: need('TANDEM_GITHUB_CLIENT_ID'), clientSecret: need('TANDEM_GITHUB_CLIENT_SECRET'), ...(env.TANDEM_GITHUB_APP_SLUG ? { appSlug: env.TANDEM_GITHUB_APP_SLUG } : {}), ...(env.TANDEM_GITHUB_WEBHOOK_SECRET ? { webhookSecret: env.TANDEM_GITHUB_WEBHOOK_SECRET } : {}), ...(env.TANDEM_GITHUB_WEB_URL ? { webUrl: env.TANDEM_GITHUB_WEB_URL } : {}), ...(env.TANDEM_GITHUB_API_URL ? { apiUrl: env.TANDEM_GITHUB_API_URL } : {}) },
    secretKey: need('TANDEM_SECRET_KEY'),
    logLevel: env.TANDEM_LOG_LEVEL ?? 'info',
    agent: env.TANDEM_AGENT ?? 'copilot',
    sandbox: env.TANDEM_SANDBOX === 'off' ? 'off' : 'on',
    ...(env.TANDEM_DATABASE_URL ? { databaseUrl: env.TANDEM_DATABASE_URL } : {}),
    signup: { mode: env.TANDEM_SIGNUP === 'invite' ? 'invite' : 'open', allow: (env.TANDEM_SIGNUP_ALLOW ?? '').split(',').map((x) => x.trim()).filter(Boolean) },
    limits: {
      ...(env.TANDEM_LIMIT_WORKSPACES_PER_PERSON ? { workspacesPerPerson: Number(env.TANDEM_LIMIT_WORKSPACES_PER_PERSON) } : {}),
      ...(env.TANDEM_LIMIT_MEMBERS_PER_WORKSPACE ? { membersPerWorkspace: Number(env.TANDEM_LIMIT_MEMBERS_PER_WORKSPACE) } : {}),
      ...(env.TANDEM_LIMIT_INVITES_PER_DAY ? { invitesPerDay: Number(env.TANDEM_LIMIT_INVITES_PER_DAY) } : {}),
    },
    ...(env.TANDEM_METRICS_TOKEN ? { metricsToken: env.TANDEM_METRICS_TOKEN } : {}),
    ...(env.TANDEM_CLI_PACKAGE ? { cliPackage: env.TANDEM_CLI_PACKAGE } : {}),
    ...(env.TANDEM_JIRA_CLIENT_ID && env.TANDEM_JIRA_CLIENT_SECRET ? { jira: { clientId: env.TANDEM_JIRA_CLIENT_ID.trim(), clientSecret: env.TANDEM_JIRA_CLIENT_SECRET.trim() } } : {}),
    ...(env.TANDEM_TRUST_PROXY ? { trustProxy: Number(env.TANDEM_TRUST_PROXY) } : {}),
    replica: { id: env.TANDEM_REPLICA_ID || (env.TANDEM_DATABASE_URL ? hostname() : 'main'), ...(env.TANDEM_REPLICA_URL ? { url: env.TANDEM_REPLICA_URL } : {}) },
    aws: { roleSource: env.TANDEM_AWS_ROLE_SOURCE === 'on', ...(env.TANDEM_AWS_ROLE_PRINCIPAL ? { principal: env.TANDEM_AWS_ROLE_PRINCIPAL } : {}), ...(env.TANDEM_AWS_TEMPLATE_URL ? { templateUrl: env.TANDEM_AWS_TEMPLATE_URL } : {}) },
    ...operatorSettings(env),
  });
}

/** The same TANDEM_* settings as the local app, without the ones that would reach this server's own AWS. */
function operatorSettings(env: NodeJS.ProcessEnv): { overrides: Record<string, unknown>; seeds: Record<string, unknown> } {
  const rest = { ...env };
  delete rest.TANDEM_HOST;
  delete rest.TANDEM_AWS_PROFILE;
  const c = loadConfig(rest, '/', join);
  const overrides = Object.fromEntries(Object.entries(c.overrides).filter(([k]) => !k.startsWith('aws.')));
  return { overrides, seeds: c.seeds };
}

const SESSION = 'tandem_session';
const OAUTH = 'tandem_oauth';
const JIRA = 'tandem_jira';
const JOIN = 'tandem_join';
const CELL_HOST = 'cell.tandem.internal';
/** Changes only an owner makes: settings, and the workspace's connections and secrets. */
const OWNER_ONLY = /^\/api\/(settings|secrets|aws|copilot|jira)(\/|\?|$)/;

/** What a cloud workspace's builds see: their own workspace folder, without its database, logs or the git helper's key. */
function cellSandbox(hostedHome: string, home: string) {
  return {
    hide: [resolve(hostedHome)],
    keep: [home],
    readOnly: [join(home, 'mirrors'), join(home, 'projects')],
    mask: [
      ...['tandem.db', 'tandem.db-wal', 'tandem.db-shm', 'tandem.db-journal', join('bin', 'git-credential.json'), 'logs'].map((f) => join(home, f)),
      // The server user's credentials, and secrets mounted by Docker or Kubernetes (the service account's token).
      ...['.ssh', '.aws', '.config', '.gitconfig', '.git-credentials', '.npmrc', '.netrc', '.docker', '.kube', '.copilot', '.tandem', '.tandem-runner'].map((f) => join(homedir(), f)),
      '/run/secrets',
      '/var/run/secrets',
    ],
  };
}

/** Before any build: isolation works on this server, or Tandem doesn't start. */
async function provesIsolation(hostedHome: string, workspacesRoot: string): Promise<void> {
  const probe = join(workspacesRoot, `.probe-${randomBytes(6).toString('hex')}`);
  const hidden = join(hostedHome, `.probe-hidden-${randomBytes(6).toString('hex')}`);
  mkdirSync(join(probe, 'mirrors'), { recursive: true });
  writeFileSync(join(probe, 'tandem.db'), 'probe');
  writeFileSync(hidden, 'hidden');
  try {
    const sbx = new NamespaceSandbox(cellSandbox(hostedHome, probe));
    const r = await sbx.selfTest({ hidden, kept: probe, readOnly: join(probe, 'mirrors'), masked: join(probe, 'tandem.db') });
    if (!r.ok) throw new Error(r.message);
  } catch (err) {
    throw new Error(
      `Tandem can't isolate builds on this server (${(err as Error).message}). It needs Linux user namespaces: in Docker, run the container with --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined (see docs/DEPLOYMENT.md). Only to try Tandem out, without real users, set TANDEM_SANDBOX=off.`,
      { cause: err },
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
    rmSync(hidden, { force: true });
  }
}
const RUNNER_OFFLINE = "This workspace works on a company computer, and its runner isn't connected right now. Start it there with: tandem runner";

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface Hosted {
  url: string;
  app: FastifyInstance;
  directory: Directory;
  cells: Map<string, Promise<Cell>>;
  hub: RunnerHub;
  replicaId: string;
  stop(): Promise<void>;
}

/** Headers never passed on to a workspace (or between replicas): the person's own, and the connection's. */
const DROP = new Set(['cookie', 'origin', 'host', 'x-tandem-token', 'x-tandem-actor', 'x-tandem-git-key', 'x-tandem-internal', 'content-length', 'authorization', 'connection', 'upgrade', 'keep-alive', 'transfer-encoding']);
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);
const OWNER_MOVED = "This workspace's server is restarting. Try again in a moment.";
/** Rate limits per replica: per address for sign-in, invitations, webhooks and runners; per session for the API. */
const POLICIES = {
  auth: { burst: 20, perMinute: 30 },
  hook: { burst: 200, perMinute: 600 },
  runner: { burst: 10, perMinute: 20 },
  read: { burst: 300, perMinute: 900 },
  write: { burst: 60, perMinute: 180 },
  // Each chat message is a Copilot turn.
  chat: { burst: 10, perMinute: 20 },
  download: { burst: 10, perMinute: 10 },
} satisfies Record<string, Policy>;

export async function startHosted(input: z.input<typeof HostedConfig>, o: { webDir?: string; legalDir?: string; fetch?: typeof fetch; awsRoleSource?: RoleSource } = {}): Promise<Hosted> {
  const cfg = HostedConfig.parse(input);
  const http = o.fetch ?? fetch;
  mkdirSync(join(cfg.home, 'workspaces'), { recursive: true, mode: 0o700 });
  const logger: Logger = createLogger(join(cfg.home, 'logs'), cfg.logLevel === 'silent' ? 'silent' : cfg.logLevel, { stdout: cfg.logLevel !== 'silent' });
  const metrics = new Metrics();
  const limiter = new RateLimiter();
  const directory = await Directory.open(cfg.databaseUrl ?? join(cfg.home, 'directory.db'), cfg.secretKey);
  const workspacesRoot = resolve(cfg.home, 'workspaces');
  // Addresses people type (Jira, repository hosts) may only lead to public services.
  restrictOutbound(true);
  const awsRoleSource = o.awsRoleSource ?? (cfg.aws.roleSource ? await serverRoleSource(cfg.aws.principal) : undefined);
  if (awsRoleSource) logger.info('customers can connect CodeCommit with a role', { principal: awsRoleSource.principal });
  if (cfg.sandbox === 'on') {
    await provesIsolation(cfg.home, workspacesRoot);
    guardWorktrees([workspacesRoot]);
  } else logger.warn('builds are NOT isolated (TANDEM_SANDBOX=off): never use this with real users');
  const tokens = new GitHubTokens(directory, { clientId: cfg.github.clientId, clientSecret: cfg.github.clientSecret, webUrl: cfg.github.webUrl, slug: cfg.github.appSlug }, http);
  const installUrl = cfg.github.appSlug ? `${cfg.github.webUrl}/apps/${cfg.github.appSlug}/installations/new` : undefined;
  const secure = cfg.publicUrl.startsWith('https://');
  const cookie = (name: string, value: string, maxAgeSec: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  const me = cfg.replica.id;
  /** Replicas prove themselves to each other with a key derived from the shared secret. */
  const internalKey = createHmac('sha256', Buffer.from(cfg.secretKey, 'base64')).update('tandem-internal-v1').digest('base64url');
  const isInternal = (req: FastifyRequest) => {
    const given = String(req.headers['x-tandem-internal'] ?? '');
    return given.length === internalKey.length && timingSafeEqual(Buffer.from(given), Buffer.from(internalKey));
  };

  /* ---------------------------------------------------------------- cells (the workspaces this replica runs) */

  const cells = new Map<string, Promise<Cell>>();
  // Known once the server listens (the git helper of each cell calls back on it).
  let listenPort = cfg.port;
  const cellHome = (id: string) => {
    const dir = resolve(workspacesRoot, id);
    if (!dir.startsWith(workspacesRoot + sep)) throw new Error('Bad workspace id.');
    return dir;
  };
  // Jira: Tandem's Atlassian app. The front starts the sign-in and takes Atlassian's answer; cells
  // renew their tokens with it, and company runners ask the front to renew theirs.
  const jiraApp = cfg.jira ? atlassianOAuth({ clientId: cfg.jira.clientId, clientSecret: cfg.jira.clientSecret, redirectUri: `${cfg.publicUrl}/auth/jira/callback`, ...(o.fetch ? { fetch: o.fetch as unknown as JiraFetch } : {}) }) : undefined;
  const cellJira: JiraOAuth | undefined = jiraApp ? { available: () => true, refresh: (t) => jiraApp.refresh(t) } : undefined;

  const cellFor = (id: string): Promise<Cell> => {
    let c = cells.get(id);
    if (!c) {
      const home = cellHome(id);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // The Copilot program and the GitHub API address are the operator's: a member could otherwise run
      // a program of theirs on this server, or send the workspace's GitHub token elsewhere.
      const overrides = { ...cfg.overrides, 'copilot.cliPath': cfg.overrides['copilot.cliPath'] ?? '', 'github.apiBase': 'https://api.github.com' };
      const config: RuntimeConfig = { home, host: '127.0.0.1', port: listenPort, logLevel: cfg.logLevel, agent: cfg.agent, overrides, seeds: cfg.seeds };
      const accounts = new WorkspaceAccounts(directory, id, tokens);
      const hosted = { secrets: new WorkspaceSecrets(directory, id), identity: () => accounts.identity(), accounts, githubInstallUrl: installUrl, awsRoleSource, awsTemplateUrl: cfg.aws.templateUrl };
      const sandbox = cfg.sandbox === 'on' ? new NamespaceSandbox(cellSandbox(cfg.home, home)) : undefined;
      c = openCell({ home, config, logger, webDir: undefined, port: listenPort, allowedHost: CELL_HOST, hosted, ...(sandbox ? { sandbox } : {}), ...(cellJira ? { jiraOAuth: cellJira } : {}), ...(o.fetch ? { jiraFetch: o.fetch as unknown as JiraFetch } : {}) }).then(async (cell) => {
        await cell.app.ready();
        await cell.start(listenPort, `/cells/${id}/git/credential`);
        return cell;
      });
      c.catch((err: unknown) => {
        cells.delete(id);
        logger.error('workspace could not open', { workspace: id, error: String(err) });
      });
      cells.set(id, c);
    }
    return c;
  };
  const closeCell = async (id: string) => {
    const cell = cells.get(id);
    cells.delete(id);
    if (cell) await (await cell.catch(() => undefined))?.stop();
  };

  /* ---------------------------------------------------------------- replicas */

  /** Where to reach a replica, when it is alive. */
  const replicaUrl = async (id: string): Promise<string | undefined> => {
    if (id === me) return undefined;
    const r = await directory.replica(id);
    return r && r.seenAt > Date.now() - 45_000 ? r.url : undefined;
  };
  /** Sends a request to another replica's internal routes; resolves with its answer. */
  const callReplica = async (url: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(new URL(path, url), { method: 'POST', headers: { ...extra, 'content-type': 'application/json', 'x-tandem-internal': internalKey }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  /** Things done to a workspace where it runs: open it, close it, delete its files, let its runner go. */
  type Action = 'open' | 'close' | 'purge' | 'disconnect';
  const actLocally = async (id: string, action: Action, reason = '') => {
    if (action === 'open') {
      if ((await directory.runnerMode(id)) === 'cloud' && (await directory.workspaceReplica(id)) === me) void cellFor(id);
    } else if (action === 'close') await closeCell(id);
    else if (action === 'purge') {
      hub.disconnect(id, 'This workspace was deleted.');
      await closeCell(id);
      rmSync(cellHome(id), { recursive: true, force: true });
    } else hub.disconnect(id, reason);
  };
  /** Does `action` on the replica that runs the workspace (and, for its runner, wherever it is connected). */
  const act = async (id: string, action: Action, reason = '') => {
    const owner = (await directory.workspaceReplica(id)) ?? me;
    const runnerAt = action === 'disconnect' || action === 'purge' ? (await directory.runnerOf(id))?.connectedReplica : undefined;
    const targets = new Set([owner, ...(runnerAt ? [runnerAt] : [])]);
    for (const t of targets) {
      if (t === me) await actLocally(id, action, reason);
      else {
        const url = await replicaUrl(t);
        if (url) await callReplica(url, `/internal/workspaces/${id}/${action}`, { reason }).catch((err: unknown) => logger.warn('replica did not answer', { replica: t, action, error: String(err) }));
      }
    }
  };
  /** Joins an invitation's workspace, unless it has no room left. */
  const joinInvite = async (token: string, userId: string) => {
    const target = await directory.inviteTarget(token);
    if (!target) return undefined;
    if (!(await directory.roleIn(target, userId)) && (await directory.memberCount(target)) >= cfg.limits.membersPerWorkspace) return 'full' as const;
    return directory.acceptInvite(token, userId);
  };
  /** A new workspace goes to the replica running the fewest; that replica opens it. */
  const newWorkspace = async (name: string, ownerId: string) => {
    const w = await directory.createWorkspace(name, ownerId, await directory.quietestReplica(me));
    await act(w.id, 'open');
    return w;
  };
  const heartbeat = async () => {
    await directory.replicaSeen(me, cfg.replica.url ?? `http://127.0.0.1:${listenPort}`).catch((err: unknown) => logger.warn('could not record this replica', { error: String(err) }));
  };

  /* ---------------------------------------------------------------- app */

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: (_addr: string, hop: number) => hop < cfg.trustProxy, forceCloseConnections: true });
  /** The client's address as the trusted proxies saw it (for upgrades, which Fastify doesn't parse). */
  const clientIp = (forwarded: string | string[] | undefined, socket: string | undefined) => {
    const hops = String(forwarded ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return (cfg.trustProxy && hops.length ? hops[Math.max(0, hops.length - cfg.trustProxy)] : undefined) ?? socket ?? '';
  };
  const publicHost = new URL(cfg.publicUrl).host;
  const knownHost = (host: string | undefined) => host === publicHost || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? '');
  const hub = new RunnerHub({
    authenticate: async (token, req) => {
      if (!knownHost(req.headers.host)) return undefined;
      const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
      if (limiter.take(`runner:${ip}`, POLICIES.runner)) return 429;
      return (await directory.runnerByToken(token))?.workspaceId;
    },
    welcome: async (id) => ({ workspace: (await directory.workspace(id))?.name ?? '', jiraSignIn: Boolean(jiraApp) }),
    seen: (id, machine) => directory.runnerSeen(id, machine),
    connected: (id, here) => directory.runnerConnected(id, here ? me : undefined, me),
    logger,
  });
  hub.attach(app.server);
  app.addHook('onRequest', async (req, reply) => {
    // Replicas call each other by their own addresses, with the internal key; everyone else only on the public address.
    if (req.url.startsWith('/internal/')) return isInternal(req) ? undefined : reply.code(404).send({ error: 'Not found.' });
    // Probes and the metrics scraper call the pod's own address.
    if (/^\/(healthz|readyz|metrics)(\?|$)/.test(req.url)) return undefined;
    // Only the public address (and loopback, for health checks and the git helper).
    const host = req.headers.host ?? '';
    if (!knownHost(host)) return reply.code(421).send({ error: 'Unknown host.' });
    const origin = req.headers.origin;
    if (origin && origin !== cfg.publicUrl) return reply.code(403).send({ error: 'Requests from other sites are not allowed.' });
    return undefined;
  });
  // Rate limits, per address or session; and every answer counted (streamed ones too).
  app.addHook('onRequest', async (req, reply) => {
    const started = process.hrtime.bigint();
    reply.raw.once('finish', () => {
      const route = req.routeOptions.url ?? 'unmatched';
      metrics.count('tandem_http_requests_total', 'Requests answered.', { method: req.method, route, status: String(reply.raw.statusCode) });
      metrics.time(route, Number(process.hrtime.bigint() - started) / 1e9);
    });
    const path = req.url.split('?')[0]!;
    let policy: keyof typeof POLICIES | undefined;
    let who = `ip:${req.ip}`;
    if (/^\/(auth|join)\//.test(path)) policy = 'auth';
    else if (path === '/hooks/github') policy = 'hook';
    else if (path.startsWith('/download/')) policy = 'download';
    else if (path.startsWith('/runner/')) policy = 'runner';
    else if (path.startsWith('/api/')) {
      const sid = cookies(req)[SESSION];
      if (sid) who = `s:${createHmac('sha256', internalKey).update(sid).digest('base64url').slice(0, 22)}`;
      policy = req.method === 'POST' && /^\/api\/threads\/[^/]+\/messages$/.test(path) ? 'chat' : writes(req) ? 'write' : 'read';
    }
    if (!policy) return undefined;
    const wait = limiter.take(`${policy}:${who}`, POLICIES[policy]);
    if (!wait) return undefined;
    metrics.count('tandem_rate_limited_total', 'Requests refused by a rate limit.', { policy });
    return reply.code(429).header('Retry-After', String(wait)).send({ error: `Too many requests. Try again in ${wait} second${wait === 1 ? '' : 's'}.` });
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    return payload;
  });

  const sessionOf = async (req: FastifyRequest): Promise<{ id: string; session: Session } | undefined> => {
    const id = cookies(req)[SESSION];
    const session = await directory.session(id);
    return id && session ? { id, session } : undefined;
  };
  const writes = (req: FastifyRequest) => req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  /** Signed in, and for a change, carrying the session's CSRF token. */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await sessionOf(req);
    if (!s) {
      void reply.code(401).send({ error: 'Sign in to continue.', signIn: true });
      return undefined;
    }
    if (writes(req) && !Directory.csrfMatches(s.session, req.headers['x-tandem-token'] as string | undefined)) {
      void reply.code(403).send({ error: 'Your session changed. Reload the page.' });
      return undefined;
    }
    return s;
  };
  /** The workspace the session is in; someone removed from their last one gets a new one of their own. */
  const currentWorkspace = async (s: { id: string; session: Session }) => {
    const mine = await directory.workspacesOf(s.session.userId);
    const w = mine.find((x) => x.id === s.session.workspaceId) ?? mine[0];
    if (w) return w;
    const user = await directory.user(s.session.userId);
    if (!user) return undefined;
    const fresh = await newWorkspace(`${user.name}'s workspace`, user.id);
    await directory.useWorkspace(s.id, fresh.id);
    return (await directory.workspacesOf(user.id)).find((x) => x.id === fresh.id);
  };

  // The join page's form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.get('/healthz', async () => ({ ok: true, replica: me }));
  /** Ready for traffic: the directory answers. */
  app.get('/readyz', async (_req, reply) => {
    try {
      await directory.ping();
      return { ok: true, replica: me };
    } catch {
      return reply.code(503).send({ ok: false, replica: me, error: 'The directory database does not answer.' });
    }
  });
  app.get('/metrics', async (req, reply) => {
    const want = cfg.metricsToken;
    const given = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) return reply.code(404).send({ error: 'Not found.' });
    return reply.type('text/plain; version=0.0.4').header('Cache-Control', 'no-store').send(await metrics.text());
  });
  metrics.gauge('tandem_workspaces_running', 'Cloud workspaces running on this replica.', async () => [[{ replica: me }, cells.size]]);
  metrics.gauge('tandem_runners_connected', 'Company runners connected to this replica.', async () => [[{ replica: me }, hub.count()]]);
  metrics.gauge('tandem_replicas_live', 'Replicas seen in the last 45 seconds.', async () => [[{}, (await directory.liveReplicas()).length]]);
  metrics.gauge('tandem_tasks', "Tasks of this replica's cloud workspaces, by state.", async () => {
    const by = new Map<string, number>();
    for (const c of cells.values()) {
      const cell = await c.catch(() => undefined);
      for (const t of (await cell?.tandem.store.tasks.list().catch(() => [])) ?? []) by.set(t.state, (by.get(t.state) ?? 0) + 1);
    }
    return [...by].map(([state, n]) => [{ replica: me, state }, n]);
  });
  metrics.gauge('process_resident_memory_bytes', 'Memory in use.', async () => [[{ replica: me }, process.memoryUsage.rss()]]);

  /* ---------------------------------------------------------------- GitHub sign-in */

  app.get('/auth/github', async (_req, reply) => {
    const state = randomBytes(24).toString('base64url');
    const url = new URL('/login/oauth/authorize', cfg.github.webUrl);
    url.searchParams.set('client_id', cfg.github.clientId);
    url.searchParams.set('redirect_uri', `${cfg.publicUrl}/auth/github/callback`);
    url.searchParams.set('state', state);
    return reply.header('Set-Cookie', cookie(OAUTH, state, 600)).redirect(url.toString());
  });

  app.get('/auth/github/callback', async (req, reply) => {
    const q = z.object({ code: z.string().min(1).max(200).optional(), state: z.string().max(200).optional(), error: z.string().optional() }).parse(req.query);
    const expected = cookies(req)[OAUTH];
    reply.header('Set-Cookie', cookie(OAUTH, '', 0));
    if (q.error || !q.code || !q.state || !expected || q.state !== expected) return reply.code(400).type('text/html').send(signInPage({ error: q.error === 'access_denied' ? 'You cancelled the sign-in on GitHub.' : 'The sign-in could not be completed. Please try again.' }));
    const tokenRes = await http(new URL('/login/oauth/access_token', cfg.github.webUrl), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cfg.github.clientId, client_secret: cfg.github.clientSecret, code: q.code, redirect_uri: `${cfg.publicUrl}/auth/github/callback` }),
    });
    const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string };
    if (!tok.access_token) return reply.code(400).type('text/html').send(signInPage({ error: 'GitHub did not complete the sign-in. Please try again.' }));
    const userRes = await http(new URL('/user', cfg.github.apiUrl), { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tandem' } });
    if (!userRes.ok) return reply.code(502).type('text/html').send(signInPage({ error: 'GitHub is not answering right now. Please try again.' }));
    const gh = (await userRes.json()) as { id: number; login: string; name?: string | null; email?: string | null; avatar_url?: string | null };
    const join = cookies(req)[JOIN];
    // Invite-only: people already here, people with a valid invitation, and the logins listed.
    if (cfg.signup.mode === 'invite') {
      const known = await directory.userByGitHubId(gh.id);
      const invited = join ? await directory.inviteTarget(join) : undefined;
      if (!known && !invited && !cfg.signup.allow.some((l) => l.toLowerCase() === gh.login.toLowerCase())) {
        metrics.count('tandem_signins_total', 'GitHub sign-ins.', { result: 'not-invited' });
        return reply.code(403).type('text/html').send(signInPage({ error: 'Tandem is invite-only for now. Ask someone in a workspace for an invitation link.' }));
      }
    }
    const user = await directory.upsertGitHubUser({ id: gh.id, login: gh.login, name: gh.name ?? null, email: gh.email ?? null, avatarUrl: gh.avatar_url ?? null });
    const now = Date.now();
    await directory.saveGitHubTokens(user.id, { access: tok.access_token, ...(tok.expires_in ? { accessExpiresAt: now + tok.expires_in * 1000 } : {}), ...(tok.refresh_token ? { refresh: tok.refresh_token } : {}), ...(tok.refresh_token_expires_in ? { refreshExpiresAt: now + tok.refresh_token_expires_in * 1000 } : {}) });
    metrics.count('tandem_signins_total', 'GitHub sign-ins.', { result: 'ok' });
    const workspaces = await directory.workspacesOf(user.id);
    const workspace = workspaces[0] ?? (await newWorkspace(`${user.name}'s workspace`, user.id));
    const { id } = await directory.createSession(user.id, workspace.id);
    logger.info('signed in', { user: user.id });
    // Came from an invitation link: they confirm joining on its page (a link alone never moves anyone).
    const next = join && (await directory.inviteTarget(join)) ? `/join/${encodeURIComponent(join)}` : '/';
    return reply.header('Set-Cookie', [cookie(SESSION, id, 14 * 86_400), cookie(OAUTH, '', 0), ...(join ? [cookie(JOIN, '', 0)] : [])]).redirect(next);
  });

  app.post('/auth/sign-out', async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    await directory.endSession(s.id);
    return reply.header('Set-Cookie', cookie(SESSION, '', 0)).send({ ok: true });
  });

  /* ---------------------------------------------------------------- account and workspaces */

  app.get('/api/me', async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const user = (await directory.user(s.session.userId))!;
    const current = await currentWorkspace(s);
    return { user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl }, workspaces: await directory.workspacesOf(user.id), current: current?.id ?? null };
  });

  app.post('/api/workspaces', async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const { name } = z.object({ name: z.string().trim().min(1, 'Give the workspace a name.').max(80) }).parse(req.body);
    if ((await directory.ownedBy(s.session.userId)) >= cfg.limits.workspacesPerPerson) return reply.code(409).send({ error: `You own ${cfg.limits.workspacesPerPerson} workspaces, the most one person can. Delete one first, or ask to have the limit raised.` });
    const w = await newWorkspace(name, s.session.userId);
    await directory.useWorkspace(s.id, w.id);
    return w;
  });

  app.post('/api/workspaces/:id/use', async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await directory.roleIn(id, s.session.userId))) return reply.code(404).send({ error: 'No such workspace.' });
    await directory.useWorkspace(s.id, id);
    return { ok: true };
  });

  /** GDPR: what Tandem keeps about the person in the directory (workspace data has its own export). */
  app.get('/api/me/export', async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const user = (await directory.user(s.session.userId))!;
    return reply.header('Content-Disposition', 'attachment; filename="tandem-account.json"').send({ exportedAt: new Date().toISOString(), user, workspaces: await directory.workspacesOf(user.id) });
  });

  /** GDPR: delete the account; workspaces the person alone owned are deleted with all their data. */
  app.delete('/api/me', async (req, reply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const orphans = await directory.deleteUser(s.session.userId);
    for (const w of orphans) {
      await act(w, 'purge');
      await directory.deleteWorkspace(w);
    }
    logger.info('account deleted', { workspacesDeleted: orphans.length });
    return reply.header('Set-Cookie', cookie(SESSION, '', 0)).send({ ok: true, workspacesDeleted: orphans.length });
  });

  /* ---------------------------------------------------------------- the workspace: Copilot plan, members, invitations */

  /** The signed-in person and their role in the workspace they are in. */
  const inWorkspace = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await signedIn(req, reply);
    if (!s) return undefined;
    const w = await currentWorkspace(s);
    const role = w ? await directory.roleIn(w.id, s.session.userId) : undefined;
    if (!w || !role) {
      void reply.code(403).send({ error: 'You are not a member of a workspace yet.' });
      return undefined;
    }
    return { s, w, role };
  };
  const ownerOnly = (ctx: { role: string } | undefined, reply: FastifyReply) => {
    if (ctx && ctx.role !== 'owner') {
      void reply.code(403).send({ error: 'Only an owner of the workspace can do that.' });
      return false;
    }
    return Boolean(ctx);
  };

  /** Copilot (and GitHub) in this workspace from now on run on the signed-in person's plan. */
  app.post('/api/copilot/use-mine', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!c) return reply;
    if (!(await tokens.identity(c.s.session.userId))) return reply.code(409).send({ error: 'Your GitHub sign-in has expired. Sign out and in again first.' });
    await directory.setCopilotUser(c.w.id, c.s.session.userId);
    return { ok: true };
  });

  app.get('/api/workspace', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!c) return reply;
    const copilot = await directory.copilotUser(c.w.id);
    const members = await directory.members(c.w.id);
    return { id: c.w.id, name: c.w.name, role: c.role, me: c.s.session.userId, copilotUserId: copilot ?? null, runner: await runnerInfo(c.w.id), members: members.map((m) => ({ id: m.id, login: m.login, name: m.name, avatarUrl: m.avatarUrl, role: m.role })) };
  });

  app.patch('/api/workspace', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const { name } = z.object({ name: z.string().trim().min(1, 'Give the workspace a name.').max(80) }).parse(req.body);
    await directory.renameWorkspace(c!.w.id, name);
    return { ok: true };
  });

  app.post('/api/workspace/invites', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const { role } = z.object({ role: z.enum(['owner', 'member']).default('member') }).parse(req.body ?? {});
    if ((await directory.invitesSince(c!.w.id, Date.now() - 86_400_000)) >= cfg.limits.invitesPerDay) return reply.code(429).send({ error: `This workspace made ${cfg.limits.invitesPerDay} invitations in the last day, the most it can. Try again tomorrow.` });
    if ((await directory.memberCount(c!.w.id)) >= cfg.limits.membersPerWorkspace) return reply.code(409).send({ error: `This workspace has ${cfg.limits.membersPerWorkspace} members, the most it can.` });
    const token = await directory.createInvite(c!.w.id, c!.s.session.userId, role);
    return { url: `${cfg.publicUrl}/join/${token}`, expiresInDays: 7 };
  });

  app.post('/api/workspace/members/:userId/role', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { role } = z.object({ role: z.enum(['owner', 'member']) }).parse(req.body);
    const current = await directory.roleIn(c!.w.id, userId);
    if (!current) return reply.code(404).send({ error: 'Not a member.' });
    if (role === 'member' && current === 'owner' && (await directory.owners(c!.w.id)) <= 1) return reply.code(409).send({ error: 'A workspace needs at least one owner.' });
    await directory.setRole(c!.w.id, userId, role);
    return { ok: true };
  });

  /** An owner removes a member, or a member leaves. */
  app.delete('/api/workspace/members/:userId', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!c) return reply;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (userId !== c.s.session.userId && c.role !== 'owner') return reply.code(403).send({ error: 'Only an owner can remove others.' });
    if ((await directory.roleIn(c.w.id, userId)) === 'owner' && (await directory.owners(c.w.id)) <= 1) return reply.code(409).send({ error: 'A workspace needs at least one owner. Make someone else an owner first, or delete the workspace.' });
    await directory.removeMember(c.w.id, userId);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- where the workspace works */

  /** Whether the workspace's runner is connected, to this replica or another live one. */
  const runnerInfo = async (id: string) => {
    const mode = await directory.runnerMode(id);
    const key = await directory.runnerOf(id);
    const local = hub.status(id);
    const elsewhere = !local && key?.connectedReplica && key.connectedReplica !== me && (await replicaUrl(key.connectedReplica)) ? key : undefined;
    const connectedAt = local ? local.connectedAt : elsewhere?.connectedAt;
    const machine = local?.machine ?? key?.machine;
    return { mode, connected: Boolean(local || elsewhere), ...(machine ? { machine } : {}), ...(local?.version ? { version: local.version } : {}), ...(connectedAt ? { connectedAt: new Date(connectedAt).toISOString() } : {}), ...(key?.lastSeenAt ? { lastSeenAt: new Date(key.lastSeenAt).toISOString() } : {}) };
  };
  const runnerCommand = (token: string) => `tandem runner --url ${cfg.publicUrl} --key ${token}`;
  /** How a company computer gets the `tandem` command: from this web app, when it offers the package. */
  const cliPackage = cfg.cliPackage && existsSync(cfg.cliPackage) ? cfg.cliPackage : undefined;
  if (cfg.cliPackage && !cliPackage) logger.warn('TANDEM_CLI_PACKAGE does not exist; /download/tandem.tgz is off', { cliPackage: cfg.cliPackage });
  const installCommand = cliPackage ? `npm install -g ${cfg.publicUrl}/download/tandem.tgz` : undefined;

  /**
   * An owner moves the workspace to a company computer (or gives its runner a new key): from now on
   * its data, repositories and sign-ins live there. What the workspace had in the cloud is kept,
   * untouched, for when it moves back.
   */
  app.post('/api/workspace/runner', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const id = c!.w.id;
    await act(id, 'disconnect', 'This runner key was replaced.');
    const token = await directory.useCompanyRunner(id, c!.s.session.userId);
    await act(id, 'close');
    logger.info('workspace uses a company runner', { workspace: id });
    return { key: token, command: runnerCommand(token), ...(installCommand ? { install: installCommand } : {}), runner: await runnerInfo(id) };
  });

  /** An owner moves the workspace back to Tandem's cloud; the runner's key stops working. */
  app.delete('/api/workspace/runner', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const id = c!.w.id;
    await act(id, 'disconnect', 'This workspace works in the cloud again.');
    await directory.useCloudRunner(id);
    await act(id, 'open');
    logger.info('workspace back in the cloud', { workspace: id });
    return { runner: await runnerInfo(id) };
  });

  /** An owner deletes the workspace with everything in it. */
  app.delete('/api/workspace', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const id = c!.w.id;
    await act(id, 'purge');
    await directory.deleteWorkspace(id);
    logger.info('workspace deleted', { workspace: id });
    return { ok: true };
  });

  /**
   * An invitation link shows what joining means and asks; joining is a POST with the session's
   * token. A link alone (opened from an email or a page) never moves anyone into a workspace.
   */
  app.get('/join/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    reply.type('text/html').header('Cache-Control', 'no-store').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const s = await sessionOf(req);
    if (!s) return reply.header('Set-Cookie', cookie(JOIN, token, 1800)).send(signInPage({ note: "You've been invited to a workspace. Sign in with GitHub to join it." }));
    const info = await directory.inviteInfo(token);
    const w = info ? await directory.workspace(info.workspaceId) : undefined;
    if (!info || !w) return reply.code(410).send(signInPage({ error: 'This invitation has expired. Ask for a new link.', signedIn: true }));
    if (await directory.roleIn(w.id, s.session.userId)) {
      await directory.useWorkspace(s.id, w.id);
      return reply.redirect('/');
    }
    const inviter = await directory.user(info.createdBy);
    return reply.send(signInPage({ join: { workspace: w.name, inviter: inviter?.name, csrf: s.session.csrf, action: `/join/${encodeURIComponent(token)}` } }));
  });
  app.post('/join/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const s = await sessionOf(req);
    const given = (req.body as { csrf?: string } | undefined)?.csrf ?? (req.headers['x-tandem-token'] as string | undefined);
    if (!s || !Directory.csrfMatches(s.session, given)) return reply.code(403).type('text/html').send(signInPage({ error: 'That did not come from your Tandem page. Open the invitation link again.', ...(s ? { signedIn: true } : {}) }));
    const w = await joinInvite(token, s.session.userId);
    if (w === 'full') return reply.code(409).type('text/html').send(signInPage({ error: 'This workspace is full. Ask an owner to make room.', signedIn: true }));
    if (!w) return reply.code(410).type('text/html').send(signInPage({ error: 'This invitation has expired. Ask for a new link.', signedIn: true }));
    await directory.useWorkspace(s.id, w.id);
    logger.info('joined a workspace', { workspace: w.id });
    return reply.code(303).redirect('/');
  });

  /* ---------------------------------------------------------------- GitHub webhooks */

  /**
   * GitHub tells the app when a pull request changes (merged, closed, reviewed, commented, checks).
   * The signature proves it is GitHub; every workspace then checks whether the pull request is one
   * of its tasks', and if so, that task looks at it now. Polling stays as the fallback.
   */
  const secret = cfg.github.webhookSecret;
  const prUrlOf = (event: string, body: Record<string, unknown>): string | undefined => {
    const get = (obj: unknown, ...path: string[]) => path.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), obj);
    const url =
      event === 'pull_request' || event === 'pull_request_review' || event === 'pull_request_review_comment' || event === 'pull_request_review_thread'
        ? get(body, 'pull_request', 'html_url')
        : event === 'issue_comment'
          ? get(body, 'issue', 'pull_request', 'html_url')
          : event === 'check_suite' || event === 'check_run'
            ? (() => {
                const prs = get(body, event, 'pull_requests') as Array<{ number?: number }> | undefined;
                const repo = get(body, 'repository', 'html_url');
                return prs?.[0]?.number && typeof repo === 'string' ? `${repo}/pull/${prs[0].number}` : undefined;
              })()
            : undefined;
    return typeof url === 'string' ? url : undefined;
  };
  /** The workspaces this replica runs (and the runners connected to it) look at the pull request. */
  const notifyLocal = async (url: string) => {
    let woken = 0;
    const payload = JSON.stringify({ url });
    for (const c of cells.values()) {
      const cell = await c.catch(() => undefined);
      if (!cell) continue;
      const r = await cell.app.inject({ method: 'POST', url: '/api/hooks/pull-request', headers: { host: CELL_HOST, 'content-type': 'application/json', 'x-tandem-token': cell.token }, payload });
      woken += (r.json() as { woken?: number }).woken ?? 0;
    }
    for (const w of await directory.allWorkspaces()) {
      if (!hub.status(w.id)) continue;
      hub.request(w.id, { method: 'POST', url: '/api/hooks/pull-request', headers: { 'content-type': 'application/json' }, body: payload }, { onHead: () => undefined, onData: () => undefined, onEnd: () => undefined, onError: () => undefined });
    }
    return woken;
  };
  await app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post('/hooks/github', async (req, reply) => {
      if (!secret) return reply.code(404).send({ error: 'Webhooks are not set up.' });
      const raw = req.body as Buffer;
      const sig = String(req.headers['x-hub-signature-256'] ?? '');
      const want = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return reply.code(401).send({ error: 'Bad signature.' });
      const event = String(req.headers['x-github-event'] ?? '');
      metrics.count('tandem_webhooks_total', 'Signed GitHub webhooks received.', { event: event.slice(0, 40) });
      if (event === 'ping') return { ok: true };
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return reply.code(400).send({ error: 'Not JSON.' });
      }
      const url = prUrlOf(event, body);
      if (!url) return reply.code(202).send({ ignored: event });
      // Answer GitHub at once (it waits 10 seconds at most); every replica's workspaces look in the background.
      void (async () => {
        let woken = await notifyLocal(url);
        for (const r of await directory.liveReplicas()) {
          if (r.id === me) continue;
          const answer = await callReplica(r.url, '/internal/hooks/pull-request', { url }).catch(() => undefined);
          woken += Number((answer?.json as { woken?: number } | undefined)?.woken ?? 0);
        }
        logger.info('webhook', { event, woken });
      })().catch((err: unknown) => logger.warn('webhook could not be delivered', { event, error: String(err) }));
      return reply.code(202).send({ accepted: true });
    });
  });

  /* ---------------------------------------------------------------- Jira: Atlassian's sign-in */

  /** The front asks a workspace itself, wherever it runs (here, another replica, its company runner): JSON in and out. */
  const callWorkspace = async (id: string, path: string, body: unknown, actor?: string): Promise<{ status: number; json: unknown }> => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(actor ? { 'x-tandem-actor': encodeURIComponent(actor) } : {}) };
    const elsewhere = async (replica: string | undefined, offline: string) => {
      const url = replica ? await replicaUrl(replica) : undefined;
      return url ? callReplica(url, `/internal/ws/${id}${path}`, body, actor ? { 'x-tandem-actor': headers['x-tandem-actor']! } : {}) : { status: 503, json: { error: offline } };
    };
    if ((await directory.runnerMode(id)) === 'company') {
      if (!hub.status(id)) {
        const there = (await directory.runnerOf(id))?.connectedReplica;
        return there && there !== me ? elsewhere(there, RUNNER_OFFLINE) : { status: 503, json: { error: RUNNER_OFFLINE } };
      }
      return new Promise((done) => {
        let status = 502;
        const chunks: Buffer[] = [];
        const json = () => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            return {};
          }
        };
        const cancel = hub.request(id, { method: 'POST', url: path, headers, body: payload }, {
          onHead: (st) => void (status = st),
          onData: (c) => void chunks.push(c),
          onEnd: () => done({ status, json: json() }),
          onError: (message) => done({ status: 502, json: { error: message } }),
        });
        if (!cancel) done({ status: 503, json: { error: RUNNER_OFFLINE } });
      });
    }
    const there = (await directory.workspaceReplica(id)) ?? me;
    if (there !== me) return elsewhere(there, OWNER_MOVED);
    const cell = await cellFor(id);
    const r = await cell.app.inject({ method: 'POST', url: path, headers: { ...headers, host: CELL_HOST, 'x-tandem-token': cell.token }, payload });
    let json: unknown = {};
    try {
      json = r.json();
    } catch {
      // not JSON
    }
    return { status: r.statusCode, json };
  };

  /** A sign-in's state: which workspace and person it is for, until when; signed, so any replica can check it. */
  const signJira = (body: string) => createHmac('sha256', internalKey).update(`jira|${body}`).digest('base64url');

  /** An owner chooses "Connect Jira": the Atlassian page to open. */
  app.post('/api/jira/oauth/start', async (req, reply) => {
    const c = await inWorkspace(req, reply);
    if (!ownerOnly(c, reply) || !c) return reply;
    if (!jiraApp) return reply.code(409).send({ error: "Atlassian's sign-in isn't set up for this Tandem. Connect with a token instead." });
    const { from } = JiraFrom.parse(req.body ?? {});
    const nonce = randomBytes(18).toString('base64url');
    const body = Buffer.from(JSON.stringify({ n: nonce, w: c.w.id, u: c.s.session.userId, e: Date.now() + 10 * 60_000, r: from })).toString('base64url');
    return reply.header('Set-Cookie', cookie(JIRA, nonce, 600)).send({ url: jiraApp.authorizeUrl(`${body}.${signJira(body)}`) });
  });

  /** Atlassian sends the owner back, signed in: the workspace gets the sign-in. */
  app.get('/auth/jira/callback', async (req, reply) => {
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(1000).optional(), error: z.string().max(200).optional() }).parse(req.query);
    const nonce = cookies(req)[JIRA];
    reply.header('Set-Cookie', cookie(JIRA, '', 0));
    const from = { at: 'settings' };
    const fail = (message: string) => reply.redirect(jiraBack(from.at, 'failed', message));
    if (!jiraApp) return fail("Atlassian's sign-in isn't set up for this Tandem.");
    if (q.error || !q.code || !q.state) return fail(q.error === 'access_denied' ? 'You cancelled the sign-in at Atlassian.' : 'The sign-in at Atlassian was not completed.');
    const [body = '', sig = ''] = q.state.split('.');
    const want = signJira(body);
    let st: { n?: string; w?: string; u?: string; e?: number; r?: string } = {};
    try {
      if (sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))) st = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof st;
    } catch {
      st = {};
    }
    if (st.r === 'setup') from.at = 'setup';
    if (!st.n || !st.w || !st.u || !nonce || st.n !== nonce || (st.e ?? 0) < Date.now()) return fail('That sign-in is no longer valid. Choose Connect Jira again.');
    const s = await sessionOf(req);
    if (!s || s.session.userId !== st.u) return fail('Sign in to Tandem, then choose Connect Jira again.');
    if ((await directory.roleIn(st.w, st.u)) !== 'owner') return fail('Only an owner of the workspace can connect Jira.');
    let grant;
    try {
      grant = await jiraApp.exchange(q.code);
    } catch (err) {
      return fail(err instanceof JiraError ? err.message : 'Atlassian did not complete the sign-in. Please try again.');
    }
    const person = await directory.user(st.u);
    const r = await callWorkspace(st.w, '/api/jira/oauth', grant, person?.name || person?.login);
    const answer = r.json as { connected?: boolean; error?: string };
    if (r.status !== 200) return fail(answer.error ?? 'Jira could not be connected. Please try again.');
    logger.info('jira connected', { workspace: st.w, sites: grant.sites.length });
    return reply.redirect(jiraBack(from.at, answer.connected ? 'connected' : 'choose'));
  });

  /** A company runner renews its workspace's Jira sign-in through Tandem's Atlassian app. */
  app.post('/runner/jira/refresh', async (req, reply) => {
    const key = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const runner = key ? await directory.runnerByToken(key) : undefined;
    if (!runner) return reply.code(401).send({ error: 'Not a runner of this Tandem.' });
    if (!jiraApp) return reply.code(404).send({ error: "Atlassian's sign-in isn't set up for this Tandem." });
    const { refresh } = z.object({ refresh: z.string().min(1).max(8000) }).parse(req.body);
    try {
      return await jiraApp.refresh(refresh);
    } catch (err) {
      return reply.code(err instanceof JiraError && err.status === 401 ? 401 : 502).send({ error: err instanceof JiraError ? err.message : "Jira's sign-in could not be renewed." });
    }
  });

  /* ---------------------------------------------------------------- between replicas */

  app.post('/internal/hooks/pull-request', async (req) => {
    const { url } = z.object({ url: z.string().url().max(500) }).parse(req.body);
    return { woken: await notifyLocal(url) };
  });
  app.post('/internal/workspaces/:id/:action', async (req) => {
    const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['open', 'close', 'purge', 'disconnect']) }).parse(req.params);
    const { reason } = z.object({ reason: z.string().max(200).default('') }).parse(req.body ?? {});
    await actLocally(id, action, reason);
    return { ok: true };
  });
  /** Another replica passes on a member's request (already checked there) to a workspace that runs here. */
  app.all('/internal/ws/:id/*', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inner = req.url.slice(`/internal/ws/${id}`.length);
    if (!inner.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !DROP.has(k)) headers[k] = v;
    const actor = req.headers['x-tandem-actor'];
    if (typeof actor === 'string') headers['x-tandem-actor'] = actor;
    return serveHere(req, reply, id, inner, headers);
  });

  /* ---------------------------------------------------------------- into the workspace */

  /** The git helper of a workspace's runner asks its own cell (from this machine only). */
  app.post('/cells/:id/git/credential', async (req, reply) => {
    if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '')) return reply.code(403).send({ error: 'Not allowed.' });
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const cell = await cells.get(id);
    if (!cell) return reply.code(404).send({});
    const r = await cell.app.inject({ method: 'POST', url: '/git/credential', headers: { host: CELL_HOST, 'content-type': 'application/json', 'x-tandem-git-key': String(req.headers['x-tandem-git-key'] ?? '') }, payload: JSON.stringify(req.body ?? {}) });
    return reply.code(r.statusCode).type('application/json').send(r.body);
  });

  const bodyOf = (req: FastifyRequest) => (writes(req) && req.body !== undefined ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined);

  /** A member's request, checked: to the workspace where it runs (this replica, another one, or a company runner). */
  const toWorkspace = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await signedIn(req, reply);
    if (!s) return reply;
    const w = await currentWorkspace(s);
    const role = w ? await directory.roleIn(w.id, s.session.userId) : undefined;
    if (!w || !role) return reply.code(403).send({ error: 'You are not a member of a workspace yet.' });
    if (writes(req) && OWNER_ONLY.test(req.url) && role !== 'owner') return reply.code(403).send({ error: 'Only an owner of the workspace can change its settings and connections.' });
    // A finished Atlassian sign-in comes only from this server's own callback, never from a page.
    if (req.url.split('?')[0] === '/api/jira/oauth') return reply.code(404).send({ error: 'Not found.' });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !DROP.has(k)) headers[k] = v;
    const person = await directory.user(s.session.userId);
    if (person) headers['x-tandem-actor'] = encodeURIComponent(person.name || person.login);
    // Where it runs: a company workspace where its runner is connected; a cloud one on its replica.
    const company = (await directory.runnerMode(w.id)) === 'company';
    const there = company ? (hub.status(w.id) ? me : (await directory.runnerOf(w.id))?.connectedReplica) : ((await directory.workspaceReplica(w.id)) ?? me);
    if (!there || there === me) return serveHere(req, reply, w.id, req.url, headers);
    const url = await replicaUrl(there);
    if (!url) return reply.code(503).send(company ? { error: RUNNER_OFFLINE, runnerOffline: true } : { error: OWNER_MOVED });
    return forward(req, reply, url, `/internal/ws/${w.id}${req.url}`, headers);
  };

  /** Serves a workspace request on this replica: its cell, or its runner connected here. */
  const serveHere = async (req: FastifyRequest, reply: FastifyReply, id: string, url: string, headers: Record<string, string>) => {
    if ((await directory.runnerMode(id)) === 'company') return toRunner(req, reply, id, url, headers);
    if (((await directory.workspaceReplica(id)) ?? me) !== me) return reply.code(503).send({ error: OWNER_MOVED });
    const cell = await cellFor(id);
    const h = { ...headers, host: CELL_HOST, 'x-tandem-token': cell.token };
    if (!writes(req)) {
      // Reads stream straight through (server-sent events, files).
      req.raw.headers = { ...h };
      req.raw.url = url;
      reply.hijack();
      cell.app.routing(req.raw, reply.raw);
      return reply;
    }
    const body = bodyOf(req);
    const r = await cell.app.inject({ method: req.method as 'POST', url, headers: h, ...(body !== undefined ? { payload: body } : {}) });
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) reply.header(k, v as string);
    return reply.code(r.statusCode).send(r.rawPayload);
  };

  /** Passes a request to another replica and streams its answer back (live updates included). */
  const forward = (req: FastifyRequest, reply: FastifyReply, base: string, path: string, headers: Record<string, string>) => {
    const target = new URL(path, base);
    const body = bodyOf(req);
    reply.hijack();
    const res = reply.raw;
    const out = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      { method: req.method, headers: { ...headers, 'x-tandem-internal': internalKey, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}) }, timeout: 15 * 60_000 },
      (answer) => {
        const h: IncomingHttpHeaders = {};
        for (const [k, v] of Object.entries(answer.headers)) if (v !== undefined && !HOP.has(k)) h[k] = v;
        res.writeHead(answer.statusCode ?? 502, h);
        answer.pipe(res);
      },
    );
    out.on('timeout', () => out.destroy(new Error('timed out')));
    out.on('error', () => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: OWNER_MOVED }));
      }
    });
    res.on('close', () => {
      if (!res.writableEnded) out.destroy();
    });
    out.end(body);
    return reply;
  };

  /** A company workspace: the request goes to its runner, and the answer streams back. */
  const toRunner = (req: FastifyRequest, reply: FastifyReply, workspaceId: string, url: string, headers: Record<string, string>) => {
    const body = bodyOf(req);
    const res = reply.raw;
    let started = false;
    const wait: { timer?: NodeJS.Timeout } = {};
    const fail = (status: number, error: string) => {
      if (started) return void res.destroy();
      started = true;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error, runnerOffline: true }));
    };
    const cancel = hub.request(workspaceId, { method: req.method, url, headers, ...(body !== undefined ? { body } : {}) }, {
      onHead: (status, h) => {
        if (started) return;
        started = true;
        clearTimeout(wait.timer);
        res.writeHead(status, safeRunnerHeaders(h));
      },
      onData: (chunk) => {
        if (started) res.write(chunk);
      },
      onEnd: () => {
        clearTimeout(wait.timer);
        if (!started) fail(502, 'The company runner sent no answer.');
        else res.end();
      },
      onError: (message) => {
        clearTimeout(wait.timer);
        fail(502, message);
      },
    });
    if (!cancel) return reply.code(503).send({ error: RUNNER_OFFLINE, runnerOffline: true });
    reply.hijack();
    // Copilot can take a while to answer a chat message; a runner silent for 15 minutes has gone.
    wait.timer = setTimeout(() => {
      cancel();
      fail(504, 'The company runner did not answer in time.');
    }, 15 * 60_000);
    res.on('close', () => {
      clearTimeout(wait.timer);
      if (!res.writableEnded) cancel();
    });
    return reply;
  };
  app.all('/api/*', toWorkspace);

  /* ---------------------------------------------------------------- the page */

  const webDir = o.webDir;
  const indexHtml = webDir && existsSync(join(webDir, 'index.html')) ? readFileSync(join(webDir, 'index.html'), 'utf8') : undefined;
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  if (webDir && indexHtml) await app.register(fastifyStatic, { root: webDir, index: false, wildcard: false, serve: true });
  const page = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await sessionOf(req);
    reply.header('Content-Security-Policy', csp).header('Cache-Control', 'no-store').type('text/html');
    if (!s || !indexHtml) return reply.send(signInPage({}));
    const w = await currentWorkspace(s);
    const runner = w && (await directory.runnerMode(w.id)) === 'company' ? '<meta name="tandem-runner" content="company">' : '';
    return reply.send(indexHtml.replace('<meta name="tandem-token" content="">', `<meta name="tandem-token" content="${s.session.csrf}"><meta name="tandem-mode" content="hosted">${runner}`));
  };
  app.get('/', page);
  // The privacy policy, terms and DPA: public, linked from the sign-in page.
  app.get('/legal/:doc', async (req, reply) => {
    const { doc } = z.object({ doc: z.string().max(40) }).parse(req.params);
    const html = legalPage(o.legalDir, doc);
    if (!html) return reply.code(404).type('text/html').send(signInPage({ error: 'There is no such page.' }));
    return reply.header('Content-Security-Policy', csp).header('Cache-Control', 'public, max-age=300').type('text/html').send(html);
  });
  // The `tandem` command for company runners: public, since the computer has no session yet.
  app.get('/download/tandem.tgz', async (_req, reply) => {
    if (!cliPackage) return reply.code(404).send({ error: 'Not found.' });
    const { size, mtime } = statSync(cliPackage);
    return reply
      .type('application/gzip')
      .header('Content-Length', String(size))
      .header('Content-Disposition', 'attachment; filename="tandem.tgz"')
      .header('Last-Modified', mtime.toUTCString())
      .header('Cache-Control', 'public, max-age=300')
      .send(createReadStream(cliPackage));
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return page(req, reply);
    return reply.code(404).send({ error: 'Not found.' });
  });

  await app.listen({ host: cfg.listenHost, port: cfg.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  listenPort = port;
  // This replica is alive; it takes the workspaces nobody runs yet, and opens its own: their
  // runners keep working while nobody is signed in.
  await heartbeat();
  const beat = setInterval(() => void heartbeat(), 10_000);
  beat.unref();
  // Sessions and invitations are kept no longer than they work.
  const purge = async () => {
    const gone = await directory.purgeExpired().catch(() => undefined);
    if (gone && (gone.sessions || gone.invites)) logger.info('expired sessions and invitations deleted', gone);
  };
  void purge();
  const tidy = setInterval(() => void purge(), 60 * 60_000);
  tidy.unref();
  const claimed = await directory.claimUnassigned(me);
  for (const id of await directory.workspacesOn(me)) await actLocally(id, 'open');
  logger.info('tandem hosted started', { port, publicUrl: cfg.publicUrl, replica: me, claimed, database: cfg.databaseUrl ? 'postgres' : 'sqlite' });
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    directory,
    cells,
    hub,
    replicaId: me,
    stop: async () => {
      clearInterval(beat);
      clearInterval(tidy);
      limiter.close();
      hub.close();
      await app.close();
      for (const c of cells.values()) await (await c.catch(() => undefined))?.stop();
      await directory.close();
    },
  };
}
