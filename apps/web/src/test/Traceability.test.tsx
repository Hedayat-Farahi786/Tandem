import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, detail, project, settings, task } from './fixtures';
import { mockApi, renderApp, wideScreen } from './helpers';
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
  // On a wide screen the task's sections open beside the conversation.
  beforeEach(() => wideScreen());
  const run = (over: Record<string, unknown>) => ({ id: 'r', taskId: 't1', kind: 'build', mode: 'build', status: 'succeeded', attempt: 0, startedAt: now, endedAt: now, prompts: 1, modelCalls: 3, aiCredits: 0.42, model: 'claude-sonnet-5.5', steps: [], ...over });
  const step = (n: number, over: Record<string, unknown>) => ({ id: `s${n}`, runId: 'r2', taskId: 't1', seq: n, at: now, ...over });
  const conversation = { 'GET /api/tasks/t1/thread': { id: 'th1' }, 'GET /api/threads/th1': { thread: { id: 'th1', projectId: 'p1', mode: 'task', taskId: 't1', title: 'chat', createdAt: '', updatedAt: '' }, model: '', messages: [], readiness: null } };

  it('tells what Copilot did, run by run, in the conversation, with the details folded away', async () => {
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
    mockApi({ ...conversation, 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/t1': detail({}, { id: 't1', state: 'PR_OPEN' }), 'GET /api/tasks/t1/activity': runs, 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    const user = userEvent.setup();
    renderApp('/tasks/t1');
    const convo = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(convo).findByText('Wrote the spec')).toBeTruthy();
    // Finished runs show as one line each; open one to see what it did.
    const build = within(convo).getByRole('button', { name: /Built the change/ });
    expect(build.getAttribute('aria-expanded')).toBe('false');
    expect(within(build).getByText('2 actions · 1 file changed')).toBeTruthy();
    await user.click(build);
    expect(within(convo).getByText('Implemented shop: src/app.ts.')).toBeTruthy();
    expect(within(convo).getByText(/Tandem blocked: curl/)).toBeTruthy();
    // Tandem's instructions to Copilot never show in the conversation; thinking and tool output open on demand.
    expect(within(convo).queryByText('Implement the approved spec in shop.')).toBeNull();
    expect(within(convo).queryByRole('button', { name: /Tandem's instructions/ })).toBeNull();
    await user.click(within(convo).getByRole('button', { name: /I will add the route first\./ }));
    expect(within(convo).getByText(/Then the component\./)).toBeTruthy();
    await user.click(within(convo).getByRole('button', { name: /Ran npm test/ }));
    expect(within(convo).getByText('1 failed')).toBeTruthy();
    expect(within(convo).getByText('Edited app.ts')).toBeTruthy();
  });

  it('a task saved for later says it has not started, and starts from the conversation', async () => {
    mockApi({ ...conversation, 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/t1': detail({}, { id: 't1', state: 'DRAFT' }), 'GET /api/tasks/t1/activity': [], 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    renderApp('/tasks/t1');
    const convo = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(convo).findByText('Saved, not started yet')).toBeTruthy();
    expect(within(convo).getByRole('button', { name: 'Start task' })).toBeTruthy();
  });
});

describe('Task trace', () => {
  // On a wide screen the task's sections open beside the conversation.
  beforeEach(() => wideScreen());
  const trace: Trace = {
    generatedAt: now,
    task: { id: 't1', key: 'TND-1', title: 'Health endpoint', state: 'PR_OPEN', source: 'chat', branch: 'feature/TND-1-health', createdAt: now, updatedAt: now, project: 'Shop' },
    requirement: { goal: 'Add GET /health.', userStory: '', exampleData: '', affectedAreas: '', outOfScope: 'Auth' },
    criteria: [
      { n: 1, given: 'the API runs', when: 'GET /health', then: 'it returns 200', status: 'pass', tests: [{ repo: 'shop', file: 'test/health.test.ts', name: 'returns ok', result: 'pass', scope: 'single' }] },
      { n: 2, given: 'the page loads', when: 'the call fails', then: 'it says so', status: 'no-test', tests: [] },
    ],
    specs: [{ version: 1, source: 'draft', createdAt: now, sha256: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12', status: 'approved', approvals: [{ role: 'owner', name: 'Sam', date: now, method: 'tandem', evidence: 'Approved in Tandem' }, { role: 'pm', name: 'Pat Lee', date: now, method: 'jira', evidence: 'Jira comment 7' }] }],
    agent: [{ kind: 'build', runs: 1, succeeded: 1, failed: 0, models: ['gpt-5.4'], prompts: 2, modelCalls: 9, aiCredits: 0.42 }],
    checks: [{ attempt: 0, passed: true, at: now, results: [{ repo: 'shop', kind: 'test', command: 'npm test', exitCode: 0, durationMs: 2100, timedOut: false }] }],
    findings: [],
    commits: [{ repo: 'shop', branch: 'feature/TND-1-health', commit: '1a2b3c4d5e6f', at: now }],
    pullRequests: [{ repo: 'shop', url: 'https://example.com/pr/1', status: 'open', manual: false }],
    usage: { prompts: 2, modelCalls: 9, aiCredits: 0.42 },
    audit: [{ seq: 4, at: now, actor: 'system', action: 'pr.opened', summary: 'TND-1: opened a pull request in shop.', hash: HEAD }],
    integrity: { ok: true, entries: 4, head: HEAD },
    request: { by: 'Sam', at: now, text: 'Add a GET /health endpoint and show the status.', ready: true, missing: [], size: { lines: 40, rationale: 'One endpoint and one status line.' } },
    runs: [
      { id: 'r1', kind: 'build', mode: 'build', model: 'gpt-5.4', status: 'succeeded', startedAt: now, endedAt: now, durationMs: 78_000, prompts: 2, modelCalls: 9, aiCredits: 0.42, actions: 12, filesChanged: ['src/health.ts', 'test/health.test.ts'], blocked: [{ tool: 'bash', what: 'curl https://example.com', reason: 'Network tools are not allowed.' }], instructionsSha: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', withGuidance: true },
    ],
    changes: [{ repo: 'shop', commit: '1a2b3c4d5e6f', message: 'feat(TND-1): Health endpoint', files: ['src/health.ts', 'test/health.test.ts'], at: now }],
    decisions: [{ at: now, who: 'Sam', action: 'checks.skipped', summary: 'TND-1: skipped test in shop. No Chrome here.' }],
    exceptions: [{ at: now, kind: 'blocked-action', text: 'Guardrail refused bash curl https://example.com: Network tools are not allowed.' }],
    lifecycle: [{ at: now, from: 'SPEC_REVIEW', to: 'BUILDING', actor: 'owner', reason: 'Spec version 1 approved by Sam.' }],
  };

  it('links each criterion to its tests, the spec to its approvals, and offers the report', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/t1': detail({}, { id: 't1', state: 'PR_OPEN' }), 'GET /api/tasks/t1/trace': trace, 'GET /api/copilot/models': { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } } });
    const user = userEvent.setup();
    renderApp('/tasks/t1');
    await user.click(await screen.findByRole('tab', { name: 'Trace' }));
    const chain = await screen.findByRole('list', { name: 'Trace' });
    expect(within(chain).getByText('1 of 2 proven by a passing test')).toBeTruthy();
    expect(within(chain).getByText('returns ok')).toBeTruthy();
    expect(within(chain).getByTitle('shop: test/health.test.ts')).toBeTruthy();
    expect(within(chain).getByText('No test yet')).toBeTruthy();
    expect(within(chain).getByText('Version 1 approved')).toBeTruthy();
    expect(within(chain).getByText('Pat Lee')).toBeTruthy();
    expect(within(chain).getByText('1 run · 2 prompts · 9 model calls · 0.42 AI credits')).toBeTruthy();
    // Who asked, and whether it was ready.
    expect(within(chain).getByText('Add a GET /health endpoint and show the status.')).toBeTruthy();
    expect(within(chain).getByText('Definition of Ready met')).toBeTruthy();
    // Each run: its role, what it can do, model, what it changed and what was refused, and a fingerprint.
    expect(within(chain).getByText('Built the change')).toBeTruthy();
    expect(within(chain).getByText('writes code')).toBeTruthy();
    expect(within(chain).getByText('2 files changed')).toBeTruthy();
    expect(within(chain).getByText('1 refused')).toBeTruthy();
    expect(within(chain).getByText('with your guidance')).toBeTruthy();
    expect(within(chain).getByTitle(/SHA-256 of Tandem's instructions/).textContent).toContain('9f86d081884c');
    // The spec is tied to its exact text.
    expect(within(chain).getByTitle(/SHA-256 of this version's text/).textContent).toContain('ab12cd34ef56');
    // Commits, decisions, exceptions, lifecycle.
    expect(within(chain).getByText('feat(TND-1): Health endpoint')).toBeTruthy();
    expect(within(chain).getByText(/skipped test in shop/)).toBeTruthy();
    expect(within(chain).getByText('Refused by a guardrail')).toBeTruthy();
    expect(within(chain).getByText('Spec review → Building')).toBeTruthy();
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
    const shop = await screen.findByRole('article', { name: 'Shop' });
    await waitFor(() => expect(shop.querySelector('img')?.getAttribute('src')).toBe('/api/projects/p1/icon?v=abc123def456'));
    const partner = screen.getByRole('article', { name: 'Partner portal' });
    expect(partner.querySelector('img')).toBeNull();
    expect(within(partner).getByText('PP')).toBeTruthy();
  });
});
