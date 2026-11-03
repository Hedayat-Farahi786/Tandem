import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SPEC_MD, boot, catalog, detail } from './fixtures';
import { mockApi, renderApp } from './helpers';
import type { TaskDetail } from '../lib/types';

function setup(d: TaskDetail, extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET /api/bootstrap': boot(),
    'GET /api/tasks/task1': () => d,
    'GET /api/tasks/task1/spec/1': SPEC_MD,
    'GET /api/tasks/task1/thread': { id: 'th1' },
    'GET /api/threads/th1': { thread: { id: 'th1', projectId: 'p1', mode: 'task', taskId: 'task1', title: 'TND-1 chat', createdAt: '', updatedAt: '' }, model: '', messages: [], readiness: null },
    'GET /api/tasks/task1/diff': [],
    'POST /api/*': { ok: true },
    'PUT /api/*': { ok: true },
    'PATCH /api/*': { ok: true },
    ...extra,
  });
  renderApp('/tasks/task1');
  return { api, user: userEvent.setup() };
}
const posted = (api: ReturnType<typeof mockApi>, path: string) => api.calls.filter((c) => c.method !== 'GET' && c.path === path);

describe('Task detail', () => {
  it('shows credits against the task limit and changes the task model', async () => {
    const { api, user } = setup(detail(), { 'GET /api/copilot/models': catalog });
    await user.click(await screen.findByRole('tab', { name: /Overview/ }));
    expect(screen.getByRole('meter', { name: 'AI credits used by this task' }).getAttribute('aria-valuenow')).toBe('0.5');
    expect(screen.getByText('of 25')).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Model: Auto' }));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /GPT-6 Luna/ }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/model')[0]?.body).toEqual({ model: 'gpt-6-luna' }));
  });

  it('a task stopped at its credit limit links to Settings and resumes', async () => {
    const { api, user } = setup(detail({}, { state: 'BLOCKED', blockedReason: 'budget-reached', blockedMessage: 'Stopped: this task reached its Copilot credit limit (25.3 of 25). Raise the limit in Settings, then resume.', resumeTo: { state: 'BUILDING' } }));
    expect(await screen.findByText('Copilot limit reached')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings');
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/resume')).toHaveLength(1));
  });

  it('opens a task in review on its spec, and records both approvals', async () => {
    const { api, user } = setup(detail());
    expect(await screen.findByRole('heading', { name: 'Health endpoint', level: 1 })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Problem and goal' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Spec/ }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Approve spec' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/approve')).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Record PM approval' }));
    const dialog = screen.getByRole('dialog', { name: 'Record PM approval' });
    const record = within(dialog).getByRole('button', { name: 'Record approval' }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Evidence'), 'Approved in planning');
    expect(record.disabled).toBe(false);
    await user.click(record);
    await waitFor(() => expect(posted(api, '/api/tasks/task1/pm-approval')).toHaveLength(1));
    expect(posted(api, '/api/tasks/task1/pm-approval')[0]!.body).toMatchObject({ name: 'Pat Lee', evidence: 'Approved in planning' });
  });

  it('blocks approval while the spec has open questions', async () => {
    setup(detail({ specCheck: { valid: false, problems: [], openQuestions: ['Which port?'] } }));
    expect(await screen.findByText('Open questions must be answered before approval')).toBeTruthy();
    expect(screen.getByText(/Which port\?/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve spec' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for changes with feedback', async () => {
    const { api, user } = setup(detail());
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    const dialog = screen.getByRole('dialog', { name: 'Request changes' });
    await user.type(within(dialog).getByLabelText('What should change?'), 'Also return the version');
    await user.click(within(dialog).getByRole('button', { name: 'Redraft spec' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/request-changes')[0]?.body).toEqual({ feedback: 'Also return the version' }));
  });

  it('a task that is not ready: edit the requirement and check again', async () => {
    const { api, user } = setup(detail({ spec: null, specs: [], specCheck: null, approvalState: null }, { state: 'BLOCKED', blockedReason: 'readiness-missing', blockedMessage: 'Missing: example data.', resumeTo: { state: 'READINESS' } }));
    expect(await screen.findByText('Not ready yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit the requirement' });
    const example = within(dialog).getByLabelText('Example data');
    await user.clear(example);
    await user.type(example, 'GET /health → 200 ok');
    await user.click(within(dialog).getByRole('button', { name: 'Save and check readiness' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/resume')).toHaveLength(1));
    const saved = posted(api, '/api/tasks/task1')[0]!.body as { requirement: { exampleData: string; criteria: unknown[] } };
    expect(saved.requirement.exampleData).toBe('GET /health → 200 ok');
    expect(saved.requirement.criteria).toHaveLength(2);
  });

  it('a split proposal: accept it, or keep one task with a reason', async () => {
    const { api, user } = setup(detail({ spec: null, specs: [], specCheck: null }, { state: 'BLOCKED', blockedReason: 'split-proposed', blockedMessage: 'About 900 lines. Proposed split: API, then UI.' }));
    expect(await screen.findByText('This is too big for one reviewable change')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep as one task' }));
    const dialog = screen.getByRole('dialog', { name: 'Keep as one task' });
    expect((within(dialog).getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Why should this stay one change?'), 'Must ship together');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/override-split')[0]?.body).toEqual({ reason: 'Must ship together' }));
    await user.click(screen.getByRole('button', { name: 'Accept the split' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/accept-split')).toHaveLength(1));
  });

  it('a failed task can be retried, and any task cancelled after confirming', async () => {
    const { api, user } = setup(detail({}, { state: 'FAILED', blockedMessage: 'The build timed out.' }));
    expect(await screen.findByText('Something failed')).toBeTruthy();
    expect(screen.getByText('The build timed out.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/resume')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Cancel task' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel TND-1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep working' }));
    expect(posted(api, '/api/tasks/task1/cancel')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Cancel task' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Cancel TND-1?' })).getByRole('button', { name: 'Cancel task' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/cancel')).toHaveLength(1));
  });

  it('a pull request to create by hand: link, copy buttons, then the pasted URL', async () => {
    const pr = { id: 'pr1', taskId: 'task1', repoId: 'r1', url: 'https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/shop/pull-requests/new/refs/heads/main/.../refs/heads/agent/x?region=eu-central-1', title: 'TND-1: Health endpoint', description: 'Body', status: 'manual-pending' as const, manual: true, createdAt: '' };
    const { api, user } = setup(detail({ prs: [pr] }, { state: 'PR_OPEN' }));
    await user.click(await screen.findByRole('tab', { name: /Pull requests/ }));
    const link = screen.getByRole('link', { name: 'Open create page' });
    expect(link.getAttribute('href')).toBe(pr.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('button', { name: 'Copy title' })).toBeTruthy();
    await user.type(screen.getByLabelText('Link to the new pull request'), 'https://example.com/pull-requests/7/details');
    await user.click(screen.getByRole('button', { name: 'Save link' }));
    await waitFor(() => expect(posted(api, '/api/prs/pr1/url')[0]?.body).toEqual({ url: 'https://example.com/pull-requests/7/details' }));
  });

  it('checks: criteria mapped to tests, verification output, findings turned into rules', async () => {
    const d = detail(
      {
        tests: [
          { taskId: 'task1', criterion: 1, repoId: 'r1', file: 'test/health.test.ts', name: 'returns ok', result: 'pass', scope: 'single' },
          { taskId: 'task1', criterion: 2, repoId: 'r1', file: 'test/web.test.tsx', name: 'shows status', result: 'fail', scope: 'single' },
        ],
        verifyRuns: [{ id: 'v1', taskId: 'task1', attempt: 0, passed: false, createdAt: '2026-11-03T09:00:00.000Z', results: [{ repoId: 'r1', kind: 'test', command: 'npm test', exitCode: 1, timedOut: false, durationMs: 2100, outputTail: 'FAIL shows status' }] }],
        findings: [{ id: 'f1', taskId: 'task1', severity: 'medium', category: 'rules', repoId: 'r1', file: 'src/app.ts', line: 4, title: 'Validate input', detail: 'Use zod for query params.', status: 'open' }],
      },
      { state: 'VERIFYING' },
    );
    const { api, user } = setup(d);
    await user.click(await screen.findByRole('tab', { name: /Checks/ }));
    expect(screen.getByRole('cell', { name: 'Pass' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Fail' })).toBeTruthy();
    expect(screen.getByText('Failing')).toBeTruthy();
    expect(screen.getByText('FAIL shows status')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turn into a rule' }));
    await waitFor(() => expect(posted(api, '/api/rules')[0]?.body).toEqual({ repoId: 'r1', text: 'Validate input: Use zod for query params.', source: 'Self-review finding on TND-1' }));
  });

  it('shows a plain error when the task cannot be loaded', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks/task1': () => new Response(JSON.stringify({ error: 'Task task1 not found.' }), { status: 404 }) });
    renderApp('/tasks/task1');
    expect(await screen.findByText('Task task1 not found.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });
});
