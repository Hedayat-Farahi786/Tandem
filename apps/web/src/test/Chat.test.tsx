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
    // The task draft fills in beside the chat; it can be created once it is ready.
    const draft = screen.getByRole('complementary', { name: 'Task draft' });
    expect(within(draft).getByText('Health endpoint')).toBeTruthy();
    expect((within(draft).getByRole('button', { name: 'Create and start' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Message'), 'Show a spinner{Enter}');
    await waitFor(() => expect((within(draft).getByRole('button', { name: 'Create and start' }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(draft).getByText('Ready')).toBeTruthy();
    await user.click(within(draft).getByRole('button', { name: 'Create and start' }));
    expect(api.calls.find((c) => c.path === '/api/threads/t1/create-task')?.body).toEqual({ start: true });
    await waitFor(() => expect(window.location.pathname).toBe('/tasks/task1'));
  });

  it('the spec writes itself beside the chat; save it as a task for later without starting it', async () => {
    const draft = { goal: 'Show the service status on the main page', userStory: '', criteria: [{ given: 'the backend is down', when: 'the page loads', then: 'it shows Status unavailable' }], exampleData: '', affectedAreas: '', outOfScope: '', openQuestions: [] };
    const api = mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/projects/p1/threads': [thread],
      'GET /api/threads/t1': { thread: { ...thread, draftTitle: 'Show service status', draft }, model: '', messages: [], readiness: readiness(false) },
      'POST /api/threads/t1/create-task': { id: 'task9', key: 'TND-9' },
      'GET /api/tasks/task9': () => new Response(JSON.stringify({ error: 'stop' }), { status: 404 }),
    });
    const user = userEvent.setup();
    renderApp('/chat?project=p1&thread=t1');
    const doc = await screen.findByRole('complementary', { name: 'Task draft' });
    expect(within(doc).getByRole('heading', { name: 'Show service status' })).toBeTruthy();
    expect(within(doc).getByText('Show the service status on the main page')).toBeTruthy();
    expect(within(doc).getByText('Given the backend is down, when the page loads, then it shows Status unavailable.')).toBeTruthy();
    expect((within(doc).getByRole('button', { name: 'Create and start' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(doc).getByRole('button', { name: 'Save for later' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/threads/t1/create-task')?.body).toEqual({ start: false }));
  });

  it('a chat opened while Copilot is answering shows it working, and the answer when it lands', async () => {
    let calls = 0;
    const q = { id: 'u1', threadId: 't1', role: 'user', content: 'Where is the health route?', refs: [], createdAt: '2026-11-03T10:00:00Z' };
    mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/projects/p1/threads': [thread],
      'GET /api/agent-runs/run1/steps': [{ id: 's1', runId: 'run1', seq: 0, at: '2026-11-03T10:00:01Z', kind: 'tool', tool: 'view', input: 'src/app.ts', ok: true }],
      'GET /api/threads/t1': () =>
        ++calls < 2
          ? { thread: { ...thread, mode: 'ask', busy: { since: new Date().toISOString(), runId: 'run1' } }, model: '', messages: [q], readiness: null }
          : { thread: { ...thread, mode: 'ask' }, model: '', messages: [q, { id: 'a1', threadId: 't1', role: 'assistant', content: 'In src/app.ts.', refs: [], createdAt: '2026-11-03T10:00:09Z' }], readiness: null },
    });
    renderApp('/chat?project=p1&thread=t1');
    const box = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
    expect(box.placeholder).toMatch(/Copilot is answering/);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('In src/app.ts.', {}, { timeout: 6000 })).toBeTruthy();
    expect(box.placeholder).not.toMatch(/Copilot is answering/);
  });

  it('keeps an unsent message when you leave the chat and come back', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/projects/p1/threads': [thread], 'GET /api/threads/t1': { thread: { ...thread, mode: 'ask' }, model: '', messages: [], readiness: null } });
    const user = userEvent.setup();
    const first = renderApp('/chat?project=p1&thread=t1');
    await user.type(await screen.findByLabelText('Message'), 'Half a thought');
    first.unmount();
    renderApp('/chat?project=p1&thread=t1');
    expect(((await screen.findByLabelText('Message')) as HTMLTextAreaElement).value).toBe('Half a thought');
  });

  it("asks Copilot's questions as choices, one at a time, with room for your own answer", async () => {
    const pendingQuestions = {
      askedAt: '2026-11-03T10:00:00Z',
      questions: [
        { id: 'q1', header: 'Loading & errors', question: 'What should the page show while it loads?', multiSelect: false, options: [{ label: 'Text status', description: 'Show "Checking status…"' }, { label: 'Spinner' }] },
        { id: 'q2', header: 'Out of scope', question: 'What should this leave out?', multiSelect: true, options: [{ label: 'Authentication' }, { label: 'Metrics' }] },
      ],
    };
    const api = mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/projects/p1/threads': [thread],
      'GET /api/threads/t1': { thread: { ...thread, pendingQuestions }, model: '', messages: [{ id: 'a1', threadId: 't1', role: 'assistant', content: 'A couple of questions.', refs: [], createdAt: '2026-11-03T10:00:00Z' }], readiness: readiness(false) },
      'POST /api/threads/t1/messages': { ok: true },
    });
    const user = userEvent.setup();
    renderApp('/chat?project=p1&thread=t1');
    const card = await screen.findByRole('region', { name: 'Copilot needs you' });
    expect(within(card).getByText('What should the page show while it loads?')).toBeTruthy();
    const next = within(card).getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.click(within(card).getByRole('radio', { name: /Text status/ }));
    await user.click(next);
    // Second question: pick several, and add your own.
    expect(within(card).getByText('What should this leave out?')).toBeTruthy();
    await user.click(within(card).getByRole('checkbox', { name: /Metrics/ }));
    await user.click(within(card).getByRole('checkbox', { name: /Other/ }));
    await user.type(within(card).getByLabelText('Your answer: Out of scope'), 'Dark mode');
    await user.click(within(card).getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/threads/t1/messages')).toBeTruthy());
    expect(api.calls.find((c) => c.path === '/api/threads/t1/messages')!.body).toEqual({
      text: 'Loading & errors: Text status\nOut of scope: Metrics, Dark mode',
      answers: [
        { questionId: 'q1', header: 'Loading & errors', question: 'What should the page show while it loads?', answers: ['Text status'] },
        { questionId: 'q2', header: 'Out of scope', question: 'What should this leave out?', answers: ['Metrics', 'Dark mode'] },
      ],
    });
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

  it('renames, pins and deletes chats from the sidebar menu and the chat title; a deleted open chat goes back to the composer', async () => {
    let list = [
      { ...thread, id: 't2', title: 'Where is the greeting route?', mode: 'ask' },
      { ...thread, id: 't3', title: 'Health endpoint', createdTaskId: 'task1' },
    ] as Array<Record<string, unknown>>;
    const byId = (id: string) => list.find((t) => t.id === id)!;
    const api = mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/tasks': [{ id: 'task1', key: 'TND-1', title: 'Health endpoint', state: 'BUILDING', prCount: 0 }],
      'GET /api/projects/p1/threads': () => [...list].sort((a, b) => String(b.pinnedAt ?? '').localeCompare(String(a.pinnedAt ?? ''))),
      'GET /api/threads/t2': () => ({ thread: byId('t2'), model: '', messages: [], readiness: null }),
      'GET /api/threads/t3': () => ({ thread: byId('t3'), model: '', messages: [], readiness: null }),
      'PUT /api/threads/t2/title': (b) => Object.assign(byId('t2'), { title: (b as { title: string }).title }),
      'PUT /api/threads/t3/pin': (b) => Object.assign(byId('t3'), { pinnedAt: (b as { pinned: boolean }).pinned ? '2026-11-04T00:00:00Z' : undefined }),
      'DELETE /api/threads/t3': () => ((list = list.filter((t) => t.id !== 't3')), { deleted: true, messages: 4 }),
    });
    const user = userEvent.setup();
    renderApp('/chat?project=p1');
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    await within(nav).findByText('Where is the greeting route?');

    // Rename from the sidebar: the name edits in place, Enter saves.
    await user.click(within(nav).getByRole('button', { name: 'Actions for Where is the greeting route?' }));
    const menu = await screen.findByRole('menu', { name: 'Actions for Where is the greeting route?' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Pin to top', 'Rename', 'Delete']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const field = within(nav).getByRole('textbox', { name: 'Chat name' });
    await user.clear(field);
    await user.type(field, 'Greeting route{Enter}');
    expect(api.calls.find((c) => c.path === '/api/threads/t2/title')?.body).toEqual({ title: 'Greeting route' });
    expect(await within(nav).findByText('Greeting route')).toBeTruthy();

    // Escape cancels a rename.
    await user.click(within(nav).getByRole('button', { name: 'Actions for Greeting route' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await user.type(within(nav).getByRole('textbox', { name: 'Chat name' }), ' nope{Escape}');
    expect(api.calls.filter((c) => c.path === '/api/threads/t2/title')).toHaveLength(1);

    // Pin: it moves to a Pinned group at the top.
    await user.click(within(nav).getByRole('button', { name: 'Actions for Health endpoint' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pin to top' }));
    const pinned = await within(nav).findByRole('list', { name: 'Pinned chats' });
    expect(within(pinned).getByText('Health endpoint')).toBeTruthy();

    // Open it, then delete from its title bar: asked first, the task is said to stay.
    await user.click(within(pinned).getByText('Health endpoint'));
    expect(await screen.findByRole('heading', { name: 'Health endpoint' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Chat actions' }));
    expect(within(await screen.findByRole('menu', { name: 'Chat actions' })).getByRole('menuitem', { name: 'Unpin' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' });
    expect(await within(dialog).findByText('TND-1')).toBeTruthy();
    expect(within(dialog).getByText(/keeps its own copy of the request/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete chat' }));
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/threads/t3')).toBe(true);
    expect(await screen.findByRole('heading', { name: 'What should we build?' })).toBeTruthy();
    await waitFor(() => expect(within(nav).queryByText('Health endpoint')).toBeNull());
    expect(within(nav).queryByRole('list', { name: 'Pinned chats' })).toBeNull();
  });

  it("won't offer Delete while Copilot is answering in a chat", async () => {
    const busy = { ...thread, id: 't4', title: 'Busy one', busy: { since: '2026-11-04T00:00:00Z' } };
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/projects/p1/threads': [busy] });
    const user = userEvent.setup();
    renderApp('/chat?project=p1');
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    await user.click(await within(nav).findByRole('button', { name: 'Actions for Busy one' }));
    expect((await screen.findByRole('menuitem', { name: 'Delete' })).getAttribute('aria-disabled')).toBe('true');
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
