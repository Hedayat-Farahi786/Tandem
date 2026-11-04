import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SPEC_MD, boot, detail } from './fixtures';
import { mockApi, renderApp } from './helpers';
import type { TaskDetail } from '../lib/types';

const T0 = '2026-11-03T10:00:00.000Z';
const T1 = '2026-11-03T10:05:00.000Z';
const specRun = { id: 'run1', taskId: 'task1', kind: 'spec', mode: 'read-only', status: 'succeeded', attempt: 0, startedAt: T0, endedAt: T1, prompts: 1, modelCalls: 2, aiCredits: 0.3, model: 'gpt-6-luna', steps: [{ id: 's1', runId: 'run1', taskId: 'task1', seq: 0, at: T0, kind: 'tool', tool: 'view', input: 'src/app.ts', ok: true }] };

function setup(d: TaskDetail, extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET /api/bootstrap': boot(),
    'GET /api/tasks/task1': () => d,
    'GET /api/tasks/task1/spec/1': SPEC_MD,
    'GET /api/tasks/task1/thread': { id: 'th1' },
    'GET /api/tasks/task1/activity': [specRun],
    'GET /api/threads/th1': { thread: { id: 'th1', projectId: 'p1', mode: 'task', taskId: 'task1', title: 'TND-1 chat', createdAt: '', updatedAt: '' }, model: '', messages: [], readiness: null },
    'GET /api/tasks/task1/diff': [],
    'POST /api/*': { ok: true },
    ...extra,
  });
  renderApp('/tasks/task1');
  return { api, user: userEvent.setup() };
}
const posted = (api: ReturnType<typeof mockApi>, path: string) => api.calls.filter((c) => c.method !== 'GET' && c.path === path);

