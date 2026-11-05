import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ChatService } from '@tandem/core';
import { MemorySecrets, ScriptedAgent, createTandem, defaultScript, type Tandem } from '@tandem/adapters';
import { buildApp } from '../app.js';
import { EventBus } from '../events.js';

const PORT = 4501;
const TOKEN = 'test-token-0123456789';
const H = { host: `127.0.0.1:${PORT}` };
const W = { ...H, 'x-tandem-token': TOKEN, 'content-type': 'application/json' };
/** Like the web client: DELETE carries the token but no body or content type. */
const D = { ...H, 'x-tandem-token': TOKEN };

let dir: string;
let tandem: Tandem;
let app: FastifyInstance;
let bus: EventBus;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-app-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><meta name="tandem-token" content=""></head><body><div id="root"></div></body></html>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
  bus = new EventBus();
  tandem = await createTandem({ home: join(dir, 'home'), agent: new ScriptedAgent(defaultScript), secrets: new MemorySecrets(), events: bus });
  const chat = new ChatService(tandem.deps, tandem.service);
  ({ app } = await buildApp({ tandem, bus, chat, doctor: {} }, { port: PORT, token: TOKEN, version: '9.9.9' }));
});

afterAll(async () => {
  await app.close();
  await tandem.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('local-only security', () => {
  it('answers only on the loopback host (blocks DNS rebinding)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: `evil.example:${PORT}` } });
    expect(r.statusCode).toBe(421);
    expect(r.json().error).toContain(`127.0.0.1:${PORT}`);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: `localhost:${PORT}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: `127.0.0.1:${PORT + 1}` } })).statusCode).toBe(421);
  });

  it('refuses requests from other origins', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { ...H, origin: 'https://evil.example' } });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { ...H, origin: `http://127.0.0.1:${PORT}` } })).statusCode).toBe(200);
  });

  it('needs the per-launch token on every write', async () => {
    const body = JSON.stringify({ ownerName: 'x' });
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: { ...H, 'content-type': 'application/json' }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', headers: { ...W, 'x-tandem-token': 'wrong' }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/secrets/jira-token', headers: H })).statusCode).toBe(403);
  });

  it('sets hardening headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: H });
    expect(r.json()).toEqual({ ok: true, version: '9.9.9' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('the API', () => {
  it('answers unknown API paths with a plain 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/nope', headers: H });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('No such API endpoint.');
  });
});

describe('settings and secrets', () => {
  it('validates and saves settings', async () => {
    const cur = (await app.inject({ method: 'GET', url: '/api/settings', headers: H })).json();
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: W, payload: JSON.stringify({ ...cur, budget: { ...cur.budget, perTaskPrompts: -1 } }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/^Some fields are not valid: budget\.perTaskPrompts/);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: W, payload: JSON.stringify({ ...cur, ownerName: 'Sam' }) });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: H })).json().ownerName).toBe('Sam');
  });

  it('stores tokens in the secret store only and never returns them', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/jira-token', headers: W, payload: JSON.stringify({ value: 'short' }) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/aws-key', headers: W, payload: JSON.stringify({ value: 'abcdefghijkl' }) })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/api/secrets/jira-token', headers: W, payload: JSON.stringify({ value: 'secret-value-123456' }) });
    expect(put.json()).toEqual({ saved: true });
    const got = await app.inject({ method: 'GET', url: '/api/secrets', headers: H });
    expect(got.json()).toMatchObject({ keychain: { ok: true }, jiraToken: true, githubToken: false });
    expect(got.body).not.toContain('secret-value');
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: H })).body).not.toContain('secret-value');
    await app.inject({ method: 'DELETE', url: '/api/secrets/jira-token', headers: D });
    expect((await app.inject({ method: 'GET', url: '/api/secrets', headers: H })).json().jiraToken).toBe(false);
  });
});

