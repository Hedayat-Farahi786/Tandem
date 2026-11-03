import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Requirement, type Task } from '@tandem/shared';
import type { Store } from '@tandem/core';
import { MemoryStore } from '@tandem/core/testing';
import { SqliteStore } from './sqlite-store.js';

const task = (id: string, key: string, state: Task['state'] = 'DRAFT'): Task => ({
  id,
  key,
  projectId: 'p1',
  title: 'T',
  source: 'form',
  requirement: Requirement.parse({}),
  description: '',
  affectedRepoIds: ['r1'],
  state,
  needsAttention: false,
  attentionNotes: [],
  progress: {},
  slug: 't',
  branch: `agent/${key}-t`,
  createdAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
});

function contract(name: string, make: () => Promise<Store>) {
  describe(`Store contract: ${name}`, () => {
    it('stores tasks and finds them by key, state and sequence', async () => {
      const s = await make();
      await s.tasks.upsert(task('t1', 'TND-1'));
      await s.tasks.upsert(task('t2', 'TND-7', 'BUILDING'));
      await s.tasks.upsert(task('t3', 'SHOP-3', 'BUILDING'));
      expect((await s.tasks.get('t1'))?.key).toBe('TND-1');
      expect((await s.tasks.getByKey('TND-7'))?.id).toBe('t2');
      expect(await s.tasks.getByKey('nope')).toBeUndefined();
      expect((await s.tasks.listByState(['BUILDING'])).map((t) => t.id)).toEqual(['t2', 't3']);
      expect(await s.tasks.listByState([])).toEqual([]);
      expect(await s.tasks.nextSeq('TND')).toBe(8);
      expect(await s.tasks.nextSeq('NEW')).toBe(1);
      await s.tasks.upsert({ ...task('t1', 'TND-1'), title: 'Changed' });
      expect((await s.tasks.get('t1'))?.title).toBe('Changed');
      expect(await s.tasks.list()).toHaveLength(3);
      await s.tasks.delete('t3');
      expect(await s.tasks.get('t3')).toBeUndefined();
    });

    it('keeps an ordered transition history with ids', async () => {
      const s = await make();
      const a = await s.transitions.add({ taskId: 't1', from: 'DRAFT', to: 'READINESS', reason: 'go', actor: 'owner', at: '1' });
      const b = await s.transitions.add({ taskId: 't1', from: 'READINESS', to: 'SPEC_DRAFTING', step: 'draft', reason: 'ok', actor: 'system', at: '2' });
      await s.transitions.add({ taskId: 't2', from: 'DRAFT', to: 'CANCELLED', reason: 'x', actor: 'owner', at: '3' });
      expect(b.id).toBeGreaterThan(a.id);
      expect((await s.transitions.list('t1')).map((t) => [t.to, t.step])).toEqual([
        ['READINESS', undefined],
        ['SPEC_DRAFTING', 'draft'],
      ]);
    });

    it('versions specs and refuses a duplicate version', async () => {
      const s = await make();
      await s.specs.add({ taskId: 't1', version: 1, markdown: 'v1', source: 'draft', createdAt: '1' });
      await s.specs.add({ taskId: 't1', version: 2, markdown: 'v2', source: 'edit', createdAt: '2' });
      expect((await s.specs.latest('t1'))?.markdown).toBe('v2');
      expect((await s.specs.list('t1')).map((v) => v.version)).toEqual([1, 2]);
      expect(await s.specs.latest('none')).toBeUndefined();
      await expect(s.specs.add({ taskId: 't1', version: 2, markdown: 'dup', source: 'edit', createdAt: '3' })).rejects.toThrow();
    });

    it('scopes approvals, verify runs, findings, PRs and tests to a task', async () => {
      const s = await make();
      await s.approvals.upsert({ id: 'a1', taskId: 't1', specVersion: 1, role: 'owner', name: 'O', date: 'd', evidence: '', method: 'tandem', createdAt: 'c' });
      await s.approvals.upsert({ id: 'a2', taskId: 't2', specVersion: 1, role: 'pm', name: 'P', date: 'd', evidence: 'e', method: 'tandem', createdAt: 'c' });
      expect((await s.approvals.list('t1')).map((a) => a.id)).toEqual(['a1']);
      expect((await s.approvals.get('a2'))?.role).toBe('pm');
      await s.verifyRuns.upsert({ id: 'v1', taskId: 't1', attempt: 0, passed: false, results: [], createdAt: '1' });
      expect(await s.verifyRuns.list('t1')).toHaveLength(1);
      await s.findings.replace('t1', [
        { id: 'f1', taskId: 't1', severity: 'high', category: 'security', title: 'a', detail: 'b', status: 'open' },
        { id: 'f2', taskId: 't1', severity: 'low', category: 'rules', title: 'c', detail: 'd', status: 'open' },
      ]);
      await s.findings.upsert({ ...(await s.findings.get('f1'))!, status: 'fixed' });
      await s.findings.replace('t2', [{ id: 'f3', taskId: 't2', severity: 'low', category: 'other', title: 'e', detail: 'f', status: 'open' }]);
      expect((await s.findings.list('t1')).map((f) => [f.id, f.status])).toEqual([
        ['f1', 'fixed'],
        ['f2', 'open'],
      ]);
      await s.findings.replace('t1', []);
      expect(await s.findings.list('t1')).toEqual([]);
      expect(await s.findings.list('t2')).toHaveLength(1);
      await s.prs.upsert({ id: 'p1', taskId: 't1', repoId: 'r1', url: 'u', title: 't', description: 'd', status: 'open', manual: false, createdAt: 'c' });
      await s.prs.upsert({ id: 'p2', taskId: 't1', repoId: 'r2', url: 'u', title: 't', description: 'd', status: 'merged', manual: false, createdAt: 'c' });
      expect((await s.prs.listByStatus(['open', 'manual-pending'])).map((p) => p.id)).toEqual(['p1']);
      expect(await s.prs.listByStatus([])).toEqual([]);
      await s.criterionTests.replace('t1', [{ taskId: 't1', criterion: 1, repoId: 'r1', file: 'f', name: 'n', result: 'pass', scope: 'suite' }]);
      expect(await s.criterionTests.list('t1')).toHaveLength(1);
      expect(await s.criterionTests.list('t9')).toEqual([]);
    });

    it('stores runs, chat, rules, usage, jobs, settings and tracker comments', async () => {
      const s = await make();
      await s.runs.upsert({ id: 'run1', taskId: 't1', kind: 'build', mode: 'build', status: 'running', attempt: 0, startedAt: '1' });
      await s.runs.upsert({ id: 'run2', threadId: 'th1', kind: 'ask', mode: 'read-only', status: 'succeeded', attempt: 0, startedAt: '2' });
      expect((await s.runs.listFor({ taskId: 't1' })).map((r) => r.id)).toEqual(['run1']);
      expect((await s.runs.listFor({ threadId: 'th1' })).map((r) => r.id)).toEqual(['run2']);
      expect(await s.runs.listFor({})).toHaveLength(2);

      await s.threads.upsert({ id: 'th1', projectId: 'p1', mode: 'ask', title: 'Q', createdAt: '1', updatedAt: '1' });
      await s.threads.upsert({ id: 'th2', projectId: 'p1', taskId: 't1', mode: 'task', title: 'T', createdAt: '1', updatedAt: '1' });
      expect((await s.threads.listFor({ projectId: 'p1' })).map((t) => t.id)).toEqual(['th1', 'th2']);
      expect((await s.threads.listFor({ taskId: 't1' })).map((t) => t.id)).toEqual(['th2']);
      await s.messages.add({ id: 'm1', threadId: 'th1', role: 'user', content: 'hi', refs: [], createdAt: '1' });
      await s.messages.add({ id: 'm2', threadId: 'th1', role: 'assistant', content: 'hello', refs: [{ path: 'a.ts', line: 3 }], createdAt: '1' });
      expect((await s.messages.list('th1')).map((m) => m.id)).toEqual(['m1', 'm2']);

      await s.rules.upsert({ id: 'ru1', repoId: 'r1', text: 'x', source: 's', status: 'pending', createdAt: '1' });
      await s.rules.upsert({ id: 'ru2', repoId: 'r1', text: 'y', source: 's', status: 'committed', createdAt: '1' });
      expect((await s.rules.listPending('r1')).map((r) => r.id)).toEqual(['ru1']);

      const u = (id: string, taskId: string | undefined, at: string, prompts = 1) => ({ id, ...(taskId ? { taskId } : {}), runKind: 'build' as const, model: 'm', prompts, modelCalls: 2, nanoAiu: 5, at });
      await s.usage.add(u('u1', 't1', '2026-11-01T00:00:00Z'));
      await s.usage.add(u('u2', 't1', '2026-11-03T00:00:00Z', 2));
      await s.usage.add(u('u3', undefined, '2026-11-03T05:00:00Z'));
      expect(await s.usage.prompts({})).toBe(4);
      expect(await s.usage.prompts({ taskId: 't1' })).toBe(3);
      expect(await s.usage.prompts({ since: '2026-11-02T00:00:00Z' })).toBe(3);
      expect(await s.usage.prompts({ taskId: 't1', since: '2026-11-02T00:00:00Z' })).toBe(2);
      expect((await s.usage.list({ taskId: 't1' })).map((x) => x.id)).toEqual(['u1', 'u2']);

      await s.jobs.upsert({ taskId: 't1', state: 'BUILDING', step: 'implement', status: 'queued', attempt: 0, notBefore: 1 });
      await s.jobs.upsert({ taskId: 't1', state: 'BUILDING', step: 'implement', status: 'running', attempt: 1, notBefore: 2, leaseBootId: 'b' });
      expect(await s.jobs.get('t1')).toMatchObject({ status: 'running', attempt: 1, leaseBootId: 'b' });
      expect(await s.jobs.list()).toHaveLength(1);
      await s.jobs.delete('t1');
      expect(await s.jobs.get('t1')).toBeUndefined();

      expect(await s.settings.get()).toEqual(DEFAULT_SETTINGS);
      await s.settings.set({ ...DEFAULT_SETTINGS, ownerName: 'Hedayat' });
      expect((await s.settings.get()).ownerName).toBe('Hedayat');

      await s.trackerComments.add({ id: 'c1', key: 'TND-1', authorId: 'a', authorName: 'A', body: 'one', createdAt: '2' });
      await s.trackerComments.add({ id: 'c0', key: 'TND-1', authorId: 'a', authorName: 'A', body: 'zero', createdAt: '1' });
      expect((await s.trackerComments.list('TND-1')).map((c) => c.id)).toEqual(['c0', 'c1']);

      await s.projects.upsert({ id: 'p1', name: 'P', repoIds: ['r1'], contractOrder: ['r1'], specRepoId: 'r1', pmGate: 'tandem', pmNames: [], jiraPmAccountIds: [], keyPrefix: 'TND', createdAt: '1' });
      expect((await s.projects.list()).map((p) => p.id)).toEqual(['p1']);
    });

    it('rolls back a failed transaction and makes others wait for it', async () => {
      const s = await make();
      await expect(
        s.transaction(async (tx) => {
          await tx.tasks.upsert(task('t1', 'TND-1'));
          await tx.transitions.add({ taskId: 't1', from: 'DRAFT', to: 'READINESS', reason: 'r', actor: 'owner', at: '1' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await s.tasks.get('t1')).toBeUndefined();
      expect(await s.transitions.list('t1')).toEqual([]);

      let inside = false;
      const order: string[] = [];
      const tx = s.transaction(async (t) => {
        inside = true;
        await t.tasks.upsert(task('t2', 'TND-2'));
        await new Promise((r) => setTimeout(r, 20));
        order.push('tx done');
        inside = false;
        return 'ok';
      });
      await new Promise((r) => setTimeout(r, 1));
      const outside = s.tasks.list().then((l) => {
        order.push(`read saw ${l.length}${inside ? ' (during tx!)' : ''}`);
      });
      expect(await tx).toBe('ok');
      await outside;
      expect(order).toEqual(['tx done', 'read saw 1']);
      expect(await s.transaction(async (t) => t.transaction(async (t2) => (await t2.tasks.list()).length))).toBe(1);
    });
  });
}

contract('memory', async () => new MemoryStore());
contract('sqlite (in memory)', () => SqliteStore.open(':memory:'));

describe('SqliteStore', () => {
  it('persists across reopen and records the schema version', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tandem-db-')), 'tandem.db');
    const a = await SqliteStore.open(path);
    await a.tasks.upsert(task('t1', 'TND-1', 'BUILDING'));
    await a.jobs.upsert({ taskId: 't1', state: 'BUILDING', step: 'implement', status: 'running', attempt: 0, notBefore: 0, leaseBootId: 'old' });
    expect(a.schemaVersion()).toBe(1);
    a.close();
    const b = await SqliteStore.open(path);
    expect((await b.tasks.get('t1'))?.state).toBe('BUILDING');
    expect((await b.jobs.get('t1'))?.leaseBootId).toBe('old');
    expect((b.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    b.close();
  });

  it('redacts secrets before they reach the database', async () => {
    const s = await SqliteStore.open(':memory:');
    await s.messages.add({ id: 'm1', threadId: 'th', role: 'assistant', content: 'key AKIAABCDEFGHIJKLMNOP and password=hunter22', refs: [], createdAt: '1' });
    const raw = (s.db.prepare('SELECT doc FROM messages').get() as { doc: string }).doc;
    expect(raw).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(raw).not.toContain('hunter22');
    expect((await s.messages.list('th'))[0]!.content).toContain('[REDACTED_AWS_KEY_ID]');
    s.close();
  });
});
