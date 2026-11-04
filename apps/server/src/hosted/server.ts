import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Logger } from '@tandem/core';
import type { RuntimeConfig } from '@tandem/shared';
import { createLogger } from '../logger.js';
import { openCell, type Cell } from '../start.js';
import { Directory, type Session } from './directory.js';
import { signInPage } from './sign-in-page.js';

/*
 * Tandem as a hosted web app. One front server: GitHub sign-in, sessions, workspaces. Behind it,
 * one cell per workspace (its own database, engine and runner), reached only through the front.
 * Every request is checked here first: signed in, member of the workspace, and for changes, the
 * session's own CSRF token. Cookies are host-only, HttpOnly, Secure and SameSite=Lax.
 */

export const HostedConfig = z.object({
  home: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  listenHost: z.string().default('0.0.0.0'),
  /** The app's public address, e.g. https://app.example.com (no trailing slash). */
  publicUrl: z.string().url().transform((u) => u.replace(/\/+$/, '')),
  github: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    /** Test seams: GitHub's web and API addresses. */
    webUrl: z.string().url().default('https://github.com'),
    apiUrl: z.string().url().default('https://api.github.com'),
  }),
  /** 32 random bytes, base64: seals stored tokens. */
  secretKey: z.string().min(40),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  agent: z.enum(['copilot', 'scripted']).default('copilot'),
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
    github: { clientId: need('TANDEM_GITHUB_CLIENT_ID'), clientSecret: need('TANDEM_GITHUB_CLIENT_SECRET'), ...(env.TANDEM_GITHUB_WEB_URL ? { webUrl: env.TANDEM_GITHUB_WEB_URL } : {}), ...(env.TANDEM_GITHUB_API_URL ? { apiUrl: env.TANDEM_GITHUB_API_URL } : {}) },
    secretKey: need('TANDEM_SECRET_KEY'),
    logLevel: env.TANDEM_LOG_LEVEL ?? 'info',
    agent: env.TANDEM_AGENT ?? 'copilot',
  });
}

const SESSION = 'tandem_session';
const OAUTH = 'tandem_oauth';
const CELL_HOST = 'cell.tandem.internal';

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
  stop(): Promise<void>;
}

export async function startHosted(cfg: HostedConfig, o: { webDir?: string; fetch?: typeof fetch } = {}): Promise<Hosted> {
  const http = o.fetch ?? fetch;
  mkdirSync(join(cfg.home, 'workspaces'), { recursive: true, mode: 0o700 });
  const logger: Logger = createLogger(join(cfg.home, 'logs'), cfg.logLevel === 'silent' ? 'silent' : cfg.logLevel);
  const directory = await Directory.open(join(cfg.home, 'directory.db'), cfg.secretKey);
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
      const config: RuntimeConfig = { home, host: '127.0.0.1', port: listenPort, logLevel: cfg.logLevel, agent: cfg.agent, overrides: {}, seeds: {} };
      c = openCell({ home, config, logger, webDir: undefined, port: listenPort, allowedHost: CELL_HOST }).then(async (cell) => {
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

  /* ---------------------------------------------------------------- app */

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, trustProxy: true, forceCloseConnections: true });
  const publicHost = new URL(cfg.publicUrl).host;
  app.addHook('onRequest', async (req, reply) => {
    // Only the public address (and loopback, for health checks and the git helper).
    const host = req.headers.host ?? '';
    if (host !== publicHost && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return reply.code(421).send({ error: 'Unknown host.' });
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
  const currentWorkspace = (s: { id: string; session: Session }) => {
    const mine = directory.workspacesOf(s.session.userId);
    const w = mine.find((x) => x.id === s.session.workspaceId) ?? mine[0];
    return w;
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
    const workspaces = directory.workspacesOf(user.id);
    const workspace = workspaces[0] ?? directory.createWorkspace(`${user.name}'s workspace`, user.id);
    void cellFor(workspace.id);
    const { id } = directory.createSession(user.id, workspace.id);
    logger.info('signed in', { user: user.id });
    return reply.header('Set-Cookie', cookie(SESSION, id, 14 * 86_400)).redirect('/');
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
    void cellFor(w.id);
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
      const cell = cells.get(w);
      cells.delete(w);
      if (cell) await (await cell.catch(() => undefined))?.stop();
      directory.deleteWorkspace(w);
      rmSync(cellHome(w), { recursive: true, force: true });
    }
    logger.info('account deleted', { workspacesDeleted: orphans.length });
    return reply.header('Set-Cookie', cookie(SESSION, '', 0)).send({ ok: true, workspacesDeleted: orphans.length });
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
    const cell = await cellFor(w.id);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['cookie', 'origin', 'host', 'x-tandem-token', 'content-length'].includes(k)) headers[k] = v;
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
    return reply.send(indexHtml.replace('<meta name="tandem-token" content="">', `<meta name="tandem-token" content="${s.session.csrf}"><meta name="tandem-mode" content="hosted">`));
  };
  app.get('/', page);
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return page(req, reply);
    return reply.code(404).send({ error: 'Not found.' });
  });

  await app.listen({ host: cfg.listenHost, port: cfg.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  listenPort = port;
  // Every workspace's runner keeps working while nobody is signed in.
  for (const w of directory.allWorkspaces()) void cellFor(w.id);
  logger.info('tandem hosted started', { port, publicUrl: cfg.publicUrl });
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    directory,
    cells,
    stop: async () => {
      await app.close();
      for (const c of cells.values()) await (await c.catch(() => undefined))?.stop();
      directory.close();
    },
  };
}
