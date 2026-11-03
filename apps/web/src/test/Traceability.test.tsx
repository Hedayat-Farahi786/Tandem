import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, detail, project, settings, task } from './fixtures';
import { mockApi, renderApp } from './helpers';
import type { Trace } from '../lib/types';

const now = new Date().toISOString();
const HEAD = 'a'.repeat(64);


describe('Audit log in Settings', () => {
  it('shows that the log verifies, the head hash and the exports', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/settings': settings, 'GET /api/secrets': { keychain: { ok: true }, jiraToken: false, githubToken: false }, 'GET /api/usage': { credits: { today: 0, perDay: 75 }, prompts: { today: 0, perDay: 40 }, last30Days: { prompts: 0, modelCalls: 0, aiCredits: 0 } }, 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } }, 'GET /api/audit/verify': { ok: true, count: 3, head: HEAD } });
    renderApp('/settings');
    const section = await screen.findByRole('region', { name: 'Audit log' });
    expect(await within(section).findByText('Verified')).toBeTruthy();
    expect(within(section).getByText('3 entries, all intact.')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'CSV' }).getAttribute('href')).toBe('/api/activity?format=csv');
    expect(within(section).getByText('aaaaaaaaaaaa…')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});

describe('Task activity', () => {
  const run = (over: Record<string, unknown>) => ({ id: 'r', taskId: 't1', kind: 'build', mode: 'build', status: 'succeeded', attempt: 0, startedAt: now, endedAt: now, prompts: 1, modelCalls: 3, aiCredits: 0.42, model: 'claude-sonnet-5.5', steps: [], ...over });
  const step = (n: number, over: Record<string, unknown>) => ({ id: `s${n}`, runId: 'r2', taskId: 't1', seq: n, at: now, ...over });

  it('tells what Copilot did, run by run, with the details folded away', async () => {
    const runs = [
      run({ id: 'r1', kind: 'spec', steps: [step(0, { runId: 'r1', kind: 'prompt', text: 'Write the implementation spec…' })] }),
      run({
        id: 'r2',
        steps: [
          step(0, { kind: 'prompt', text: 'Implement the approved spec in shop.' }),
          step(1, { kind: 'intent', text: 'Implementing the change in shop' }),
          step(2, { kind: 'reasoning', text: 'I will add the route first.\nThen the component.' }),
          step(3, { kind: 'tool', tool: 'bash', title: 'Run tests', input: 'npm test', ok: false, output: '1 failed', durationMs: 2100 }),
          step(4, { kind: 'tool', tool: 'edit', input: 'src/app.ts', ok: true, files: [{ kind: 'edit', path: 'src/app.ts' }] }),
          step(5, { kind: 'blocked', tool: 'bash', text: 'curl https://example.com', output: 'Network tools are not allowed.' }),
          step(6, { kind: 'message', text: 'Implemented shop: src/app.ts.' }),
        ],
      }),
    ];
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/t1': detail({}, { id: 't1', state: 'PR_OPEN' }), 'GET /api/tasks/t1/activity': runs, 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    const user = userEvent.setup();
    renderApp('/tasks/t1');
    await user.click(await screen.findByRole('tab', { name: 'Activity' }));
    const list = await screen.findByRole('list', { name: 'Copilot activity' });
    expect(within(list).getByText('Wrote the spec')).toBeTruthy();
    // The latest run is open, older ones are closed.
    const build = within(list).getByRole('button', { name: /Built the change/ });
    expect(build.getAttribute('aria-expanded')).toBe('true');
    expect(within(list).getByRole('button', { name: /Wrote the spec/ }).getAttribute('aria-expanded')).toBe('false');
    expect(within(build).getByText('2 actions · 1 file changed')).toBeTruthy();
    expect(within(list).getByText('Implementing the change in shop')).toBeTruthy();
    expect(within(list).getByText('Implemented shop: src/app.ts.')).toBeTruthy();
    expect(within(list).getByText(/Tandem blocked: curl/)).toBeTruthy();
    // Instructions, thinking and tool output open on demand.
    expect(within(list).queryByText('Implement the approved spec in shop.')).toBeNull();
    await user.click(within(list).getByRole('button', { name: /Tandem's instructions/ }));
    expect(within(list).getByText('Implement the approved spec in shop.')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /Thinking: I will add the route first\./ }));
    expect(within(list).getByText(/Then the component\./)).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /Run tests/ }));
    expect(within(list).getByText('1 failed')).toBeTruthy();
    expect(within(list).getByRole('button', { name: /Edited src\/app\.ts/ })).toBeTruthy();
  });

  it('explains when Copilot has not started yet', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/t1': detail({}, { id: 't1', state: 'DRAFT' }), 'GET /api/tasks/t1/activity': [], 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    const user = userEvent.setup();
    renderApp('/tasks/t1');
    await user.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText("Copilot hasn't started yet")).toBeTruthy();
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
    // Clicking outside closes it; the shortcut opens it again.
    const dialog = await screen.findByRole('dialog', { name: 'Search Tandem' });
    fireEvent.mouseDown(dialog.previousElementSibling!);
    expect(screen.queryByRole('dialog', { name: 'Search Tandem' })).toBeNull();
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

describe('Project avatars', () => {
  it("show the site's own icon when the repository has one, else the initials", async () => {
    const other = { ...project, id: 'p2', name: 'Partner portal' };
    mockApi({ 'GET /api/bootstrap': boot({ projects: [project, other] }), 'GET /api/tasks': [], 'GET /api/rules': [], 'GET /api/projects/p1/threads': [], 'GET /api/project-icons': { p1: { v: 'abc123def456' }, p2: null } });
    renderApp('/projects');
    const shop = await screen.findByRole('region', { name: 'Shop' });
    await waitFor(() => expect(shop.querySelector('img')?.getAttribute('src')).toBe('/api/projects/p1/icon?v=abc123def456'));
    const partner = screen.getByRole('region', { name: 'Partner portal' });
    expect(partner.querySelector('img')).toBeNull();
    expect(within(partner).getByText('PP')).toBeTruthy();
  });
});
