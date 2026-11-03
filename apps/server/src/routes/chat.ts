import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../app.js';

const id = (req: { params: unknown }) => (req.params as { id: string }).id;

export function registerChatRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { chat, tandem } = ctx;

  app.get('/api/projects/:id/threads', async (req) => (await tandem.store.threads.listFor({ projectId: id(req) })).filter((t) => t.mode !== 'task').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  app.post('/api/threads', async (req) => chat.createThread(z.object({ projectId: z.string(), mode: z.enum(['ask', 'request']), title: z.string().optional() }).parse(req.body)));
  app.get('/api/threads/:id', async (req) => {
    const thread = await tandem.store.threads.get(id(req));
    if (!thread) throw Object.assign(new Error('Chat not found.'), { statusCode: 404 });
    return { thread, messages: await chat.messages(thread.id), readiness: thread.mode === 'request' ? tandem.service.readiness(thread.draft ?? {}) : null };
  });
  /** Sends a message. The reply streams as agent.delta events (threadId) and comes back here when done. */
  app.post('/api/threads/:id/messages', async (req) => chat.send(id(req), z.object({ text: z.string() }).parse(req.body).text));
  app.post('/api/threads/:id/create-task', async (req) => chat.createTask(id(req)));
  app.post('/api/threads/:id/spec-change/apply', async (req) => chat.applySpecChange(id(req)));
  app.post('/api/threads/:id/spec-change/dismiss', async (req) => {
    await chat.dismissSpecChange(id(req));
    return { dismissed: true };
  });
}
