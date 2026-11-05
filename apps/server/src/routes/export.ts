import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../app.js';
import { auditOwner } from '../audit.js';

/**
 * All of the data Tandem keeps here, in one JSON file (GDPR Art. 20, data portability): settings,
 * repositories, projects, rules, chats, tasks with everything recorded about them, Copilot usage
 * and the audit log. Secrets are never part of it: they live in the keychain (or sealed, per
 * workspace) and no route returns them.
 */
export function registerExportRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { store } = ctx.tandem;

  app.get('/api/export', async (_req, reply) => {
    const [settings, repos, projects, rules, threads, tasks, usage, audit] = await Promise.all([store.settings.get(), store.repos.list(), store.projects.list(), store.rules.list(), store.threads.list(), store.tasks.list(), store.usage.list({}), store.audit.list()]);
    const chats = await Promise.all(threads.map(async (t) => ({ ...t, messages: await store.messages.list(t.id) })));
    const work = await Promise.all(
      tasks.map(async (t) => {
        const [transitions, specs, approvals, verifyRuns, criterionTests, findings, prs, runs, agentSteps] = await Promise.all([
          store.transitions.list(t.id),
          store.specs.list(t.id),
          store.approvals.list(t.id),
          store.verifyRuns.list(t.id),
          store.criterionTests.list(t.id),
          store.findings.list(t.id),
          store.prs.list(t.id),
          store.runs.listFor({ taskId: t.id }),
          store.agentSteps.list({ taskId: t.id }),
        ]);
        return { ...t, transitions, specs, approvals, verifyRuns, criterionTests, findings, pullRequests: prs, copilotRuns: runs, copilotSteps: agentSteps };
      }),
    );
    await auditOwner(store, { action: 'data.exported', summary: 'Exported all data (projects, tasks, chats and the audit log).', detail: { tasks: tasks.length, chats: threads.length } });
    const at = new Date().toISOString();
    return reply
      .header('Content-Disposition', `attachment; filename="tandem-data-${at.slice(0, 10)}.json"`)
      .header('Cache-Control', 'no-store')
      .send({ format: 'tandem-export', version: 1, exportedAt: at, settings, repositories: repos, projects, rules, chats, tasks: work, copilotUsage: usage, auditLog: audit });
  });
}
