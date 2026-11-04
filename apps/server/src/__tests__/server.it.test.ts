import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, startServer, type Running } from '../start.js';

/*
 * The real server in test mode over HTTP: first-run doctor, setup, a task from the API through
 * spec review and both approvals to a console-link PR, spec exports, the diff and live events.
 * Git remotes are local bare repos; the scripted agent stands in for Copilot.
 */
const PORT = 4502;
let dir: string;
let server: Running;
const events: Array<{ type: string; taskId?: string; to?: string }> = [];
let abort: AbortController;

const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; res: Response }> => {
  const res = await fetch(`${server.url}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Tandem-Token': server.token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ct = res.headers.get('content-type') ?? '';
  const data = (ct.includes('json') ? await res.json() : ct.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text()) as T;
  return { status: res.status, data, res };
};
async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, ms = 150_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-server-it-'));
  const remotes = join(dir, 'remotes');
  const bare = join(remotes, 'shop.git');
  const g = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  mkdirSync(remotes, { recursive: true });
  g(['init', '--bare', bare]);
  g(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  const seed = join(dir, 'seed');
  g(['clone', pathToFileURL(bare).href, seed]);
  g(['checkout', '-b', 'main'], seed);
  writeFileSync(join(seed, 'README.md'), '# shop\n');
  g(['add', '.'], seed);
  g(['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-m', 'init'], seed);
  g(['push', 'origin', 'HEAD:refs/heads/main'], seed);

  process.env.TANDEM_TEST_REMOTE_ROOT = remotes;
  const config = readConfig({ TANDEM_HOME: join(dir, 'home'), TANDEM_PORT: String(PORT), TANDEM_AGENT: 'scripted', TANDEM_LOG_LEVEL: 'silent' });
  server = await startServer(config, { webDir: join(dir, 'no-web'), quiet: true });

  abort = new AbortController();
  void (async () => {
    const res = await fetch(`${server.url}/api/events`, { signal: abort.signal });
    const reader = res.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (const m of buf.matchAll(/^data: (.+)$/gm)) events.push(JSON.parse(m[1]!) as (typeof events)[number]);
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  })().catch(() => undefined);
});

afterAll(async () => {
  abort?.abort();
  await server?.stop();
  delete process.env.TANDEM_TEST_REMOTE_ROOT;
  rmSync(dir, { recursive: true, force: true });
});

describe('server in test mode', () => {
  let taskId = '';

  it('runs doctor on first launch without any Copilot prompt', async () => {
    const first = await server.firstDoctor!;
    expect(first.checks.find((c) => c.id === 'node')?.status).toBe('pass');
    expect(first.checks.find((c) => c.id === 'git')?.status).toBe('pass');
    expect((await call<{ setupComplete: boolean; agent: string }>('GET', '/api/bootstrap')).data).toMatchObject({ setupComplete: false, agent: 'scripted' });
    expect((await call('GET', '/api/doctor')).data).toMatchObject({ at: first.at });
  });

  it('sets up a repository and project, and doctor reads the repository', async () => {
    const repo = await call<{ id: string }>('POST', '/api/repos', { url: 'codecommit::eu-central-1://shop', defaultBranch: 'main', role: 'full-stack', commands: { test: 'git --version' } });
    expect(repo.status).toBe(200);
    const project = await call<{ id: string }>('POST', '/api/projects', { name: 'Shop', repoIds: [repo.data.id], pmGate: 'tandem', pmNames: ['Pat'] });
    expect(project.status).toBe(200);
    const doctor = await call<{ checks: Array<{ group: string; status: string; label: string }> }>('POST', '/api/doctor');
    expect(doctor.data.checks.filter((c) => c.group === 'Repositories').map((c) => c.status)).toEqual(['pass']);
    const created = await call<{ id: string; state: string }>('POST', '/api/tasks', {
      projectId: project.data.id,
      title: 'Health endpoint',
      submit: true,
      requirement: {
        goal: 'Expose service health',
        userStory: 'As an operator I want to see whether the service is up',
        criteria: [
          { given: 'the service runs', when: 'GET /health is called', then: 'it returns 200 {"status":"ok"}' },
          { given: 'the page loads', when: 'the call succeeds', then: 'it shows "Status: ok"' },
        ],
        exampleData: 'GET /health -> 200',
        affectedAreas: 'API',
        outOfScope: 'Auth',
      },
    });
    expect(created.data.state).toBe('READINESS');
    taskId = created.data.id;
  });

  it('drafts a spec, exports it as Markdown and PDF, and waits for both keys', async () => {
    await waitFor(async () => ((await call<{ task: { state: string } }>('GET', `/api/tasks/${taskId}`)).data.task.state === 'SPEC_REVIEW' ? true : undefined), 'spec review');
    const md = await call<string>('GET', `/api/tasks/${taskId}/spec/latest?format=md`);
    expect(md.res.headers.get('content-type')).toContain('text/markdown');
    expect(md.data).toContain('| TND-1 | 1 | In review |');
    const pdf = await call<Buffer>('GET', `/api/tasks/${taskId}/spec/1?format=pdf`);
    expect(pdf.res.headers.get('content-disposition')).toBe('attachment; filename="TND-1-spec-v1.pdf"');
    expect(pdf.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await call('POST', `/api/tasks/${taskId}/approve`, {})).status).toBe(200);
    expect((await call<{ task: { state: string } }>('GET', `/api/tasks/${taskId}`)).data.task.state).toBe('SPEC_REVIEW');
    expect((await call('POST', `/api/tasks/${taskId}/pm-approval`, { name: 'Pat', date: new Date().toISOString(), evidence: 'Planning call' })).status).toBe(200);
  });

  it('builds, verifies, pushes and prepares a console-link pull request', async () => {
    const d = await waitFor(async () => {
      const r = (await call<{ task: { state: string; blockedMessage?: string }; prs: Array<{ url: string; status: string; manual: boolean }>; verifyRuns: Array<{ passed: boolean }> }>('GET', `/api/tasks/${taskId}`)).data;
      if (r.task.state === 'FAILED' || r.task.state === 'BLOCKED') throw new Error(`${r.task.state}: ${r.task.blockedMessage}`);
      return r.task.state === 'PR_OPEN' && r.prs.length > 0 ? r : undefined;
    }, 'PR open');
    expect(d.verifyRuns.at(-1)?.passed).toBe(true);
    expect(d.prs).toHaveLength(1);
    expect(d.prs[0]).toMatchObject({ status: 'manual-pending', manual: true });
    expect(d.prs[0]!.url).toMatch(/^https:\/\/eu-central-1\.console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/shop\/pull-requests\/new\/refs\/heads\/main\/\.\.\.\/refs\/heads\/feature\/TND-1-/);
    const diff = await call<Array<{ name: string; diff: string }>>('GET', `/api/tasks/${taskId}/diff`);
    expect(diff.data[0]!.name).toBe('shop');
    expect(diff.data[0]!.diff).toContain('+++ b/HEALTH.md');
    const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: join(dir, 'remotes', 'shop.git') }).toString();
    expect(branches).toMatch(/feature\/TND-1-/);
  });

  it('streamed the transitions live over SSE', () => {
    const states = events.filter((e) => e.type === 'task.transition' && e.taskId === taskId).map((e) => e.to);
    expect(states).toEqual(expect.arrayContaining(['READINESS', 'SPEC_DRAFTING', 'SPEC_REVIEW', 'BUILDING', 'VERIFYING', 'SELF_REVIEW', 'PR_OPEN']));
  });
});
