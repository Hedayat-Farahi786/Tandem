/**
 * The hosted web app end to end: the built server in TANDEM_MODE=hosted, behind a pretend GitHub
 * (sign-in only), with the scripted agent and local copies of the CodeCommit sandbox repos.
 *
 * Two people sign in with GitHub. Mona owns the workspace and invites Hubot with a link. Mona adds a
 * repository and a project and asks for a change in chat (which approves the spec as her); Hubot
 * records the PM's approval; the
 * scripted Copilot builds it, the checks run, and the task ends at its pull request. A third person
 * sees none of it.
 *
 *   pnpm build && pnpm test:flows e2e/flows/hosted.e2e.test.ts
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, repoName, type Detail } from './harness.js';

const REQUEST = "Add a GET /health endpoint returning {status: 'ok'} and show the status on the main page.";
const ANSWER = 'Show "Checking status…" while loading and "Status unavailable" if it fails. Authentication and metrics are out of scope.';

/** GitHub's OAuth code exchange and /user, for three people. Nothing else of GitHub is used. */
const people: Record<string, { id: number; login: string; name: string }> = {
  'code-mona': { id: 101, login: 'mona', name: 'Mona Lisa' },
  'code-hubot': { id: 102, login: 'hubot', name: 'Hubot' },
  'code-eve': { id: 103, login: 'eve', name: 'Eve' },
};
let github: Server;
async function startGitHub(): Promise<string> {
  github = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://github.test');
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const { code, grant_type } = JSON.parse(body || '{}') as { code?: string; grant_type?: string };
        if (grant_type === 'refresh_token') return res.end(JSON.stringify({ error: 'bad_refresh_token' }));
        return res.end(JSON.stringify(code && people[code] ? { access_token: `ghu_${code}`, expires_in: 28_800, refresh_token: `ghr_${code}`, refresh_token_expires_in: 15_897_600 } : { error: 'bad_verification_code' }));
      }
      if (url.pathname === '/user') {
        const p = people[String(req.headers.authorization ?? '').replace('Bearer ghu_', '')];
        res.statusCode = p ? 200 : 401;
        return res.end(JSON.stringify(p ? { ...p, email: null, avatar_url: null } : { message: 'Bad credentials' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', r));
  const a = github.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}

let h: Harness;
type Session = { cookie: string; token: string };
const as = async <T>(s: Session, fn: () => Promise<T>): Promise<T> => {
  const before = h.session;
  h.useSession(s);
  try {
    return await fn();
  } finally {
    h.useSession(before);
  }
};
const raw = (s: Session, method: string, path: string, body?: unknown) =>
  fetch(`${h.url}${path}`, { method, redirect: 'manual', headers: { cookie: s.cookie, ...(method !== 'GET' ? { 'x-tandem-token': s.token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

let mona: Session;
let hubot: Session;
let projectId = '';

beforeAll(async () => {
  const gh = await startGitHub();
  h = new Harness({ hosted: { github: gh, as: 'code-mona' } });
  await h.prepareRemotes(['fullstack']);
  await h.start();
  mona = h.session;
}, 300_000);

afterAll(async () => {
  await h?.stop();
  h?.cleanup();
  await new Promise((r) => github?.close(r));
  console.warn(`Hosted flow: server log ${h?.logFile}`);
});

describe('Tandem as a hosted web app · scripted agent · local remotes', () => {
  it('signs in with GitHub and gives the person their own workspace, served by the app', async () => {
    const me = await h.api<{ user: { login: string }; workspaces: Array<{ name: string; role: string }> }>('GET', '/api/me');
    expect(me).toMatchObject({ user: { login: 'mona' }, workspaces: [{ name: "Mona Lisa's workspace", role: 'owner' }] });
    const page = await (await fetch(`${h.url}/projects`, { headers: { cookie: mona.cookie } })).text();
    expect(page).toContain('<meta name="tandem-mode" content="hosted">');
    // Signed out, the same address shows the sign-in page, and APIs say "sign in".
    expect(await (await fetch(`${h.url}/projects`)).text()).toContain('Continue with GitHub');
    expect((await fetch(`${h.url}/api/bootstrap`)).status).toBe(401);
  });

  it('never reaches this server: no folders, no local clones, no AWS profiles', async () => {
    expect(await h.api('GET', '/api/repos/local')).toEqual([]);
    await expect(h.api('POST', '/api/repos/detect', { path: '/etc' })).rejects.toThrow(/400|403/);
    const aws = await h.api<{ connected: boolean; profiles?: string[] }>('GET', '/api/aws');
    expect(aws.connected).toBe(false);
    expect(aws.profiles ?? []).toEqual([]);
    await expect(h.api('POST', '/api/aws/profile', { profile: 'default' })).rejects.toThrow(/400/);
  });

  it('invites a colleague with a link; they join after signing in, as a member', async () => {
    const invite = await h.api<{ url: string }>('POST', '/api/workspace/invites', { role: 'member' });
    expect(invite.url).toMatch(new RegExp(`^${h.url}/join/[\\w-]{20,}$`));
    // Hubot opens the link signed out: the sign-in page, and a cookie to come back to it.
    const visit = await fetch(invite.url, { redirect: 'manual' });
    expect(await visit.text()).toContain('been invited to a workspace');
    const join = visit.headers.getSetCookie().find((c) => c.startsWith('tandem_join='))!.split(';')[0]!;
    hubot = await h.signIn('code-hubot', join);
    const ws = await as(hubot, () => h.api<{ name: string; role: string; members: Array<{ login: string; role: string }> }>('GET', '/api/workspace'));
    expect(ws).toMatchObject({ name: "Mona Lisa's workspace", role: 'member' });
    expect(ws.members.map((m) => [m.login, m.role])).toEqual([
      ['mona', 'owner'],
      ['hubot', 'member'],
    ]);
    // A member can't invite or rename; the owner can't be demoted while she is the only one.
    expect((await raw(hubot, 'POST', '/api/workspace/invites', {})).status).toBe(403);
    expect((await raw(hubot, 'PATCH', '/api/workspace', { name: 'Mine now' })).status).toBe(403);
    const monaId = (ws.members as Array<{ id: string; login: string }>).find((m) => m.login === 'mona')!.id;
    expect((await raw(mona, 'POST', `/api/workspace/members/${monaId}/role`, { role: 'member' })).status).toBe(409);
  });

  it('adds a repository and a project, turns a chat request into a task, and ends at the pull request', async () => {
    const url = `codecommit::eu-central-1://${repoName('fullstack')}`;
    const detected = await h.api<{ repo: Record<string, unknown> & { role: string } }>('POST', '/api/repos/detect', { url });
    expect(detected.repo.role).toBe('full-stack');
    const repo = await h.api<{ id: string }>('POST', '/api/repos', { ...detected.repo, defaultBranch: h.base });
    projectId = (await h.project('Shop', [repo.id], 'SHOP')).id;

    // Request mode: the request, Tandem's questions as choices, the answers, then the task.
    const first = await h.request(projectId, [REQUEST]);
    type Asked = { thread: { pendingQuestions?: { questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string }> }> } } };
    const asked = (await h.api<Asked>('GET', `/api/threads/${first.threadId}`)).thread.pendingQuestions?.questions ?? [];
    expect(asked.length).toBeGreaterThan(0);
    const answers = asked.map((q) => ({ questionId: q.id, header: q.header, question: q.question, answers: [q.options[0]!.label] }));
    const text = `${answers.map((a) => `${a.header}: ${a.answers.join(', ')}`).join('\n')}\n${ANSWER}`;
    expect((await h.api<{ readiness?: { ready: boolean } }>('POST', `/api/threads/${first.threadId}/messages`, { text, answers })).readiness?.ready).toBe(true);
    const task = await h.api<{ id: string; key: string }>('POST', `/api/threads/${first.threadId}/create-task`);
    await h.waitFor(task.id, 'spec review', (d) => d.task.state === 'SPEC_REVIEW' && Boolean(d.spec));

    // Creating and starting the task approved the spec as Mona. Hubot, a member, sees the same task
    // and records the PM's approval: each entry names who made it.
    await as(hubot, async () => {
      expect((await h.detail(task.id)).task.key).toBe(task.key);
      await h.api('POST', `/api/tasks/${task.id}/pm-approval`, { name: 'Pat Lee', date: new Date().toISOString(), evidence: 'Approved in the planning channel' });
    });

    const d: Detail = await h.waitFor(task.id, 'the pull request', (x) => x.task.state === 'PR_OPEN' && x.prs.length === 1, { ms: 420_000 });
    expect(d.approvalState).toMatchObject({ owner: { name: 'Mona Lisa', specVersion: 1 }, pm: { name: 'Pat Lee' }, complete: true });
    expect(d.verifyRuns.at(-1)?.passed).toBe(true);
    expect(d.prs[0]).toMatchObject({ status: 'manual-pending', manual: true });
    expect(d.task.branch).toMatch(/^feature\/SHOP-\d+-/);
    expect(h.remoteBranches('fullstack').has(d.task.branch)).toBe(true);
    expect(h.remoteFile('fullstack', d.task.branch, 'src/server/app.ts')).toContain("app.get('/health'");

    // The audit log names who did what, and its chain verifies.
    const trace = await h.api<{ audit: Array<{ action: string; actor: string; actorName?: string; summary: string }>; integrity: { ok: boolean } }>('GET', `/api/tasks/${task.id}/trace`);
    const approvals = trace.audit.filter((e) => e.action === 'spec.approved');
    expect(approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: 'owner', actorName: 'Mona Lisa' }),
        expect.objectContaining({ actor: 'pm', actorName: 'Pat Lee', summary: expect.stringContaining('recorded in Tandem by Hubot') }),
      ]),
    );
    expect(trace.integrity.ok).toBe(true);
  });

  it("keeps every other workspace out: a third person sees nothing of Mona's", async () => {
    const eve = await h.signIn('code-eve');
    const boot = await as(eve, () => h.api<{ projects: unknown[] }>('GET', '/api/bootstrap'));
    expect(boot.projects).toEqual([]);
    const tasks = await as(eve, () => h.api<unknown[]>('GET', '/api/tasks'));
    expect(tasks).toEqual([]);
    const me = await as(mona, () => h.api<{ current: string }>('GET', '/api/me'));
    expect((await raw(eve, 'POST', `/api/workspaces/${me.current}/use`)).status).toBe(404);
    // A forged session, or a change without the session's token, gets nowhere.
    expect((await raw({ cookie: 'tandem_session=forged', token: 'x' }, 'GET', '/api/tasks')).status).toBe(401);
    expect((await raw({ cookie: eve.cookie, token: 'wrong' }, 'POST', '/api/projects', { name: 'X', repoIds: [] })).status).toBe(403);
  });

  it('removes a member, who keeps a workspace of their own; deleting an account deletes what only they owned', async () => {
    const ws = await h.api<{ members: Array<{ id: string; login: string }> }>('GET', '/api/workspace');
    const hubotId = ws.members.find((m) => m.login === 'hubot')!.id;
    expect((await raw(mona, 'DELETE', `/api/workspace/members/${hubotId}`)).status).toBe(200);
    const after = await as(hubot, () => h.api<{ workspaces: Array<{ name: string; role: string }> }>('GET', '/api/me'));
    expect(after.workspaces).toEqual([expect.objectContaining({ name: "Hubot's workspace", role: 'owner' })]);
    expect(await as(hubot, () => h.api<unknown[]>('GET', '/api/tasks'))).toEqual([]);

    const exported = await raw(hubot, 'GET', '/api/me/export');
    expect(exported.headers.get('content-disposition')).toContain('tandem-account.json');
    const del = await raw(hubot, 'DELETE', '/api/me');
    expect(await del.json()).toMatchObject({ ok: true, workspacesDeleted: 1 });
    expect((await raw(hubot, 'GET', '/api/me')).status).toBe(401);
    // Mona's workspace and task are untouched.
    expect((await h.api<unknown[]>('GET', '/api/tasks')).length).toBe(1);
  });
});
