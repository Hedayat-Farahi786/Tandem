import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { ActionError, NotFoundError, TransitionError, redactor, type ChatService, type Logger } from '@tandem/core';
import { JiraError, type Tandem } from '@tandem/adapters';
import type { EventBus } from './events.js';
import type { DoctorReport } from './doctor.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerEventRoutes } from './routes/events.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerTaskRoutes } from './routes/tasks.js';

export interface ServerContext {
  tandem: Tandem;
  bus: EventBus;
  chat: ChatService;
  logger?: Logger;
  /** Last doctor run (shown on the Doctor screen and used for "first run"). */
  doctor: { last?: DoctorReport | undefined; running?: Promise<DoctorReport> | undefined };
}

export interface AppOptions {
  port: number;
  /** Per-launch token required on every state-changing request. */
  token?: string;
  /** Built web app (apps/web/dist). Omit to serve the API only. */
  webDir?: string;
  version?: string;
}

/** Plain-language HTTP errors: what happened, and what to do next. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorReply(err: unknown): { status: number; error: string } {
  if (err instanceof HttpError) return { status: err.status, error: err.message };
  if (err instanceof NotFoundError) return { status: 404, error: err.message };
  if (err instanceof ActionError || err instanceof TransitionError) return { status: 409, error: err.message };
  if (err instanceof ZodError) return { status: 400, error: `Some fields are not valid: ${err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}.` };
  if (err instanceof JiraError) return { status: 502, error: err.message };
  const e = err as { statusCode?: number; validation?: unknown; message?: string };
  if (e?.statusCode && e.statusCode < 500) return { status: e.statusCode, error: e.message ?? 'Bad request.' };
  return { status: 500, error: `Something went wrong: ${String(e?.message ?? err).split('\n')[0]}. Details are in the Tandem log (~/.tandem/logs).` };
}

export async function buildApp(ctx: ServerContext, o: AppOptions): Promise<{ app: FastifyInstance; token: string }> {
  const token = o.token ?? randomBytes(24).toString('base64url');
  redactor.register(token);
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, forceCloseConnections: true });
  const allowedHosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`]);

  // Local-only security: loopback Host (blocks DNS rebinding), same-origin, token on writes.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) return reply.code(421).send({ error: `Tandem only answers on 127.0.0.1:${o.port}. Open http://127.0.0.1:${o.port}.` });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'Requests from other sites are not allowed.' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && req.url.startsWith('/api/')) {
      if (req.headers['x-tandem-token'] !== token) return reply.code(403).send({ error: 'Missing or wrong Tandem token. Reload the page.' });
    }
    return undefined;
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });
  app.setErrorHandler((err, req, reply) => {
    const r = errorReply(err);
    if (r.status >= 500) ctx.logger?.error('request failed', { url: req.url, method: req.method, error: String((err as Error).stack ?? err) });
    void reply.code(r.status).send({ error: redactor.redact(r.error) });
  });

  app.get('/api/health', async () => ({ ok: true, version: o.version ?? '0.0.0' }));
  registerSetupRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  app.all('/api/*', async () => {
    throw new HttpError(404, 'No such API endpoint.');
  });

  if (o.webDir && existsSync(join(o.webDir, 'index.html'))) {
    const index = readFileSync(join(o.webDir, 'index.html'), 'utf8').replace('<meta name="tandem-token" content="">', `<meta name="tandem-token" content="${token}">`);
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    await app.register(fastifyStatic, { root: o.webDir, index: false, wildcard: false, serve: true });
    const sendIndex = (_req: FastifyRequest, reply: FastifyReply) => reply.header('Content-Security-Policy', csp).header('Cache-Control', 'no-store').type('text/html').send(index);
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return sendIndex(req, reply);
      return reply.code(404).send({ error: 'Not found.' });
    });
  }
  return { app, token };
}
