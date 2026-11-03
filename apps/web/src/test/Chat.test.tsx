import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot } from './fixtures';
import { mockApi, renderApp } from './helpers';

const thread = { id: 't1', projectId: 'p1', mode: 'request', title: 'New request', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' };
const readiness = (ready: boolean) => ({ ready, items: [{ id: 'goal', label: 'Clear goal', ok: true, detail: '' }, { id: 'criteria', label: 'At least 2 acceptance criteria', ok: ready, detail: '' }], missing: ready ? [] : [{ id: 'criteria', label: 'At least 2 acceptance criteria', ok: false, detail: '' }] });

describe('Chat', () => {
  it('starts a request from the composer, streams the reply, then creates the task when ready', async () => {
    let messages: unknown[] = [];
    let ready = false;
    const created: string[] = [];
    const api = mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/projects/p1/threads': () => (created.length ? [thread] : []),
      'POST /api/threads': () => (created.push('t1'), thread),
      'GET /api/threads/t1': () => ({ thread: { ...thread, draftTitle: 'Health endpoint' }, messages, readiness: readiness(ready) }),
      'POST /api/threads/t1/messages': (body) => {
        const text = (body as { text: string }).text;
        messages = [...messages, { id: `u${messages.length}`, threadId: 't1', role: 'user', content: text, refs: [], createdAt: '' }, { id: `a${messages.length}`, threadId: 't1', role: 'assistant', content: ready ? 'Ready.' : 'What should the page show while loading?', refs: [{ path: 'src/app.ts', line: 12, repoId: 'r1' }], createdAt: '' }];
        ready = messages.length >= 4;
        return { ok: true };
      },
      'POST /api/threads/t1/create-task': { id: 'task1', key: 'TND-1' },
      'GET /api/tasks/task1': () => new Response(JSON.stringify({ error: 'stop' }), { status: 404 }),
    });
    const user = userEvent.setup();
    renderApp('/chat');
    expect(await screen.findByRole('heading', { name: 'What should we build?' })).toBeTruthy();
    await user.type(screen.getByLabelText('Describe your request'), 'Add a GET /health endpoint{Enter}');
    expect(await screen.findByText('What should the page show while loading?')).toBeTruthy();
    expect(screen.getByText(/shop\/src\/app\.ts:12/)).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/threads/t1/messages')?.body).toEqual({ text: 'Add a GET /health endpoint' });
    const create = screen.getByRole('button', { name: /Create task/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Message'), 'Show a spinner{Enter}');
    await waitFor(() => expect((screen.getByRole('button', { name: /Create task/ }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: /Create task/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/tasks/task1'));
  });

  it('asks a project to be added first when there is none', async () => {
    mockApi({ 'GET /api/bootstrap': boot({ projects: [], repos: [], setupComplete: true }) });
    renderApp('/chat');
    expect(await screen.findByText('Add a project first')).toBeTruthy();
  });
});
