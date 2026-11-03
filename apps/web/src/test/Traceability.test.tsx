import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, detail, project, task } from './fixtures';
import { mockApi, renderApp } from './helpers';
import type { ActivityItem, Trace } from '../lib/types';

const now = new Date().toISOString();
const HEAD = 'a'.repeat(64);

const items: ActivityItem[] = [
  { id: 'a3', at: now, kind: 'approval', action: 'spec.approved', actor: 'pm', actorName: 'Pat Lee', summary: 'TND-1: PM approval of spec version 2 by Pat Lee, recorded in Tandem.', taskId: 't1', taskKey: 'TND-1', detail: { specVersion: 2, evidence: 'Approved in #shop' }, seq: 3, hash: HEAD },
  { id: 'a2', at: now, kind: 'git', action: 'git.pushed', actor: 'system', summary: 'TND-1: pushed agent/TND-1-health to shop at 1a2b3c4.', taskId: 't1', taskKey: 'TND-1', detail: { commit: '1a2b3c4d'.repeat(5) }, seq: 2, hash: 'b'.repeat(64) },
  { id: 'a1', at: now, kind: 'config', action: 'settings.updated', actor: 'owner', actorName: 'Sam', summary: 'Changed limits.creditsPerDay.', detail: { changes: [{ field: 'limits.creditsPerDay', from: 75, to: 50 }] }, seq: 1, hash: 'c'.repeat(64) },
];

describe('Activity', () => {
  it('shows the verified audit log, filters by kind and links tasks', async () => {
    const { calls } = mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/activity': (_b, url) => ({ items: url.searchParams.get('kinds') === 'config' ? items.slice(2) : items, more: false }), 'GET /api/audit/verify': { ok: true, count: 3, head: HEAD } });
    const user = userEvent.setup();
    renderApp('/activity');
    expect(await screen.findByText('Audit log verified')).toBeTruthy();
    expect(screen.getByText(/3 entries, each sealed with the hash of the one before/)).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText(/PM approval of spec version 2 by Pat Lee/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'TND-1' })[0]!.getAttribute('href')).toBe('/tasks/t1');
    // Details open on demand, with the audit hash.
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[0]!);
    expect(screen.getByText('Approved in #shop')).toBeTruthy();
    expect(screen.getByText(HEAD)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Changed limits.creditsPerDay.')).toBeTruthy();
    expect(screen.queryByText(/PM approval of spec version 2/)).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/api/activity') && c.path.includes('kinds=config'))).toBe(true);
    expect(screen.getByRole('link', { name: /Export CSV/ }).getAttribute('href')).toMatch(/^\/api\/activity\?.*kinds=config.*&format=csv$/);
  });

  it('says plainly when the audit log fails verification', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/activity': { items, more: false }, 'GET /api/audit/verify': { ok: false, count: 3, brokenAt: 2, reason: 'Entry 2 was changed after it was written.', head: HEAD } });
    renderApp('/activity');
    expect(await screen.findByText('Audit log failed verification')).toBeTruthy();
    expect(screen.getByText('Entry 2 was changed after it was written.')).toBeTruthy();
  });
});

