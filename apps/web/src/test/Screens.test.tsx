import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, catalog, detail, settings, task } from './fixtures';
import { asCompanyRunner, mockApi, renderApp } from './helpers';

const report = (statuses: Array<'pass' | 'warn' | 'fail' | 'skipped'>) => ({
  at: new Date().toISOString(),
  ok: !statuses.includes('fail'),
  checks: statuses.map((status, i) => ({ id: `c${i}`, group: i % 2 ? 'Tools' : 'Copilot', label: `Check ${i}`, status, message: `Message ${i}`, ...(status === 'fail' ? { fix: 'Do the fix.' } : {}) })),
});

describe('Tasks list', () => {
  it('shows the empty state with a way to start', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [] });
    renderApp('/tasks');
    expect(await screen.findByText('No tasks yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start in chat' }).getAttribute('href')).toBe('/chat');
  });

  it('filters by what needs you, and links each task', async () => {
    const list = [
      { ...task({ id: 'a', key: 'TND-1', title: 'Review me', state: 'SPEC_REVIEW', updatedAt: '2026-11-03T09:00:00Z' }), prCount: 0 },
      { ...task({ id: 'b', key: 'TND-2', title: 'Building it', state: 'BUILDING', step: 'implement', updatedAt: '2026-11-03T11:00:00Z' }), prCount: 0 },
      { ...task({ id: 'c', key: 'TND-3', title: 'Shipped', state: 'DONE', updatedAt: '2026-11-03T10:00:00Z' }), prCount: 1 },
    ];
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': list });
    const user = userEvent.setup();
    renderApp('/tasks');
    const main = await screen.findByRole('main');
    expect(await within(main).findByRole('link', { name: /Review me/ })).toBeTruthy();
    // The sidebar lists the open tasks, with their status in words; finished ones stay in Tasks.
    const going = within(screen.getByRole('list', { name: 'Open tasks' }));
    expect(going.getAllByRole('link').map((l) => l.textContent)).toEqual(['Building it, working', 'Review me, spec to review']);
    // One list, most recent activity first, whatever the status.
    expect(screen.getAllByRole('link', { name: /TND-/ }).map((l) => l.textContent)).toEqual([expect.stringContaining('Building it'), expect.stringContaining('Shipped'), expect.stringContaining('Review me')]);
    await user.click(screen.getByRole('button', { name: /Needs you/ }));
    expect(screen.getAllByRole('link', { name: /TND-/ }).map((l) => l.textContent)).toEqual([expect.stringContaining('Review me')]);
    await user.click(screen.getByRole('button', { name: /^Done/ }));
    expect(within(main).getByRole('link', { name: /Shipped/ }).getAttribute('href')).toBe('/tasks/c');
  });

  it('shows a plain error with a retry', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': () => new Response(JSON.stringify({ error: 'Database is locked.' }), { status: 503 }) });
    renderApp('/tasks');
    expect(await screen.findByText('Database is locked.', {}, { timeout: 4000 })).toBeTruthy();
  });

  it('imports Jira issues by key when Jira is configured', async () => {
    const api = mockApi({ 'GET /api/bootstrap': boot({ jiraConfigured: true }), 'GET /api/tasks': [], 'POST /api/projects/p1/import': { imported: [{ id: 't9', key: 'SHOP-12' }] } });
    const user = userEvent.setup();
    renderApp('/tasks');
    await user.click(await screen.findByRole('button', { name: 'Import from Jira' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import from Jira' });
    expect(within(dialog).getByRole('button', { name: 'Import ready issues' })).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Issue keys/), 'shop-12');
    await user.click(within(dialog).getByRole('button', { name: 'Import 1 issue' }));
    expect(await within(dialog).findByText('Imported SHOP-12.')).toBeTruthy();
    expect(api.calls.find((c) => c.path === '/api/projects/p1/import')?.body).toEqual({ keys: ['SHOP-12'] });
  });

  it('has no Jira import without Jira', async () => {
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/tasks': [] });
    renderApp('/tasks');
    expect(await screen.findByRole('button', { name: 'New task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import from Jira' })).toBeNull();
  });

  it('creates a task from the form with a live readiness check', async () => {
    let created: unknown;
    mockApi({
      'GET /api/bootstrap': boot(),
      'GET /api/tasks': [],
      'POST /api/readiness': (b) => {
        const goal = (b as { goal: string }).goal;
        return { ready: false, items: [{ id: 'goal', label: 'Clear goal', ok: Boolean(goal), detail: '' }], missing: goal ? [] : [{ id: 'goal', label: 'Clear goal', ok: false, detail: '' }] };
      },
      'POST /api/tasks': (b) => ((created = b), { id: 'n1' }),
      'GET /api/tasks/n1': detail({}, { id: 'n1', state: 'DRAFT' }),
    });
    const user = userEvent.setup();
    renderApp('/tasks');
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    const draft = within(dialog).getByRole('button', { name: 'Save as draft' }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Title'), 'Health endpoint');
    await user.type(within(dialog).getByLabelText('Goal'), 'Add GET /health');
    await user.click(within(dialog).getByRole('button', { name: 'Create and check readiness' }));
    await waitFor(() => expect(window.location.pathname).toBe('/tasks/n1'));
    expect(created).toMatchObject({ projectId: 'p1', title: 'Health endpoint', submit: true, affectedRepoIds: ['r1'], requirement: { goal: 'Add GET /health', criteria: [] } });
  });
});

