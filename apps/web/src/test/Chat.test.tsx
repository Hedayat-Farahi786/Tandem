import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, catalog } from './fixtures';
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
      'GET /api/threads/t1': () => ({ thread: { ...thread, draftTitle: 'Health endpoint' }, model: '', messages, readiness: readiness(ready) }),
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

  it('lists recent conversations in the main sidebar and opens one; New chat goes back to the composer', async () => {
    const older = { ...thread, id: 't2', title: 'Where is the greeting route?', mode: 'ask', createdTaskId: undefined };
    const done = { ...thread, id: 't3', title: 'Health endpoint', createdTaskId: 'task1' };
    mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/projects/p1/threads': [done, older],
      'GET /api/threads/t2': { thread: older, model: '', messages: [], readiness: null },
    });
    const user = userEvent.setup();
    renderApp('/chat');
    const recents = await screen.findByRole('navigation', { name: 'Conversations' });
    expect(await within(recents).findByText('Where is the greeting route?')).toBeTruthy();
    expect(within(recents).getByLabelText('Became a task')).toBeTruthy();
    await user.click(within(recents).getByText('Where is the greeting route?'));
    expect(await screen.findByRole('heading', { name: 'Where is the greeting route?' })).toBeTruthy();
    expect(within(recents).getByText('Where is the greeting route?').closest('a')?.getAttribute('aria-current')).toBe('page');
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'New chat' }));
    expect(await screen.findByRole('heading', { name: 'What should we build?' })).toBeTruthy();
  });

  it('picks a Copilot model with prices and details, for a new chat and an open one', async () => {
    let model = '';
    const api = mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/projects/p1/threads': () => (api.calls.some((c) => c.method === 'POST' && c.path === '/api/threads') ? [thread] : []),
      'GET /api/copilot/models': catalog,
      'POST /api/threads': (b) => ((model = (b as { model?: string }).model ?? ''), { ...thread, model }),
      'GET /api/threads/t1': () => ({ thread, model, messages: [], readiness: readiness(false) }),
      'POST /api/threads/t1/messages': { ok: true },
      'PUT /api/threads/t1/model': (b) => ((model = (b as { model: string }).model), { thread, model }),
    });
    const user = userEvent.setup();
    renderApp('/chat');
    const picker = await screen.findByRole('combobox', { name: 'Model: Auto' });
    await user.click(picker);
    const list = await screen.findByRole('listbox', { name: 'Copilot model' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['AutoTandem picks per step', 'Claude Sonnet 5.5≈ 48', 'GPT-6 Luna≈ 3']);
    expect(within(list).getByRole('group', { name: 'Anthropic' })).toBeTruthy();
    // The Auto details explain what it uses.
    expect(screen.getByText(/for chat, specs and reviews/)).toBeTruthy();
    expect(screen.getByText('Today 0.5 of 75 credits')).toBeTruthy();
    // Keyboard: down to Sonnet shows its prices and the warning above the task limit.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText('Cached input')).toBeTruthy();
    expect(screen.getByText(/above the 25-credit task limit/)).toBeTruthy();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model: GPT-6 Luna' })).toBeTruthy();

    await user.type(screen.getByLabelText('Describe your request'), 'Add a GET /health endpoint{Enter}');
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/threads')?.body).toEqual({ projectId: 'p1', mode: 'request', model: 'gpt-6-luna' }));
    const inThread = await screen.findByRole('combobox', { name: 'Model: GPT-6 Luna' });
    await user.click(inThread);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /Claude Sonnet 5.5/ }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ model: 'claude-sonnet-5.5' }));
    expect(await screen.findByRole('combobox', { name: 'Model: Claude Sonnet 5.5' })).toBeTruthy();
    // Escape closes the list without picking.
    await user.click(screen.getByRole('combobox', { name: 'Model: Claude Sonnet 5.5' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('asks a project to be added first when there is none', async () => {
    mockApi({ 'GET /api/bootstrap': boot({ projects: [], repos: [], setupComplete: true }) });
    renderApp('/chat');
    expect(await screen.findByText('Add a project first')).toBeTruthy();
  });
});
