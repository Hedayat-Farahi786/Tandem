import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type ServerContext } from '../app.js';
import { activity, activityCsv, verifyAudit, type ActivityKind } from '../audit.js';
import { buildTrace, traceMarkdown } from '../trace.js';

const Kinds = z.enum(['task', 'state', 'spec', 'approval', 'git', 'pr', 'agent', 'checks', 'config']);
const ActivityQuery = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  kinds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : []))
    .pipe(z.array(Kinds)),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

/** Traceability: the activity feed, the audit log's verification and each task's trace, with exports. */
export function registerAuditRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { store } = ctx.tandem;

  app.get('/api/activity', async (req, reply) => {
    const q = ActivityQuery.parse(req.query);
    const query = { ...(q.since ? { since: q.since } : {}), ...(q.until ? { until: q.until } : {}), ...(q.taskId ? { taskId: q.taskId } : {}), ...(q.projectId ? { projectId: q.projectId } : {}), kinds: q.kinds as ActivityKind[] };
    if (!q.format) return activity(store, { ...query, ...(q.limit ? { limit: q.limit } : {}) });
    const { items } = await activity(store, { ...query, limit: q.limit ?? 5000 });
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'csv') return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="tandem-activity-${stamp}.csv"`).send(activityCsv(items));
    return reply.type('application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="tandem-activity-${stamp}.json"`).send(JSON.stringify({ exportedAt: new Date().toISOString(), integrity: await verifyAudit(store), items }, null, 2));
  });

  /** Recomputes the whole hash chain. */
  app.get('/api/audit/verify', async () => verifyAudit(store));

  app.get('/api/tasks/:id/trace', async (req, reply) => {
    const task = await store.tasks.get((req.params as { id: string }).id);
    if (!task) throw new HttpError(404, 'Task not found.');
    const { format } = z.object({ format: z.enum(['json', 'md']).optional() }).parse(req.query);
    const trace = await buildTrace(store, task);
    if (format === 'md') return reply.type('text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${task.key}-trace.md"`).send(traceMarkdown(trace));
    if (format === 'json') return reply.type('application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="${task.key}-trace.json"`).send(JSON.stringify(trace, null, 2));
    return trace;
  });
}