describe('Settings', () => {
  const routes = (over = {}) => ({
    'GET /api/bootstrap': boot(),
    'GET /api/settings': settings,
    'GET /api/secrets': { keychain: { ok: true }, jiraToken: false, githubToken: false },
    'GET /api/usage': { today: 3, perDay: 40, perTask: 15, credits: { today: 0.5, perDay: 75, perTask: 25 }, last30Days: { prompts: 9, modelCalls: 20, aiCredits: 1.25 } },
    'GET /api/copilot/models': catalog,
    ...over,
  });

  it('shows the GitHub account as GitHub does, with Copilot ready, and disconnects it', async () => {
    let disconnected = false;
    mockApi(
      routes({
        'GET /api/copilot/accounts': { signedIn: true, active: { id: 'u1', login: 'mona', host: 'github.com', active: true, source: 'copilot' }, accounts: [], providers: [] },
        'GET /api/me': { user: { id: 'u1', login: 'mona', name: 'Mona Lisa', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }, workspaces: [] },
        'GET /api/workspace': { role: 'owner', me: 'u1', members: [], runner: { mode: 'cloud', connected: false } },
        'POST /auth/disconnect-github': () => ((disconnected = true), { ok: true }),
      }),
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const user = userEvent.setup();
    renderApp('/settings');
    expect(await screen.findByText('@mona · github.com')).toBeTruthy();
    expect(screen.getAllByText('Mona Lisa').length).toBeGreaterThan(0);
    expect(screen.getByText('Copilot ready')).toBeTruthy();
    expect(document.querySelector('img[src="https://avatars.githubusercontent.com/u/1"]')).toBeTruthy();
    // Models only once Copilot is ready.
    expect(screen.getByLabelText('Default model for code')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect GitHub?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnected).toBe(true));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('shows the save bar only with unsaved changes, and saves', async () => {
    let saved: unknown;
    mockApi(routes({ 'PUT /api/settings': (b: unknown) => ((saved = b), b) }));
    const user = userEvent.setup();
    renderApp('/settings');
    const perTask = await screen.findByLabelText('Prompts per task');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    await user.clear(perTask);
    await user.type(perTask, '8');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await user.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect((screen.getByLabelText('Prompts per task') as HTMLInputElement).value).toBe('15');
    await user.clear(perTask);
    expect(screen.getByText('Use a whole number from 1.')).toBeTruthy();
    expect(perTask.getAttribute('aria-invalid')).toBe('true');
    await user.type(perTask, '8');
    expect(screen.queryByText('Use a whole number from 1.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saved).toMatchObject({ budget: { perTaskPrompts: 8, perDayPrompts: 40 } }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
  });

  it("says why tokens can't be kept on the runner's computer, and disables token fields", async () => {
    const leave = asCompanyRunner();
    try {
      mockApi(routes({ 'GET /api/secrets': { keychain: { ok: false, message: 'Secrets cannot be kept: the data folder is read-only.' }, jiraToken: false, githubToken: false } }));
      renderApp('/settings');
      expect(await screen.findByText('Secrets cannot be kept: the data folder is read-only.')).toBeTruthy();
      // One section for GitHub and Copilot.
      expect(screen.getAllByRole('heading', { name: 'GitHub & Copilot' })).toHaveLength(1);
      expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull();
      expect((screen.getByLabelText('Extra GitHub token') as HTMLInputElement).disabled).toBe(true);
    } finally {
      leave();
    }
  });
});

describe('Doctor', () => {
  it('runs checks and summarises warnings and failures with fixes', async () => {
    let n = 0;
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/doctor': null, 'POST /api/doctor': () => (n++ ? report(['pass', 'fail', 'warn']) : report(['pass', 'warn'])) });
    const user = userEvent.setup();
    renderApp('/doctor');
    expect(await screen.findByText('No checks yet')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Run checks' })[0]!);
    expect(await screen.findByText('Everything required passes, with 1 warning')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: /Run checks/ })[0]!);
    expect(await screen.findByText('1 check needs attention')).toBeTruthy();
    expect(screen.getByText(/Do the fix\./)).toBeTruthy();
  });
});

describe('Projects', () => {
  it('lists repositories and adds a learned rule', async () => {
    let rule: unknown;
    mockApi({ 'GET /api/bootstrap': boot(), 'GET /api/rules': [], 'POST /api/rules': (b) => ((rule = b), { id: 'x', ...(b as object), createdAt: '' }) });
    const user = userEvent.setup();
    renderApp('/projects');
    expect(await screen.findByRole('heading', { name: 'Shop' })).toBeTruthy();
    expect(screen.getByTitle('codecommit::eu-central-1://shop').textContent).toContain('shop');
    expect(screen.getByRole('link', { name: 'Add repository' }).getAttribute('href')).toBe('/setup');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    await user.type(within(dialog).getByLabelText('Rule'), 'Validate every query parameter with zod.');
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(rule).toMatchObject({ repoId: 'r1', text: 'Validate every query parameter with zod.' }));
  });

  it('points to setup when there is no project', async () => {
    mockApi({ 'GET /api/bootstrap': boot({ projects: [], repos: [] }), 'GET /api/rules': [] });
    renderApp('/projects');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
  });
});

describe('Setup wizard', () => {
  it('says plainly when the GitHub account has no Copilot plan, and connects the work account with a code', async () => {
    let asked: unknown;
    mockApi({
      'GET /api/bootstrap': boot({ setupComplete: false, projects: [], repos: [] }),
      'GET /api/copilot/accounts': { signedIn: true, active: { id: 'u1', login: 'mona', host: 'github.com', active: true, source: 'copilot' }, accounts: [], providers: [{ kind: 'proxima', label: "Your company's GitHub", available: true }] },
      'POST /api/copilot/sign-in': (b: unknown) => ((asked = b), { flowId: 'f1', step: { kind: 'input-required', prompt: 'host?' } }),
      'POST /api/copilot/sign-in/f1/next': (b: { input?: string } | undefined) => (b?.input ? { kind: 'device-code', code: 'WDJB-MJHT', url: 'https://acme.ghe.com/login/device', expiresAt: '' } : new Promise((r) => setTimeout(() => r({ kind: 'awaiting' }), 300))),
      'GET /api/copilot/models': new Response(JSON.stringify({ error: 'This GitHub account has no Copilot plan Tandem can use. Sign in with the account that has one; for Copilot from work, use a company computer (Settings › Workspace).' }), { status: 409 }),
      'GET /api/me': { user: { id: 'u1', login: 'mona', name: 'Mona' }, workspaces: [] },
      'GET /api/workspace': { role: 'owner', runner: { mode: 'cloud', connected: false } },
    });
    const user = userEvent.setup();
    renderApp('/');
    await waitFor(() => expect(window.location.pathname).toBe('/setup'));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('No Copilot plan')).toBeTruthy();
    expect(screen.getByText('Is your Copilot from work?')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
    // The way forward is right there: the work account, signed in with a code.
    await user.click(screen.getByRole('button', { name: 'Connect your work account' }));
    const dialog = await screen.findByRole('dialog', { name: "Sign in to your company's GitHub" });
    expect(asked).toEqual({ kind: 'proxima', method: 'code' });
    await user.type(within(dialog).getByLabelText("Your company's GitHub address"), 'acme.ghe.com');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByLabelText('Your sign-in code')).toBeTruthy();
    expect(within(dialog).getByText('WDJB-MJHT')).toBeTruthy();
    // No browser fallback in the web app: a code works from anywhere.
    expect(within(dialog).queryByText('Sign in through the browser instead')).toBeNull();
  });

  it('redirects to setup on first launch and adds a detected repository', async () => {
    let added: unknown;
    mockApi({
      'GET /api/bootstrap': boot({ setupComplete: false, projects: [], repos: [] }),
      'GET /api/copilot/accounts': { signedIn: false, accounts: [], providers: [], host: 'github.com' },
      'PUT /api/settings': (b) => b as object,
      'POST /api/repos/detect': (b) =>
        (b as { url: string }).url.startsWith('codecommit')
          ? { repo: { id: 'd1', url: 'codecommit::eu-central-1://shop', host: { kind: 'codecommit', region: 'eu-central-1', name: 'shop' }, name: 'shop', defaultBranch: 'main', role: 'backend', commands: { test: 'npm test' }, language: 'TypeScript', createdAt: '' }, evidence: ['package.json'] }
          : new Response(JSON.stringify({ error: 'That is not a CodeCommit or GitHub URL.' }), { status: 400 }),
      'POST /api/repos': (b) => ((added = b), { ...(b as object), id: 'r9', host: { kind: 'codecommit', region: 'eu-central-1', name: 'shop' }, createdAt: '' }),
    });
    const user = userEvent.setup();
    renderApp('/');
    await waitFor(() => expect(window.location.pathname).toBe('/setup'));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    // Copilot first, then repositories.
    expect(await screen.findByRole('heading', { name: 'Connect GitHub Copilot' })).toBeTruthy();
    // Not connected yet: it can wait.
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    // Pick from GitHub, CodeCommit, a clone on this computer, or paste a URL.
    await user.click(await screen.findByRole('tab', { name: 'Clone URL' }));
    await user.type(screen.getByRole('textbox', { name: 'Clone URL' }), 'ftp://nope');
    await user.click(screen.getByRole('button', { name: 'Read the repository' }));
    expect(await screen.findByText('That is not a CodeCommit or GitHub URL.')).toBeTruthy();
    await user.clear(screen.getByRole('textbox', { name: 'Clone URL' }));
    await user.type(screen.getByRole('textbox', { name: 'Clone URL' }), 'codecommit::eu-central-1://shop');
    await user.click(screen.getByRole('button', { name: 'Read the repository' }));
    expect(await screen.findByText('Confirm shop')).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    await user.click(screen.getByRole('option', { name: /Full-stack/ }));
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    await waitFor(() => expect(added).toMatchObject({ url: 'codecommit::eu-central-1://shop', role: 'full-stack', defaultBranch: 'main', commands: { test: 'npm test' } }));
  });
});