describe('Task trace', () => {
  const trace: Trace = {
    generatedAt: now,
    task: { id: 't1', key: 'TND-1', title: 'Health endpoint', state: 'PR_OPEN', source: 'chat', branch: 'agent/TND-1-health', createdAt: now, updatedAt: now, project: 'Shop' },
    requirement: { goal: 'Add GET /health.', userStory: '', exampleData: '', affectedAreas: '', outOfScope: 'Auth' },
    criteria: [
      { n: 1, given: 'the API runs', when: 'GET /health', then: 'it returns 200', status: 'pass', tests: [{ repo: 'shop', file: 'test/health.test.ts', name: 'returns ok', result: 'pass', scope: 'single' }] },
      { n: 2, given: 'the page loads', when: 'the call fails', then: 'it says so', status: 'no-test', tests: [] },
    ],
    specs: [{ version: 1, source: 'draft', createdAt: now, status: 'approved', approvals: [{ role: 'owner', name: 'Sam', date: now, method: 'tandem', evidence: 'Approved in Tandem' }, { role: 'pm', name: 'Pat Lee', date: now, method: 'jira', evidence: 'Jira comment 7' }] }],
    agent: [{ kind: 'build', runs: 1, succeeded: 1, failed: 0, models: ['gpt-5.4'], prompts: 2, modelCalls: 9, aiCredits: 0.42 }],
    checks: [{ attempt: 0, passed: true, at: now, results: [{ repo: 'shop', kind: 'test', command: 'npm test', exitCode: 0, durationMs: 2100, timedOut: false }] }],
    findings: [],
    commits: [{ repo: 'shop', branch: 'agent/TND-1-health', commit: '1a2b3c4d5e6f', at: now }],
    pullRequests: [{ repo: 'shop', url: 'https://example.com/pr/1', status: 'open', manual: false }],
    usage: { prompts: 2, modelCalls: 9, aiCredits: 0.42 },
    audit: [{ seq: 4, at: now, actor: 'system', action: 'pr.opened', summary: 'TND-1: opened a pull request in shop.', hash: HEAD }],
    integrity: { ok: true, entries: 4, head: HEAD },
  };

  it('links each criterion to its tests, the spec to its approvals, and offers the report', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/t1': detail({}, { id: 't1', state: 'PR_OPEN' }), 'GET /api/tasks/t1/trace': trace, 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    const user = userEvent.setup();
    renderApp('/tasks/t1');
    await user.click(await screen.findByRole('tab', { name: 'Trace' }));
    const chain = await screen.findByRole('list', { name: 'Trace' });
    expect(within(chain).getByText('1 of 2 proven by a passing test')).toBeTruthy();
    expect(within(chain).getByText('shop: test/health.test.ts › returns ok')).toBeTruthy();
    expect(within(chain).getByText('No test yet')).toBeTruthy();
    expect(within(chain).getByText('Version 1 approved')).toBeTruthy();
    expect(within(chain).getByText('Pat Lee')).toBeTruthy();
    expect(within(chain).getByText('2 prompts · 9 model calls · 0.42 AI credits')).toBeTruthy();
    expect(within(chain).getByText('1a2b3c4d5e')).toBeTruthy();
    expect(within(chain).getByText('TND-1: opened a pull request in shop.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download report/ }).getAttribute('href')).toBe('/api/tasks/t1/trace?format=md');
  });
});

describe('Search and project switcher', () => {
  it('opens with Ctrl+K and jumps to a task by key', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [{ ...task({ id: 't9', key: 'TND-9', title: 'Invoices as PDF', state: 'BUILDING', step: 'implement' }), prCount: 0 }], 'GET /api/tasks/t9': detail({}, { id: 't9', key: 'TND-9', title: 'Invoices as PDF' }), 'GET /api/projects/p1/threads': [], 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    const user = userEvent.setup();
    renderApp('/tasks');
    await screen.findByRole('heading', { name: 'Tasks' });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const box = await screen.findByRole('combobox', { name: 'Search pages, tasks and projects' });
    await user.type(box, 'tnd-9');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Invoices as PDF')]);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Search Tandem' })).toBeNull();
    expect(window.location.pathname).toBe('/tasks/t9');
  });

  it('switches the project the sidebar chats belong to', async () => {
    const other = { ...project, id: 'p2', name: 'Billing' };
    mockApi({ 'GET /api/bootstrap': boot({ projects: [project, other] }), 'GET /api/tasks': [], 'GET /api/projects/p1/threads': [], 'GET /api/projects/p2/threads': [] });
    const user = userEvent.setup();
    renderApp('/tasks');
    const switcher = await screen.findByRole('button', { name: /Switch project$/ });
    expect(switcher.textContent).toContain('Shop');
    await user.click(switcher);
    const menu = screen.getByRole('menu', { name: 'Switch project' });
    expect(within(menu).getByRole('menuitemradio', { name: /Shop/ }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(menu).getByRole('menuitemradio', { name: /Billing/ }));
    expect(window.location.search).toBe('?project=p2');
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch project$/ }).textContent).toContain('Billing'));
  });
});
