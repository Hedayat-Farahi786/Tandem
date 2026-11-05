import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JiraError } from '@tandem/adapters';
import { HttpError, type ServerContext } from '../app.js';
import { auditOwner } from '../audit.js';

/*
 * Connecting Jira in the app, and what the pickers show once it is connected: its projects, its
 * statuses and its people. No route returns a token.
 *
 * Atlassian's sign-in: the local app starts it here (POST /api/jira/oauth/start) and Atlassian sends
 * the person back to /auth/jira/callback. In the web app the front server does both, then hands the
 * finished sign-in to the workspace (POST /api/jira/oauth), a route only it can reach.
 */

const Site = z.object({ id: z.string().min(1).max(100), name: z.string().max(200), url: z.string().url().max(300) });
export const JiraGrantBody = z.object({ access: z.string().min(1).max(8000), refresh: z.string().max(8000).optional(), expiresAt: z.number().int(), sites: z.array(Site).max(50) });

/** Back where the person started connecting: the setup wizard, or Settings › Jira. */
export const jiraBack = (from: string, outcome: 'connected' | 'choose' | 'failed', message?: string) => `${from === 'setup' ? '/setup' : '/settings'}?jira=${outcome}${message ? `&message=${encodeURIComponent(message.slice(0, 300))}` : ''}${from === 'setup' ? '' : '#jira'}`;
export const JiraFrom = z.object({ from: z.enum(['settings', 'setup']).default('settings') });

export function registerJiraRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { tandem } = ctx;
  const jira = tandem.jira;
  const connectedTracker = async () => {
    const t = await jira.tracker();
    if (!t) throw new HttpError(409, 'Connect Jira first (Settings › Jira).');
    return t;
  };
  const audited = async (summary: string) => auditOwner(tandem.store, { action: 'jira.connected', summary, detail: {} });

  app.get('/api/jira', async () => jira.state());

  app.post('/api/jira/token', async (req) => {
    const body = z.object({ site: z.string().max(500), email: z.string().max(200).optional(), token: z.string().max(2000) }).parse(req.body);
    const s = await jira.useToken({ site: body.site, token: body.token, ...(body.email ? { email: body.email } : {}) });
    await audited(`Connected Jira at ${s.site?.url ?? body.site} with a token.`);
    return s;
  });

  app.post('/api/jira/oauth/start', async (req) => ({ url: jira.startSignIn(JiraFrom.parse(req.body ?? {}).from) }));

  // The web app's front server, after Atlassian's sign-in (members can't reach this route there).
  app.post('/api/jira/oauth', async (req) => {
    const g = JiraGrantBody.parse(req.body);
    const s = await jira.useGrant({ access: g.access, ...(g.refresh ? { refresh: g.refresh } : {}), expiresAt: g.expiresAt, sites: g.sites });
    if (s.connected) await audited(`Connected Jira at ${s.site?.url} with Atlassian's sign-in.`);
    return s;
  });

  app.post('/api/jira/site', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.body);
    const s = await jira.chooseSite(id);
    await audited(`Connected Jira at ${s.site?.url} with Atlassian's sign-in.`);
    return s;
  });

  app.delete('/api/jira', async () => {
    await jira.disconnect();
    await auditOwner(tandem.store, { action: 'jira.disconnected', summary: 'Disconnected Jira.', detail: {} });
    return jira.state();
  });

  app.get('/api/jira/projects', async () => ({ projects: await (await connectedTracker()).projects() }));
  app.get('/api/jira/statuses', async (req) => {
    const { project } = z.object({ project: z.string().max(100).optional() }).parse(req.query);
    return { statuses: await (await connectedTracker()).statuses(project || undefined) };
  });
  app.get('/api/jira/people', async (req) => {
    const { query } = z.object({ query: z.string().max(100).default('') }).parse(req.query);
    return { people: query.trim().length < 2 ? [] : await (await connectedTracker()).people(query) };
  });

  // The local app: Atlassian sends the person back here, signed in.
  app.get('/auth/jira/callback', async (req, reply) => {
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query);
    const from = q.state ? jira.signInFrom(q.state) : 'settings';
    if (q.error || !q.code || !q.state) return reply.redirect(jiraBack(from, 'failed', q.error === 'access_denied' ? 'You cancelled the sign-in at Atlassian.' : 'The sign-in at Atlassian was not completed.'));
    try {
      const s = await jira.finishSignIn(q.state, q.code);
      if (s.connected) await audited(`Connected Jira at ${s.site?.url} with Atlassian's sign-in.`);
      return reply.redirect(jiraBack(from, s.connected ? 'connected' : 'choose'));
    } catch (err) {
      return reply.redirect(jiraBack(from, 'failed', err instanceof JiraError ? err.message : 'Jira could not be connected. Please try again.'));
    }
  });
}
