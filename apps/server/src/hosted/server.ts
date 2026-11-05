import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { loadConfig, type Logger } from '@tandem/core';
import type { RuntimeConfig } from '@tandem/shared';
import { NamespaceSandbox, guardWorktrees, serverRoleSource, type RoleSource } from '@tandem/adapters';
import { createLogger } from '../logger.js';
import { openCell, type Cell } from '../start.js';
import { Directory, type Session } from './directory.js';
import { legalPage } from './legal-pages.js';
import { signInPage } from './sign-in-page.js';
import { RunnerHub, safeRunnerHeaders } from './runner-hub.js';
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
const JOIN = 'tandem_join';
const CELL_HOST = 'cell.tandem.internal';
/** Changes only an owner makes: settings, and the workspace's connections and secrets. */
const OWNER_ONLY = /^\/api\/(settings|secrets|aws|copilot)(\/|\?|$)/;

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
  mkdirSync(join(probe, 'mirrors'), { recursive: true });
  writeFileSync(join(probe, 'tandem.db'), 'probe');
  try {
    const sbx = new NamespaceSandbox(cellSandbox(hostedHome, probe));
    const r = await sbx.selfTest({ hidden: join(hostedHome, 'directory.db'), kept: probe, readOnly: join(probe, 'mirrors'), masked: join(probe, 'tandem.db') });
    if (!r.ok) throw new Error(r.message);
  } catch (err) {
    throw new Error(
      `Tandem can't isolate builds on this server (${(err as Error).message}). It needs Linux user namespaces: in Docker, run the container with --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined (see docs/DEPLOYMENT.md). Only to try Tandem out, without real users, set TANDEM_SANDBOX=off.`,
      { cause: err },
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
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
  stop(): Promise<void>;
}

export async function startHosted(input: z.input<typeof HostedConfig>, o: { webDir?: string; legalDir?: string; fetch?: typeof fetch; awsRoleSource?: RoleSource } = {}): Promise<Hosted> {
  const cfg = HostedConfig.parse(input);
  const http = o.fetch ?? fetch;
  mkdirSync(join(cfg.home, 'workspaces'), { recursive: true, mode: 0o700 });
  const logger: Logger = createLogger(join(cfg.home, 'logs'), cfg.logLevel === 'silent' ? 'silent' : cfg.logLevel);
  const directory = await Directory.open(join(cfg.home, 'directory.db'), cfg.secretKey);
  const workspacesRoot = resolve(cfg.home, 'workspaces');
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

  /* ---------------------------------------------------------------- cells */

  const cells = new Map<string, Promise<Cell>>();
  // Known once the server listens (the git helper of each cell calls back on it).
  let listenPort = cfg.port;
  const cellHome = (id: string) => {
    const root = resolve(cfg.home, 'workspaces');
    const dir = resolve(root, id);
    if (!dir.startsWith(root + sep)) throw new Error('Bad workspace id.');
    return dir;
  };
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
      c = openCell({ home, config, logger, webDir: undefined, port: listenPort, allowedHost: CELL_HOST, hosted, ...(sandbox ? { sandbox } : {}) }).then(async (cell) => {
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

  /** A workspace on a company computer has no cell here: its runner holds its data. */
  const openIfCloud = (id: string) => {
    if (directory.runnerMode(id) === 'cloud') void cellFor(id);
  };
  const closeCell = async (id: string) => {
    const cell = cells.get(id);
    cells.delete(id);
    if (cell) await (await cell.catch(() => undefined))?.stop();
  };

  /* ---------------------------------------------------------------- app */

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: true, forceCloseConnections: true });
  const publicHost = new URL(cfg.publicUrl).host;
  const knownHost = (host: string | undefined) => host === publicHost || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? '');
  const hub = new RunnerHub({
    authenticate: (token, req) => (knownHost(req.headers.host) ? directory.runnerByToken(token)?.workspaceId : undefined),
    welcome: (id) => ({ workspace: directory.allWorkspaces().find((w) => w.id === id)?.name ?? '' }),
    seen: (id, machine) => directory.runnerSeen(id, machine),
    logger,
  });
  hub.attach(app.server);
  app.addHook('onRequest', async (req, reply) => {
    // Only the public address (and loopback, for health checks and the git helper).
    const host = req.headers.host ?? '';
    if (!knownHost(host)) return reply.code(421).send({ error: 'Unknown host.' });
    const origin = req.headers.origin;
    if (origin && origin !== cfg.publicUrl) return reply.code(403).send({ error: 'Requests from other sites are not allowed.' });
    return undefined;
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    return payload;
  });

  const sessionOf = (req: FastifyRequest): { id: string; session: Session } | undefined => {
    const id = cookies(req)[SESSION];
    const session = directory.session(id);
    return id && session ? { id, session } : undefined;
  };
  const writes = (req: FastifyRequest) => req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  /** Signed in, and for a change, carrying the session's CSRF token. */
  const signedIn = (req: FastifyRequest, reply: FastifyReply) => {
    const s = sessionOf(req);
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
  const currentWorkspace = (s: { id: string; session: Session }) => {
    const mine = directory.workspacesOf(s.session.userId);
    const w = mine.find((x) => x.id === s.session.workspaceId) ?? mine[0];
    if (w) return w;
    const user = directory.user(s.session.userId);
    if (!user) return undefined;
    const fresh = directory.createWorkspace(`${user.name}'s workspace`, user.id);
    directory.useWorkspace(s.id, fresh.id);
    openIfCloud(fresh.id);
    return directory.workspacesOf(user.id).find((x) => x.id === fresh.id);
  };

  app.get('/healthz', async () => ({ ok: true }));

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
    const user = directory.upsertGitHubUser({ id: gh.id, login: gh.login, name: gh.name ?? null, email: gh.email ?? null, avatarUrl: gh.avatar_url ?? null });
    const now = Date.now();
    directory.saveGitHubTokens(user.id, { access: tok.access_token, ...(tok.expires_in ? { accessExpiresAt: now + tok.expires_in * 1000 } : {}), ...(tok.refresh_token ? { refresh: tok.refresh_token } : {}), ...(tok.refresh_token_expires_in ? { refreshExpiresAt: now + tok.refresh_token_expires_in * 1000 } : {}) });
    // Came from an invitation link: join that workspace first.
    const join = cookies(req)[JOIN];
    const joined = join ? directory.acceptInvite(join, user.id) : undefined;
    const workspaces = directory.workspacesOf(user.id);
    const workspace = joined ?? workspaces[0] ?? directory.createWorkspace(`${user.name}'s workspace`, user.id);
    openIfCloud(workspace.id);
    const { id } = directory.createSession(user.id, workspace.id);
    logger.info('signed in', { user: user.id, joined: Boolean(joined) });
    return reply.header('Set-Cookie', [cookie(SESSION, id, 14 * 86_400), cookie(OAUTH, '', 0), ...(join ? [cookie(JOIN, '', 0)] : [])]).redirect('/');
  });

  app.post('/auth/sign-out', async (req, reply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    directory.endSession(s.id);
    return reply.header('Set-Cookie', cookie(SESSION, '', 0)).send({ ok: true });
  });

  /* ---------------------------------------------------------------- account and workspaces */

  app.get('/api/me', async (req, reply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    const user = directory.user(s.session.userId)!;
    const current = currentWorkspace(s);
    return { user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl }, workspaces: directory.workspacesOf(user.id), current: current?.id ?? null };
  });

  app.post('/api/workspaces', async (req, reply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    const { name } = z.object({ name: z.string().trim().min(1, 'Give the workspace a name.').max(80) }).parse(req.body);
    const w = directory.createWorkspace(name, s.session.userId);
    directory.useWorkspace(s.id, w.id);
    openIfCloud(w.id);
    return w;
  });

  app.post('/api/workspaces/:id/use', async (req, reply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!directory.roleIn(id, s.session.userId)) return reply.code(404).send({ error: 'No such workspace.' });
    directory.useWorkspace(s.id, id);
    return { ok: true };
  });

  /** GDPR: what Tandem keeps about the person in the directory (workspace data has its own export). */
  app.get('/api/me/export', async (req, reply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    const user = directory.user(s.session.userId)!;
    return reply.header('Content-Disposition', 'attachment; filename="tandem-account.json"').send({ exportedAt: new Date().toISOString(), user, workspaces: directory.workspacesOf(user.id) });
  });

  /** GDPR: delete the account; workspaces the person alone owned are deleted with all their data. */
  app.delete('/api/me', async (req, reply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    const orphans = directory.deleteUser(s.session.userId);
    for (const w of orphans) {
      hub.disconnect(w, 'This workspace was deleted.');
      await closeCell(w);
      directory.deleteWorkspace(w);
      rmSync(cellHome(w), { recursive: true, force: true });
    }
    logger.info('account deleted', { workspacesDeleted: orphans.length });
    return reply.header('Set-Cookie', cookie(SESSION, '', 0)).send({ ok: true, workspacesDeleted: orphans.length });
  });

  /* ---------------------------------------------------------------- the workspace: Copilot plan, members, invitations */

  /** The signed-in person and their role in the workspace they are in. */
  const inWorkspace = (req: FastifyRequest, reply: FastifyReply) => {
    const s = signedIn(req, reply);
    if (!s) return undefined;
    const w = currentWorkspace(s);
    const role = w ? directory.roleIn(w.id, s.session.userId) : undefined;
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
    const c = inWorkspace(req, reply);
    if (!c) return reply;
    if (!(await tokens.identity(c.s.session.userId))) return reply.code(409).send({ error: 'Your GitHub sign-in has expired. Sign out and in again first.' });
    directory.setCopilotUser(c.w.id, c.s.session.userId);
    return { ok: true };
  });

  app.get('/api/workspace', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!c) return reply;
    const copilot = directory.copilotUser(c.w.id);
    return { id: c.w.id, name: c.w.name, role: c.role, me: c.s.session.userId, copilotUserId: copilot ?? null, runner: runnerInfo(c.w.id), members: directory.members(c.w.id).map((m) => ({ id: m.id, login: m.login, name: m.name, avatarUrl: m.avatarUrl, role: m.role })) };
  });

  app.patch('/api/workspace', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const { name } = z.object({ name: z.string().trim().min(1, 'Give the workspace a name.').max(80) }).parse(req.body);
    directory.renameWorkspace(c!.w.id, name);
    return { ok: true };
  });

  app.post('/api/workspace/invites', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const { role } = z.object({ role: z.enum(['owner', 'member']).default('member') }).parse(req.body ?? {});
    const token = directory.createInvite(c!.w.id, c!.s.session.userId, role);
    return { url: `${cfg.publicUrl}/join/${token}`, expiresInDays: 7 };
  });

  app.post('/api/workspace/members/:userId/role', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const { role } = z.object({ role: z.enum(['owner', 'member']) }).parse(req.body);
    if (!directory.roleIn(c!.w.id, userId)) return reply.code(404).send({ error: 'Not a member.' });
    if (role === 'member' && directory.roleIn(c!.w.id, userId) === 'owner' && directory.owners(c!.w.id) <= 1) return reply.code(409).send({ error: 'A workspace needs at least one owner.' });
    directory.setRole(c!.w.id, userId, role);
    return { ok: true };
  });

  /** An owner removes a member, or a member leaves. */
  app.delete('/api/workspace/members/:userId', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!c) return reply;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (userId !== c.s.session.userId && c.role !== 'owner') return reply.code(403).send({ error: 'Only an owner can remove others.' });
    if (directory.roleIn(c.w.id, userId) === 'owner' && directory.owners(c.w.id) <= 1) return reply.code(409).send({ error: 'A workspace needs at least one owner. Make someone else an owner first, or delete the workspace.' });
    directory.removeMember(c.w.id, userId);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- where the workspace works */

  const runnerInfo = (id: string) => {
    const mode = directory.runnerMode(id);
    const key = directory.runnerOf(id);
    const live = hub.status(id);
    return { mode, connected: Boolean(live), ...(live ? { machine: live.machine, version: live.version, connectedAt: new Date(live.connectedAt).toISOString() } : key?.machine ? { machine: key.machine } : {}), ...(key?.lastSeenAt ? { lastSeenAt: new Date(key.lastSeenAt).toISOString() } : {}) };
  };
  const runnerCommand = (token: string) => `tandem runner --url ${cfg.publicUrl} --key ${token}`;

  /**
   * An owner moves the workspace to a company computer (or gives its runner a new key): from now on
   * its data, repositories and sign-ins live there. What the workspace had in the cloud is kept,
   * untouched, for when it moves back.
   */
  app.post('/api/workspace/runner', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const id = c!.w.id;
    hub.disconnect(id, 'This runner key was replaced.');
    const token = directory.useCompanyRunner(id, c!.s.session.userId);
    await closeCell(id);
    logger.info('workspace uses a company runner', { workspace: id });
    return { key: token, command: runnerCommand(token), runner: runnerInfo(id) };
  });

  /** An owner moves the workspace back to Tandem's cloud; the runner's key stops working. */
  app.delete('/api/workspace/runner', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const id = c!.w.id;
    directory.useCloudRunner(id);
    hub.disconnect(id, 'This workspace works in the cloud again.');
    openIfCloud(id);
    logger.info('workspace back in the cloud', { workspace: id });
    return { runner: runnerInfo(id) };
  });

  /** An owner deletes the workspace with everything in it. */
  app.delete('/api/workspace', async (req, reply) => {
    const c = inWorkspace(req, reply);
    if (!ownerOnly(c, reply)) return reply;
    const id = c!.w.id;
    hub.disconnect(id, 'This workspace was deleted.');
    await closeCell(id);
    directory.deleteWorkspace(id);
    rmSync(cellHome(id), { recursive: true, force: true });
    logger.info('workspace deleted', { workspace: id });
    return { ok: true };
  });

  /** An invitation link: join (signing in first if needed). */
  app.get('/join/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.params);
    const s = sessionOf(req);
    if (!s) return reply.header('Set-Cookie', cookie(JOIN, token, 1800)).type('text/html').header('Cache-Control', 'no-store').send(signInPage({ note: "You've been invited to a workspace. Sign in with GitHub to join it." }));
    const w = directory.acceptInvite(token, s.session.userId);
    if (!w) return reply.code(410).type('text/html').send(signInPage({ error: 'This invitation has expired. Ask for a new link.', signedIn: true }));
    directory.useWorkspace(s.id, w.id);
    openIfCloud(w.id);
    return reply.redirect('/');
  });

  /* ---------------------------------------------------------------- GitHub webhooks */

  /**
   * GitHub tells the app when a pull request changes (merged, closed, reviewed, commented, checks).
   * The signature proves it is GitHub; every workspace then checks whether the pull request is one
   * of its tasks', and if so, that task looks at it now. Polling stays as the fallback.
   */
  const secret = cfg.github.webhookSecret;
  const prUrlOf = (event: string, body: Record<string, unknown>): string | undefined => {
    const get = (o: unknown, ...path: string[]) => path.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
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
  const notifyWorkspaces = async (url: string) => {
    let woken = 0;
    const payload = JSON.stringify({ url });
    for (const w of directory.allWorkspaces()) {
      if (directory.runnerMode(w.id) === 'company') {
        hub.request(w.id, { method: 'POST', url: '/api/hooks/pull-request', headers: { 'content-type': 'application/json' }, body: payload }, { onHead: () => undefined, onData: () => undefined, onEnd: () => undefined, onError: () => undefined });
        continue;
      }
      const cell = await cells.get(w.id)?.catch(() => undefined);
      if (!cell) continue;
      const r = await cell.app.inject({ method: 'POST', url: '/api/hooks/pull-request', headers: { host: CELL_HOST, 'content-type': 'application/json', 'x-tandem-token': cell.token }, payload });
      woken += (r.json() as { woken?: number }).woken ?? 0;
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
      if (event === 'ping') return { ok: true };
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return reply.code(400).send({ error: 'Not JSON.' });
      }
      const url = prUrlOf(event, body);
      if (!url) return reply.code(202).send({ ignored: event });
      // Answer GitHub at once (it waits 10 seconds at most); the workspaces look in the background.
      void notifyWorkspaces(url)
        .then((woken) => logger.info('webhook', { event, woken }))
        .catch((err: unknown) => logger.warn('webhook could not be delivered', { event, error: String(err) }));
      return reply.code(202).send({ accepted: true });
    });
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

  const toCell = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = signedIn(req, reply);
    if (!s) return reply;
    const w = currentWorkspace(s);
    if (!w || !directory.roleIn(w.id, s.session.userId)) return reply.code(403).send({ error: 'You are not a member of a workspace yet.' });
    if (writes(req) && OWNER_ONLY.test(req.url) && directory.roleIn(w.id, s.session.userId) !== 'owner') return reply.code(403).send({ error: "Only an owner of the workspace can change its settings and connections." });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['cookie', 'origin', 'host', 'x-tandem-token', 'x-tandem-actor', 'x-tandem-git-key', 'content-length', 'authorization', 'connection', 'upgrade'].includes(k)) headers[k] = v;
    const person = directory.user(s.session.userId);
    if (person) headers['x-tandem-actor'] = encodeURIComponent(person.name || person.login);
    if (directory.runnerMode(w.id) === 'company') return toRunner(req, reply, w.id, headers);
    const cell = await cellFor(w.id);
    headers.host = CELL_HOST;
    headers['x-tandem-token'] = cell.token;
    if (!writes(req)) {
      // Reads stream straight through (server-sent events, files).
      req.raw.headers = { ...headers };
      reply.hijack();
      cell.app.routing(req.raw, reply.raw);
      return reply;
    }
    const r = await cell.app.inject({ method: req.method as 'POST', url: req.url, headers, ...(req.body !== undefined ? { payload: typeof req.body === 'string' ? req.body : JSON.stringify(req.body) } : {}) });
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !['content-length', 'connection', 'transfer-encoding'].includes(k.toLowerCase())) reply.header(k, v as string);
    return reply.code(r.statusCode).send(r.rawPayload);
  };
  /** A company workspace: the request goes to its runner, and the answer streams back. */
  const toRunner = (req: FastifyRequest, reply: FastifyReply, workspaceId: string, headers: Record<string, string>) => {
    const body = writes(req) && req.body !== undefined ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined;
    const res = reply.raw;
    let started = false;
    const wait: { timer?: NodeJS.Timeout } = {};
    const fail = (status: number, error: string) => {
      if (started) return void res.destroy();
      started = true;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error, runnerOffline: true }));
    };
    const cancel = hub.request(workspaceId, { method: req.method, url: req.url, headers, ...(body !== undefined ? { body } : {}) }, {
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
  app.all('/api/*', toCell);

  /* ---------------------------------------------------------------- the page */

  const webDir = o.webDir;
  const indexHtml = webDir && existsSync(join(webDir, 'index.html')) ? readFileSync(join(webDir, 'index.html'), 'utf8') : undefined;
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  if (webDir && indexHtml) await app.register(fastifyStatic, { root: webDir, index: false, wildcard: false, serve: true });
  const page = (req: FastifyRequest, reply: FastifyReply) => {
    const s = sessionOf(req);
    reply.header('Content-Security-Policy', csp).header('Cache-Control', 'no-store').type('text/html');
    if (!s || !indexHtml) return reply.send(signInPage({}));
    const w = currentWorkspace(s);
    const runner = w && directory.runnerMode(w.id) === 'company' ? '<meta name="tandem-runner" content="company">' : '';
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
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return page(req, reply);
    return reply.code(404).send({ error: 'Not found.' });
  });

  await app.listen({ host: cfg.listenHost, port: cfg.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  listenPort = port;
  // Every workspace's runner keeps working while nobody is signed in.
  for (const w of directory.allWorkspaces()) openIfCloud(w.id);
  logger.info('tandem hosted started', { port, publicUrl: cfg.publicUrl });
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    directory,
    cells,
    hub,
    stop: async () => {
      hub.close();
      await app.close();
      for (const c of cells.values()) await (await c.catch(() => undefined))?.stop();
      directory.close();
    },
  };
}
