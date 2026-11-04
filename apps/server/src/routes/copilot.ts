import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type ServerContext } from '../app.js';
import { auditOwner } from '../audit.js';

const WORKING = ['READINESS', 'SPEC_DRAFTING', 'BUILDING', 'VERIFYING', 'SELF_REVIEW'] as const;
const flowId = (req: { params: unknown }) => z.object({ flow: z.string().min(1).max(200) }).parse(req.params).flow;

/**
 * Connecting Copilot: sign in with a personal or work GitHub account in the browser (github.com,
 * GitHub Enterprise Cloud on *.ghe.com), or with a fine-grained token; switch accounts; sign out.
 * The runtime keeps the credentials in the system keychain. No route ever returns a token.
 */
export function registerCopilotRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { tandem } = ctx;
  const { store } = tandem;

  /** Changing the account under a running task or chat would cut it off: wait for the work to stop. */
  const idle = async () => {
    const tasks = await store.tasks.listByState(WORKING);
    if (tasks.length) throw new HttpError(409, `Copilot is working on ${tasks.map((t) => t.key).join(', ')}. Change the account once it finishes, or cancel it.`);
    if ((await store.runs.list()).some((r) => r.status === 'running')) throw new HttpError(409, 'Copilot is answering in a chat. Change the account once the answer is in.');
  };

  app.get('/api/copilot/accounts', async () => {
    try {
      return { ...(await tandem.accounts.state()), host: (await tandem.settings()).copilot.host || 'github.com' };
    } catch (err) {
      return { signedIn: false, accounts: [], providers: [], error: String((err as Error).message ?? err), host: (await tandem.settings()).copilot.host || 'github.com' };
    }
  });

  app.post('/api/copilot/sign-in', async (req) => {
    const { kind } = z.object({ kind: z.enum(['githubDotCom', 'proxima', 'entra']) }).parse(req.body);
    await idle();
    return tandem.accounts.begin(kind);
  });

  app.post('/api/copilot/sign-in/:flow/next', async (req) => {
    const { input } = z.object({ input: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const step = await tandem.accounts.advance(flowId(req), input);
    if (step.kind === 'done') await auditOwner(store, { action: 'copilot.signed-in', summary: `Connected Copilot as ${step.login ?? 'an account'} on ${step.host ?? 'github.com'}.`, detail: { host: step.host, login: step.login } });
    return step;
  });

  app.post('/api/copilot/sign-in/:flow/url', async (req) => {
    const { url } = z.object({ url: z.string().trim().min(10).max(4000) }).parse(req.body);
    const step = await tandem.accounts.finishWithUrl(flowId(req), url);
    if (step.kind === 'done') await auditOwner(store, { action: 'copilot.signed-in', summary: `Connected Copilot as ${step.login ?? 'an account'} on ${step.host ?? 'github.com'}.`, detail: { host: step.host, login: step.login } });
    return step;
  });

  app.delete('/api/copilot/sign-in/:flow', async (req) => {
    await tandem.accounts.cancel(flowId(req));
    return { ok: true };
  });

  app.post('/api/copilot/token', async (req) => {
    const { host, token } = z.object({ host: z.string().trim().max(200).default('github.com'), token: z.string().trim().min(20, 'That token looks too short.').max(400) }).parse(req.body);
    await idle();
    try {
      const r = await tandem.accounts.signInWithToken(host, token);
      await auditOwner(store, { action: 'copilot.signed-in', summary: `Connected Copilot with a token${r.login ? ` as ${r.login}` : ''} on ${r.host}.`, detail: { host: r.host, login: r.login, saved: r.saved } });
      return r;
    } catch (err) {
      throw new HttpError(400, String((err as Error).message ?? err).replace(/^Request \S+ failed with message:\s*/, ''));
    }
  });

  app.post('/api/copilot/accounts/:id/use', async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    await idle();
    await tandem.accounts.switchTo(id);
    await auditOwner(store, { action: 'copilot.switched', summary: 'Switched the Copilot account.', detail: {} });
    return tandem.accounts.state();
  });

  app.delete('/api/copilot/accounts/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    await idle();
    await tandem.accounts.signOut(id);
    await auditOwner(store, { action: 'copilot.signed-out', summary: 'Signed a Copilot account out.', detail: {} });
    return tandem.accounts.state();
  });
}
