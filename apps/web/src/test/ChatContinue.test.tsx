import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, detail } from './fixtures';
import { mockApi, renderApp } from './helpers';

const now = new Date().toISOString();
const models = { models: [], auto: { light: null, build: null }, credits: { today: 0, perDay: 75, perTask: 25 } };
const thread = (over: Record<string, unknown> = {}) => ({ id: 'th1', projectId: 'p1', mode: 'task', taskId: 'task1', title: 'TND-1 chat', createdAt: now, updatedAt: now, ...over });
const stuckTask = { state: 'PR_OPEN' as const, needsAttention: true, attentionNotes: ['app: test failed (`npm test`, exit 1)'] };

describe('task chat for a stuck task', () => {
  // These cover the Details view (the tabs); the Chat view has its own tests.
  beforeEach(() => localStorage.setItem('tandem.taskView', 'details'));
  it("shows what Copilot did above each answer, and continues the task with the owner's message", async () => {
    let continued: unknown;
    mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/tasks': [],
      'GET /api/tasks/task1': detail({}, stuckTask),
      'GET /api/tasks/task1/thread': { id: 'th1' },
      'GET /api/copilot/models': models,
      'GET /api/threads/th1': {
        thread: thread(),
        model: '',
        messages: [
          { id: 'm1', threadId: 'th1', role: 'assistant', content: 'I need your help with TND-1. The pull request is open, but some checks still fail.', refs: [], createdAt: now },
          { id: 'm2', threadId: 'th1', role: 'user', content: 'Why do they fail?', refs: [], createdAt: now },
          { id: 'm3', threadId: 'th1', role: 'assistant', content: 'The date test compares local time.', refs: [], runId: 'run1', createdAt: now },
        ],
        steps: {
          run1: [
            { id: 's1', runId: 'run1', seq: 1, at: now, kind: 'tool', tool: 'view', input: 'test/health.test.ts', ok: true },
            { id: 's2', runId: 'run1', seq: 2, at: now, kind: 'tool', tool: 'grep', input: 'Date', ok: true },
            { id: 's3', runId: 'run1', seq: 3, at: now, kind: 'reasoning', text: 'Local time differs on CI.' },
          ],
        },
        readiness: null,
      },
      'POST /api/threads/th1/continue': (b) => ((continued = b), { action: 'fixing', task: {} }),
    });
    const user = userEvent.setup();
    renderApp('/tasks/task1');
    await user.click(await screen.findByRole('tab', { name: 'Chat' }));
    // The steps fold into one line above the answer and open on demand.
    const summary = await screen.findByRole('button', { name: /Thought it through · read 1 file · 1 search/ });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    await user.click(summary);
    expect(screen.getByRole('button', { name: /Local time differs on CI\./ })).toBeTruthy();
    expect(screen.getByText('Read health.test.ts')).toBeTruthy();
    expect(screen.getByText('Searched for Date')).toBeTruthy();
    // The composer knows the task is stuck.
    const box = screen.getByPlaceholderText('Tell Copilot how to continue, or ask what went wrong…');
    await user.type(box, 'Use UTC in the date test.');
    await user.click(screen.getByRole('button', { name: 'Continue with this' }));
    await waitFor(() => expect(continued).toEqual({ text: 'Use UTC in the date test.' }));
    expect(await screen.findByText('Copilot is fixing the checks with your guidance.')).toBeTruthy();
  });

  it("offers Copilot's proposal to confirm", async () => {
    let confirmed = false;
    mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/tasks': [],
      'GET /api/tasks/task1': detail({}, stuckTask),
      'GET /api/tasks/task1/thread': { id: 'th1' },
      'GET /api/copilot/models': models,
      'GET /api/threads/th1': { thread: thread({ pendingContinue: { summary: 'Use UTC in the date test', guidance: 'Compare in UTC.' } }), model: '', messages: [], steps: {}, readiness: null },
      'POST /api/threads/th1/continue': () => ((confirmed = true), { action: 'fixing', task: {} }),
    });
    const user = userEvent.setup();
    renderApp('/tasks/task1');
    await user.click(await screen.findByRole('tab', { name: 'Chat' }));
    expect(await screen.findByText('Use UTC in the date test')).toBeTruthy();
    // The empty composer's own "Continue with this" is disabled; the proposal's is not.
    await user.click(screen.getAllByRole('button', { name: 'Continue with this' }).find((b) => !b.hasAttribute('disabled'))!);
    await waitFor(() => expect(confirmed).toBe(true));
  });

  it('lets the owner answer right under the "needs attention" message', async () => {
    let body: unknown;
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [], 'GET /api/tasks/task1': detail({}, stuckTask), 'GET /api/copilot/models': models, 'POST /api/tasks/task1/continue': (b) => ((body = b), { action: 'fixing', task: {} }) });
    const user = userEvent.setup();
    renderApp('/tasks/task1');
    const box = await screen.findByLabelText('Tell Copilot how to continue');
    const banner = box.closest('[class*="rounded-xl"]')!.parentElement!;
    await user.type(box, 'Use UTC.');
    await user.click(within(banner as HTMLElement).getByRole('button', { name: 'Continue with this' }));
    await waitFor(() => expect(body).toEqual({ text: 'Use UTC.' }));
    await user.click(within(banner as HTMLElement).getByRole('button', { name: 'Ask Copilot first' }));
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });
});
