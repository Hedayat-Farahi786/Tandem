import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, catalog, project, settings } from './fixtures';
import { mockApi, renderApp } from './helpers';
import { leavePage } from '../ui/jira-connect';

const routes = (jira: () => object, over: Record<string, unknown> = {}) => ({
  'GET /api/bootstrap': boot({ jiraConfigured: true }),
  'GET /api/settings': settings,
  'GET /api/secrets': { keychain: { ok: true }, jiraToken: false, githubToken: false },
  'GET /api/usage': { today: 0, perDay: 40, perTask: 15, credits: { today: 0, perDay: 75, perTask: 25 }, last30Days: { prompts: 0, modelCalls: 0, aiCredits: 0 } },
  'GET /api/copilot/models': catalog,
  'GET /api/copilot/accounts': { signedIn: false, accounts: [], providers: [], host: 'github.com' },
  'GET /api/jira': jira,
  'GET /api/jira/statuses': { statuses: ['Ready for AI', 'In Progress', 'In Review', 'Done'] },
  ...over,
});
const jiraSection = async () => within((await screen.findByRole('heading', { name: 'Jira' })).closest('section')!);

describe('Connect Jira', () => {
  it('signs in at Atlassian with one click', async () => {
    let started: unknown;
    const assign = vi.fn();
    const was = leavePage.to;
    leavePage.to = assign;
    try {
      mockApi(routes(() => ({ connected: false, oauth: true }), { 'POST /api/jira/oauth/start': (b: unknown) => ((started = b), { url: 'https://auth.atlassian.com/authorize?client_id=x' }) }));
      const user = userEvent.setup();
      renderApp('/settings');
      const jira = await jiraSection();
      expect(await jira.findByText('Sign in at Atlassian and allow Tandem. That is all.')).toBeTruthy();
      await user.click(jira.getByRole('button', { name: 'Connect Jira' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.atlassian.com/authorize?client_id=x'));
      expect(started).toEqual({ from: 'settings' });
    } finally {
      leavePage.to = was;
    }
  });

  it('connects with a token: any Jira link, the email for Jira Cloud, and a link to make the token', async () => {
    let connected = false;
    let sent: unknown;
    mockApi(
      routes(() => (connected ? { connected: true, method: 'token', site: { name: 'acme.atlassian.net', url: 'https://acme.atlassian.net' }, account: 'Jane Doe', oauth: false } : { connected: false, oauth: false }), {
        'POST /api/jira/token': (b: unknown) => {
          sent = b;
          connected = true;
          return { connected: true, method: 'token', site: { name: 'acme.atlassian.net', url: 'https://acme.atlassian.net' }, account: 'Jane Doe', oauth: false };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/settings');
    const jira = await jiraSection();
    await user.click(await jira.findByRole('button', { name: 'Connect Jira' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Jira with a token' });
    const connect = within(dialog).getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Your Jira'), 'https://acme.atlassian.net/browse/SHOP-12');
    // Jira Cloud: the email, and where to create the token.
    expect(within(dialog).getByRole('link', { name: /Create a token/ }).getAttribute('href')).toBe('https://id.atlassian.com/manage-profile/security/api-tokens');
    await user.type(within(dialog).getByLabelText('Your Atlassian email'), 'jane@acme.test');
    await user.type(within(dialog).getByLabelText('API token'), 'secret-token');
    await user.click(connect);
    await waitFor(() => expect(sent).toEqual({ site: 'https://acme.atlassian.net/browse/SHOP-12', token: 'secret-token', email: 'jane@acme.test' }));
    expect(await screen.findByText('Jira is connected to acme.atlassian.net as Jane Doe.')).toBeTruthy();
    expect(await jira.findByText(/comments appear as Jane Doe/)).toBeTruthy();
  });

  it('asks for a personal access token for Jira Data Center, linking to the page in that Jira', async () => {
    mockApi(routes(() => ({ connected: false, oauth: true })));
    const user = userEvent.setup();
    renderApp('/settings');
    const jira = await jiraSection();
    await user.click(await jira.findByRole('button', { name: 'Jira Data Center, or a token instead' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Jira with a token' });
    await user.type(within(dialog).getByLabelText('Your Jira'), 'https://jira.acme.test/browse/OPS-1');
    expect(within(dialog).queryByLabelText('Your Atlassian email')).toBeNull();
    expect(within(dialog).getByLabelText('Personal access token')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /Create a personal access token/ }).getAttribute('href')).toMatch(/^https:\/\/jira\.acme\.test\/secure\/ViewProfile\.jspa/);
  });

  it('says why when Atlassian sent the person back without a connection', async () => {
    mockApi(routes(() => ({ connected: false, oauth: true })));
    renderApp('/settings?jira=failed&message=You%20cancelled%20the%20sign-in%20at%20Atlassian.');
    expect(await screen.findByText('You cancelled the sign-in at Atlassian.')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('asks which site when the account has several', async () => {
    let chose: unknown;
    mockApi(
      routes(() => ({ connected: false, method: 'atlassian', sites: [{ id: 's1', name: 'Acme', url: 'https://acme.atlassian.net' }, { id: 's2', name: 'Acme Labs', url: 'https://acme-labs.atlassian.net' }], oauth: true }), {
        'POST /api/jira/site': (b: unknown) => ((chose = b), { connected: true, method: 'atlassian', site: { name: 'Acme Labs', url: 'https://acme-labs.atlassian.net' }, oauth: true }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('radio', { name: /Acme Labs/ }));
    await user.click(screen.getByRole('button', { name: 'Use this site' }));
    await waitFor(() => expect(chose).toEqual({ id: 's2' }));
    expect(await screen.findByText('Jira is connected to Acme Labs.')).toBeTruthy();
  });

  it('picks statuses from Jira instead of a query, once connected', async () => {
    let saved: { jira?: unknown } = {};
    mockApi(routes(() => ({ connected: true, method: 'atlassian', site: { name: 'Acme', url: 'https://acme.atlassian.net' }, account: 'Jane Doe', oauth: true }), { 'PUT /api/settings': (b: unknown) => ((saved = b as typeof saved), b) }));
    const user = userEvent.setup();
    renderApp('/settings');
    const jira = await jiraSection();
    const ready = await jira.findByRole('combobox', { name: 'Tandem picks up issues in' });
    expect(ready.textContent).toContain('Ready for AI');
    await user.click(jira.getByRole('combobox', { name: 'When the pull requests are open, move the issue to' }));
    await user.click(await screen.findByRole('option', { name: 'In Progress' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saved.jira).toMatchObject({ readyJql: 'status = "Ready for AI"', inReviewStatus: 'In Progress' }));
    // Writing JQL by hand is still there, out of the way.
    await user.click(jira.getByRole('button', { name: 'Write the query yourself (JQL)' }));
    expect((jira.getByLabelText('Tandem picks up issues in') as HTMLInputElement).value).toBe('status = "Ready for AI"');
  });
});

describe('A project’s Jira', () => {
  it('picks the Jira project and finds PMs by name', async () => {
    let saved: Record<string, unknown> = {};
    mockApi({
      'GET /api/bootstrap': boot({ jiraConfigured: true }),
      'GET /api/rules': [],
      'GET /api/jira/projects': { projects: [{ key: 'SHOP', name: 'Shop web' }, { key: 'OPS', name: 'Operations' }] },
      'GET /api/jira/people': (_b: unknown, url: URL) => ({ people: url.searchParams.get('query') === 'pat' ? [{ id: 'acc-pat', name: 'Pat Lee' }] : [] }),
      [`PUT /api/projects/${project.id}`]: (b: unknown) => ((saved = b as Record<string, unknown>), { ...project, ...(b as object) }),
    });
    const user = userEvent.setup();
    renderApp('/projects');
    await user.click(await screen.findByRole('button', { name: 'Edit Shop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Shop' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Jira project' }));
    await user.click(await screen.findByRole('option', { name: /Shop web/ }));
    await user.click(within(dialog).getByRole('radio', { name: /Via Jira replies/ }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Add a PM' }), 'pat');
    await user.click(await within(dialog).findByRole('button', { name: 'Pat Lee' }));
    expect(within(within(dialog).getByRole('list', { name: 'Chosen PMs' })).getByText('Pat Lee')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saved).toMatchObject({ pmGate: 'jira', jiraProjectKey: 'SHOP', jiraPmAccountIds: ['acc-pat'], jiraPmNames: { 'acc-pat': 'Pat Lee' } }));
    expect(saved.jiraJql).toBeUndefined();
  });
});
