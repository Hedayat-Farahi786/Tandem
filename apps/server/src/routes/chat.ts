import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OwnerAnswer, type AgentStep } from '@tandem/shared';
import type { ServerContext } from '../app.js';

const id = (req: { params: unknown }) => (req.params as { id: string }).id;

export function registerChatRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { chat, tandem } = ctx;

  app.get('/api/projects/:id/threads', async (req) => (await tandem.store.threads.listFor({ projectId: id(req) })).filter((t) => t.mode !== 'task').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  app.post('/api/threads', async (req) => chat.createThread(z.object({ projectId: z.string(), mode: z.enum(['ask', 'request']), title: z.string().optional(), model: z.string().optional() }).parse(req.body)));
  app.get('/api/threads/:id', async (req) => {
    const thread = await tandem.store.threads.get(id(req));
    if (!thread) throw Object.assign(new Error('Chat not found.'), { statusCode: 404 });
    const messages = await chat.messages(thread.id);
    // What Copilot did for each answer, shown folded above it.
    const steps: Record<string, AgentStep[]> = {};
    for (const m of messages) if (m.runId) steps[m.runId] = (await tandem.store.agentSteps.list({ runId: m.runId })).filter((x) => x.kind !== 'prompt' && x.kind !== 'message');
    return { thread, model: await chat.modelOf(thread), messages, steps, readiness: thread.mode === 'request' ? tandem.service.readiness(thread.draft ?? {}) : null };
  });
  /** One agent run's steps so far (the chat shows them live while Copilot works). */
  app.get('/api/agent-runs/:id/steps', async (req) => (await tandem.store.agentSteps.list({ runId: id(req) })).filter((x) => x.kind !== 'prompt' && x.kind !== 'message'));
  /** Picks the chat's model ('' = Auto). In a task chat this picks it for the whole task. */
  app.put('/api/threads/:id/model', async (req) => {
    const thread = await chat.setModel(id(req), z.object({ model: z.string() }).parse(req.body).model);
    return { thread, model: await chat.modelOf(thread) };
  });
  /** Sends a message. The reply streams as agent.delta events (threadId) and comes back here when done. */
  app.post('/api/threads/:id/messages', async (req) => {
    const body = z.object({ text: z.string(), answers: z.array(OwnerAnswer).optional() }).parse(req.body);
    return chat.send(id(req), body.text, undefined, body.answers);
  });
  app.post('/api/threads/:id/create-task', async (req) => chat.createTask(id(req)));
  app.post('/api/threads/:id/spec-change/apply', async (req) => chat.applySpecChange(id(req)));
  /** Task chat: continue the task with the owner's message (text) or with what the agent proposed. */
  app.post('/api/threads/:id/continue', async (req) => chat.continueTask(id(req), z.object({ text: z.string().optional() }).parse(req.body ?? {}).text));
  app.post('/api/threads/:id/continue/dismiss', async (req) => {
    await chat.dismissContinue(id(req));
    return { dismissed: true };
  });
  app.post('/api/threads/:id/spec-change/dismiss', async (req) => {
    await chat.dismissSpecChange(id(req));
    return { dismissed: true };
  });
}