describe('repositories, projects and tasks', () => {
  let repoId: string;
  let projectId: string;
  let taskId: string;

  it('adds repositories and refuses bad or duplicate URLs', async () => {
    const repo = { url: 'codecommit::eu-central-1://shop', defaultBranch: 'main', role: 'full-stack', commands: { test: 'npm test' } };
    const bad = await app.inject({ method: 'POST', url: '/api/repos', headers: W, payload: JSON.stringify({ ...repo, url: 'https://example.com/x.git' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('not a CodeCommit or GitHub URL');
    const ok = await app.inject({ method: 'POST', url: '/api/repos', headers: W, payload: JSON.stringify(repo) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'shop', host: { kind: 'codecommit', region: 'eu-central-1', name: 'shop' } });
    repoId = ok.json().id;
    expect((await app.inject({ method: 'POST', url: '/api/repos', headers: W, payload: JSON.stringify(repo) })).statusCode).toBe(409);
    const detect = await app.inject({ method: 'POST', url: '/api/repos/detect', headers: W, payload: JSON.stringify({ url: 'ftp://nope' }) });
    expect(detect.statusCode).toBe(400);
  });

  it('creates a project and keeps its repos from being deleted', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/projects', headers: W, payload: JSON.stringify({ name: 'Shop', repoIds: [repoId], keyPrefix: 'bad' }) });
    expect(bad.statusCode).toBe(400);
    const jira = await app.inject({ method: 'POST', url: '/api/projects', headers: W, payload: JSON.stringify({ name: 'Shop', repoIds: [repoId], pmGate: 'jira' }) });
    expect(jira.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/projects', headers: W, payload: JSON.stringify({ name: 'Shop', repoIds: [repoId], pmNames: ['Pat'] }) });
    expect(ok.json()).toMatchObject({ name: 'Shop', specRepoId: repoId, contractOrder: [repoId], keyPrefix: 'TND', pmGate: 'tandem' });
    projectId = ok.json().id;
    const del = await app.inject({ method: 'DELETE', url: `/api/repos/${repoId}`, headers: D });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toContain('Shop');
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: H })).json().setupComplete).toBe(true);
  });

  it('keeps the build order and spec repository to the repositories a project has', async () => {
    const other = (await app.inject({ method: 'POST', url: '/api/repos', headers: W, payload: JSON.stringify({ url: 'codecommit::eu-central-1://web', defaultBranch: 'main', role: 'frontend', commands: {} }) })).json();
    // Switch the project to the other repository, sending the old order and spec repo along (as an edit form would).
    const moved = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: W, payload: JSON.stringify({ repoIds: [other.id], contractOrder: [repoId], specRepoId: repoId }) });
    expect(moved.json()).toMatchObject({ repoIds: [other.id], contractOrder: [other.id], specRepoId: other.id });
    // A project stored with stale fields reads consistently.
    const stale = (await tandem.store.projects.get(projectId))!;
    await tandem.store.projects.upsert({ ...stale, repoIds: [repoId], contractOrder: [other.id], specRepoId: other.id });
    const read = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: H })).json().projects.find((p: { id: string }) => p.id === projectId);
    expect(read).toMatchObject({ repoIds: [repoId], contractOrder: [repoId], specRepoId: repoId });
    await tandem.store.projects.upsert({ ...stale, repoIds: [repoId], contractOrder: [repoId], specRepoId: repoId });
    await app.inject({ method: 'DELETE', url: `/api/repos/${other.id}`, headers: D });
  });

  it("shows each project's site icon from its repository, sandboxed", async () => {
    expect((await app.inject({ method: 'GET', url: '/api/project-icons', headers: H })).json()).toEqual({ [projectId]: null });
    // Put a site with an icon in the repository's mirror, as a fetch would.
    const repo = (await tandem.store.repos.get(repoId))!;
    const mirror = tandem.hostFor(repo).mirrorPath(repo);
    const work = join(dir, 'icon-site');
    mkdirSync(join(work, 'public'), { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="8" height="8"/></svg>';
    writeFileSync(join(work, 'public', 'favicon.svg'), svg);
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
    git(work, 'init', '-q');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'site');
    mkdirSync(mirror, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', mirror]);
    git(work, 'push', '-q', mirror, 'HEAD:refs/remotes/origin/main');
    // A second app instance has an empty cache (the first cached "no icon" for a minute).
    const fresh = (await buildApp({ tandem, bus, chat: new ChatService(tandem.deps, tandem.service), doctor: {} }, { port: PORT, token: TOKEN })).app;
    const list = (await fresh.inject({ method: 'GET', url: '/api/project-icons', headers: H })).json();
    expect(list[projectId]).toEqual({ v: expect.stringMatching(/^[0-9a-f]{12}$/) });
    const icon = await fresh.inject({ method: 'GET', url: `/api/projects/${projectId}/icon?v=${list[projectId].v}`, headers: H });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    expect(icon.headers['content-security-policy']).toContain("default-src 'none'");
    expect(icon.headers['x-content-type-options']).toBe('nosniff');
    expect(icon.body).toBe(svg);
    expect((await fresh.inject({ method: 'GET', url: '/api/projects/nope/icon', headers: H })).statusCode).toBe(404);
    await fresh.close();
  });

  it('creates a draft task, shows its detail and edits it', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/tasks', headers: W, payload: JSON.stringify({ projectId, title: 'Health endpoint', requirement: { goal: 'Add GET /health' } }) });
    expect(r.statusCode).toBe(200);
    taskId = r.json().id;
    expect(r.json()).toMatchObject({ key: 'TND-1', state: 'DRAFT' });
    const d = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: H })).json();
    expect(d.task.id).toBe(taskId);
    expect(d.project.id).toBe(projectId);
    expect(d.readiness.ready).toBe(false);
    expect(d.spec).toBeNull();
    const patch = await app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}`, headers: W, payload: JSON.stringify({ requirement: { outOfScope: 'Auth' } }) });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().requirement).toMatchObject({ goal: 'Add GET /health', outOfScope: 'Auth' });
    const list = (await app.inject({ method: 'GET', url: `/api/tasks?projectId=${projectId}`, headers: H })).json();
    expect(list.map((t: { id: string }) => t.id)).toEqual([taskId]);
    expect(list[0].prCount).toBe(0);
  });

  it('lists models with prices and keeps the picked model per chat and per task', async () => {
    const m = (await app.inject({ method: 'GET', url: '/api/copilot/models', headers: H })).json();
    expect(m.models.map((x: { id: string }) => x.id)).toEqual(['scripted-swift', 'scripted-steady']);
    expect(m.models[0]).toMatchObject({ name: 'Scripted Swift', price: { input: 10, output: 50, cachedInput: 1 }, estimate: 1.3 });
    expect(m.models[1].estimate).toBe(21);
    expect(m.auto).toEqual({ light: 'scripted-swift', build: null });
    expect(m.credits).toEqual({ today: 0, perDay: 75, perTask: 25 });

    const bad = await app.inject({ method: 'POST', url: '/api/threads', headers: W, payload: JSON.stringify({ projectId, mode: 'ask', model: 'nope' }) });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toContain('not available');
    const t = (await app.inject({ method: 'POST', url: '/api/threads', headers: W, payload: JSON.stringify({ projectId, mode: 'ask', model: 'scripted-steady' }) })).json();
    expect((await app.inject({ method: 'GET', url: `/api/threads/${t.id}`, headers: H })).json().model).toBe('scripted-steady');
    const cleared = await app.inject({ method: 'PUT', url: `/api/threads/${t.id}/model`, headers: W, payload: JSON.stringify({ model: '' }) });
    expect(cleared.json().model).toBe('');

    const set = await app.inject({ method: 'PUT', url: `/api/tasks/${taskId}/model`, headers: W, payload: JSON.stringify({ model: 'scripted-swift' }) });
    expect(set.json().model).toBe('scripted-swift');
    const d = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: H })).json();
    expect(d.task.model).toBe('scripted-swift');
    expect(d.usage.budget.credits).toEqual({ today: 0, perDay: 75, task: 0, perTask: 25 });
  });

  it('adds a rule and removes it again before any task wrote it', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rules', headers: W, payload: JSON.stringify({ repoId, text: 'Write a test for every bug fix.' }) });
    expect(r.json()).toMatchObject({ status: 'pending', text: 'Write a test for every bug fix.' });
    expect((await app.inject({ method: 'DELETE', url: `/api/rules/${r.json().id}`, headers: D })).json()).toEqual({ deleted: true });
    expect((await app.inject({ method: 'GET', url: '/api/rules', headers: H })).json()).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: '/api/rules/nope', headers: D })).statusCode).toBe(404);
    const committed = { ...r.json(), id: 'c1', status: 'committed' };
    await tandem.store.rules.upsert(committed);
    const refused = await app.inject({ method: 'DELETE', url: '/api/rules/c1', headers: D });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('docs/agent-rules.md');
    await tandem.store.rules.delete('c1');
  });

  it('maps domain errors to plain messages', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tasks/nope', headers: H })).statusCode).toBe(404);
    const approve = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/approve`, headers: W, payload: '{}' });
    expect(approve.statusCode).toBe(409);
    const spec = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/spec/latest`, headers: H });
    expect(spec.statusCode).toBe(404);
    expect(spec.json().error).toBe('That spec version does not exist.');
    const readiness = (await app.inject({ method: 'POST', url: '/api/readiness', headers: W, payload: JSON.stringify({ goal: 'x' }) })).json();
    expect(readiness.missing.length).toBeGreaterThan(0);
  });

  it('cancels a task and then allows deleting the project', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: D })).statusCode).toBe(409);
    const c = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel`, headers: W, payload: '{}' });
    expect(c.json().state).toBe('CANCELLED');
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: D })).statusCode).toBe(200);
  });
});

