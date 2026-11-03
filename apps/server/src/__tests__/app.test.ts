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
  ({ app } = await buildApp({ tandem, bus, chat, doctor: {} }, { port: PORT, token: TOKEN, webDir: web, version: '9.9.9' }));
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

describe('web app', () => {
  it('serves the app with the token and a strict CSP, with history fallback', async () => {
    for (const url of ['/', '/tasks/abc', '/chat?thread=1']) {
      const r = await app.inject({ method: 'GET', url, headers: H });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain(`<meta name="tandem-token" content="${TOKEN}">`);
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
    expect((await app.inject({ method: 'GET', url: '/assets/app.js', headers: H })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js', headers: H })).statusCode).toBe(404);
  });

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