describe('Task as a conversation', () => {
  it('tells the task as one conversation, with the spec open beside it for review', async () => {
    const { api, user } = setup(detail());
    const convo = await screen.findByRole('region', { name: 'Conversation' });
    // The request, what happened, what Copilot did and the spec, in order.
    expect(await within(convo).findByText('Add GET /health')).toBeTruthy();
    // Routine stage changes stay out of the conversation (the bar shows them); its cards tell the story.
    expect(within(convo).queryByText('Readiness check')).toBeNull();
    expect(await within(convo).findByText('Wrote the spec')).toBeTruthy();
    expect(within(convo).getByText('Spec v1')).toBeTruthy();
    // What needs you sits at the end, right above the composer.
    expect(within(convo).getByText('Your review is needed')).toBeTruthy();
    expect(within(convo).getByLabelText('Message')).toBeTruthy();

    // A task in review opens its spec beside the conversation; approve without leaving it.
    const panel = screen.getByRole('complementary', { name: 'Task details' });
    expect(within(panel).getByRole('tab', { name: /Spec/ }).getAttribute('aria-selected')).toBe('true');
    expect(await within(panel).findByRole('heading', { name: 'Problem and goal' })).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Approve spec' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/approve')).toHaveLength(1));

    // Close it, and open it again from the spec card.
    await user.click(within(panel).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull();
    await user.click(within(convo).getByRole('button', { name: 'Open spec' }));
    expect(screen.getByRole('complementary', { name: 'Task details' })).toBeTruthy();
  });

  it('a pull request shows in the conversation and opens beside it', async () => {
    const pr = { id: 'pr1', taskId: 'task1', repoId: 'r1', url: 'https://example.com/pr/1', title: 'TND-1: Health endpoint', description: 'Body', status: 'open' as const, manual: false, createdAt: T1 };
    const { user } = setup(detail({ prs: [pr] }, { state: 'PR_OPEN' }));
    const convo = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(convo).findByText('TND-1: Health endpoint')).toBeTruthy();
    expect(within(convo).getByRole('link', { name: /Open the pull request/ }).getAttribute('href')).toBe('https://example.com/pr/1');
    await user.click(within(convo).getByRole('button', { name: 'View' }));
    const panel = screen.getByRole('complementary', { name: 'Task details' });
    expect(within(panel).getByRole('tab', { name: /Pull requests/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('a failed task asks for help in the conversation', async () => {
    const { api, user } = setup(detail({}, { state: 'FAILED', blockedMessage: 'The build stopped: npm ci failed.' }));
    const convo = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(convo).findByText('Something failed')).toBeTruthy();
    await user.click(within(convo).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(posted(api, '/api/tasks/task1/resume')).toHaveLength(1));
    expect(within(convo).getByRole('button', { name: 'Continue with this' })).toBeTruthy();
  });

  it('shows what Tandem is doing while it runs the checks, so a long step never looks stuck', async () => {
    setup(detail({ transitions: [{ id: 1, taskId: 'task1', from: 'BUILDING', to: 'VERIFYING', reason: 'Implementation committed; running checks.', actor: 'system', at: T1 }] }, { state: 'VERIFYING', step: 'verify' }));
    const convo = await screen.findByRole('region', { name: 'Conversation' });
    const line = await within(convo).findByText('Running the checks');
    expect(line.closest('[role="status"]')).toBeTruthy();
  });

  it('shows every stage while Copilot builds: what is done, what it is doing now, and what comes next', async () => {
    const buildRun = { id: 'run2', taskId: 'task1', kind: 'build', mode: 'build', status: 'running', attempt: 0, startedAt: T1, prompts: 1, modelCalls: 3, aiCredits: 0.4, model: 'gpt-6-luna', steps: [
      { id: 'b1', runId: 'run2', taskId: 'task1', seq: 0, at: T1, kind: 'tool', tool: 'view', input: 'src/health.ts', ok: true },
      { id: 'b2', runId: 'run2', taskId: 'task1', seq: 1, at: T1, kind: 'message', text: 'The route exists; adding the version next.' },
      { id: 'b3', runId: 'run2', taskId: 'task1', seq: 2, at: T1, kind: 'tool', tool: 'edit', input: 'src/health.ts', files: [{ path: 'src/health.ts', kind: 'edit' }] },
    ] };
    const { user } = setup(
      detail({ transitions: [
        { id: 1, taskId: 'task1', from: 'DRAFT', to: 'READINESS', reason: 'Submitted.', actor: 'owner', at: T0 },
        { id: 2, taskId: 'task1', from: 'READINESS', to: 'SPEC_DRAFTING', reason: 'Ready.', actor: 'system', at: T0 },
        { id: 3, taskId: 'task1', from: 'SPEC_DRAFTING', to: 'SPEC_REVIEW', reason: 'Drafted.', actor: 'system', at: T0 },
        { id: 4, taskId: 'task1', from: 'SPEC_REVIEW', to: 'BUILDING', reason: 'Approved.', actor: 'owner', at: T1 },
      ] }, { state: 'BUILDING', step: 'implement' }),
      { 'GET /api/tasks/task1/activity': [specRun, buildRun] },
    );
    // Under the title: where the task is, in words; click it for every stage.
    const tracker = await screen.findByRole('button', { name: /Step 4 of 8: Build, Copilot coding/ });
    await user.click(tracker);
    const stages = within(screen.getByRole('dialog', { name: 'Task stages' })).getByRole('list', { name: 'Stages' });
    expect(within(stages).getByText(/Write the spec/).closest('li')!.textContent).toContain('done');
    const build = within(stages).getByText(/^Build/).closest('li')!;
    expect(build.getAttribute('aria-current')).toBe('step');
    // The live step says what Copilot is doing right now.
    expect(within(build).getByText('Copilot writes the code and tests')).toBeTruthy();
    expect(await within(build).findByText('Editing health.ts…')).toBeTruthy();
    expect(within(stages).getByText(/Run the checks/).closest('li')!.textContent).toContain('not started');
    // In the conversation, what Copilot said sits between its steps.
    const convo = screen.getByRole('region', { name: 'Conversation' });
    expect(await within(convo).findByText('The route exists; adding the version next.')).toBeTruthy();
  });
});