describe('traceability', () => {
  it('records every change in a verified audit log, without secret values', async () => {
    const { items } = (await app.inject({ method: 'GET', url: '/api/activity?limit=500', headers: H })).json() as { items: Array<{ action: string; actorName?: string; summary: string; seq?: number; detail?: Record<string, unknown> }> };
    const actions = items.map((i) => i.action);
    for (const a of ['settings.updated', 'secret.saved', 'secret.removed', 'repo.added', 'project.created', 'task.created', 'task.model', 'task.state', 'project.deleted']) expect(actions).toContain(a);
    const settings = items.find((i) => i.action === 'settings.updated')!;
    expect(settings.detail?.changes).toEqual([{ field: 'ownerName', from: '', to: 'Sam' }]);
    expect(items.find((i) => i.action === 'task.state')).toMatchObject({ actorName: 'Sam', summary: 'TND-1: Draft → Cancelled. Cancelled by the owner.' });
    expect(JSON.stringify(items)).not.toContain('secret-value');
    // Newest first.
    const seqs = items.filter((i) => i.seq).map((i) => i.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    const verify = (await app.inject({ method: 'GET', url: '/api/audit/verify', headers: H })).json();
    expect(verify).toMatchObject({ ok: true, count: seqs.length });
    expect(verify.head).toMatch(/^[0-9a-f]{64}$/);
    const only = (await app.inject({ method: 'GET', url: '/api/activity?kinds=config', headers: H })).json();
    expect(new Set(only.items.map((i: { kind: string }) => i.kind))).toEqual(new Set(['config']));
    expect((await app.inject({ method: 'GET', url: '/api/activity?kinds=nope', headers: H })).statusCode).toBe(400);
  });

  it('exports the activity as CSV and JSON', async () => {
    const csv = await app.inject({ method: 'GET', url: '/api/activity?format=csv', headers: H });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="tandem-activity-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.body.split('\r\n')[0]).toBe('time,kind,action,actor,actor_name,task,summary,audit_seq,audit_hash,detail');
    expect(csv.body).toContain('secret.saved');
    expect(csv.body).not.toContain('secret-value');
    const json = (await app.inject({ method: 'GET', url: '/api/activity?format=json', headers: H })).json();
    expect(json.integrity.ok).toBe(true);
    expect(json.items.length).toBeGreaterThan(5);
  });

  it("traces a task from its requirement to its audit entries, as JSON or Markdown", async () => {
    const task = (await app.inject({ method: 'GET', url: '/api/tasks', headers: H })).json()[0];
    const t = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/trace`, headers: H })).json();
    expect(t.task).toMatchObject({ key: 'TND-1', state: 'CANCELLED', title: 'Health endpoint' });
    expect(t.requirement.goal).toBe('Add GET /health');
    expect(t.audit.map((e: { action: string }) => e.action)).toEqual(['task.created', 'task.model', 'task.state']);
    expect(t.integrity.ok).toBe(true);
    const md = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/trace?format=md`, headers: H });
    expect(md.headers['content-disposition']).toBe('attachment; filename="TND-1-trace.md"');
    expect(md.body).toContain('# Traceability report: TND-1 Health endpoint');
    expect(md.body).toMatch(/Audit log: verified, \d+ entries/);
    expect((await app.inject({ method: 'GET', url: '/api/tasks/nope/trace', headers: H })).statusCode).toBe(404);
  });
});

describe('events', () => {
  it('replays buffered events after Last-Event-ID', () => {
    const b = new EventBus(3);
    for (let i = 0; i < 5; i++) b.emit({ type: 'chat.done', threadId: `t${i}`, messageId: 'm' });
    expect(b.since(0).map((e) => e.id)).toEqual([3, 4, 5]);
    expect(b.since(4).map((e) => e.id)).toEqual([5]);
    const seen: number[] = [];
    const off = b.subscribe((e) => seen.push(e.id));
    b.emit({ type: 'chat.done', threadId: 'x', messageId: 'm' });
    off();
    b.emit({ type: 'chat.done', threadId: 'y', messageId: 'm' });
    expect(seen).toEqual([6]);
    expect(b.size).toBe(0);
  });
});
