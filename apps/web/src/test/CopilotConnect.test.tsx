import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boot, catalog, settings } from './fixtures';
import { asCompanyRunner, mockApi, renderApp } from './helpers';

const providers = [
  { kind: 'githubDotCom', label: 'GitHub.com', available: true },
  { kind: 'proxima', label: 'GitHub Enterprise Cloud (*.ghe.com)', available: true },
  { kind: 'entra', label: 'Your organization (Microsoft Entra)', available: false },
];
const routes = (accounts: object, over: Record<string, object> = {}) => ({
  'GET /api/bootstrap': boot(),
  'GET /api/settings': settings,
  'GET /api/secrets': { keychain: { ok: true }, jiraToken: false, githubToken: false },
  'GET /api/usage': { today: 0, perDay: 40, perTask: 15, credits: { today: 0, perDay: 75, perTask: 25 }, last30Days: { prompts: 0, modelCalls: 0, aiCredits: 0 } },
  'GET /api/copilot/models': catalog,
  'GET /api/copilot/accounts': accounts,
  ...over,
});

// Signing in to Copilot happens on a company runner's computer; in the cloud, a member's plan is used.
describe('Connecting Copilot on a company runner', () => {
  let leave: () => void;
  beforeEach(() => void (leave = asCompanyRunner()));
  afterEach(() => leave());

  it('signs in with GitHub.com in the browser, from Settings', async () => {
    let signedIn = false;
    let polls = 0;
    mockApi(
      routes(() => (signedIn ? { signedIn: true, active: { id: 'a1', login: 'mona', host: 'github.com', active: true, source: 'copilot' }, accounts: [{ id: 'a1', login: 'mona', host: 'github.com', active: true, source: 'copilot' }], providers, host: 'github.com' } : { signedIn: false, accounts: [], providers, host: 'github.com' }), {
        'POST /api/copilot/sign-in': { flowId: 'f1', step: { kind: 'open-url', url: 'https://github.com/login/oauth/authorize?client_id=x' } },
        'POST /api/copilot/sign-in/f1/next': () => {
          polls++;
          if (polls < 2) return { kind: 'awaiting' };
          signedIn = true;
          return { kind: 'done', login: 'mona', host: 'github.com' };
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/settings');
    // Not connected: one button per kind of account, and a token for machines without a browser.
    await user.click(await screen.findByRole('button', { name: /GitHub\.com/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to GitHub' });
    const open = await within(dialog).findByRole('link', { name: /Open GitHub/ });
    expect(open.getAttribute('href')).toBe('https://github.com/login/oauth/authorize?client_id=x');
    expect(open.getAttribute('target')).toBe('_blank');
    await user.click(open);
    expect(await within(dialog).findByText('Copilot is connected', {}, { timeout: 3000 })).toBeTruthy();
    expect(within(dialog).getByText('mona')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    // Connected: who Tandem works as.
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText(/github\.com · Signed in with Copilot/)).toBeTruthy();
  });

  it("asks for the company's GitHub address first", async () => {
    let sent: unknown;
    mockApi(
      routes({ signedIn: false, accounts: [], providers, host: 'github.com' }, {
        'POST /api/copilot/sign-in': { flowId: 'f2', step: { kind: 'input-required', prompt: 'Enter your GitHub Enterprise Cloud host' } },
        'POST /api/copilot/sign-in/f2/next': (b: unknown) => ((sent = b), { kind: 'open-url', url: 'https://acme.ghe.com/login/oauth/authorize?x=1' }),
        'DELETE /api/copilot/sign-in/f2': { ok: true },
      }),
    );
    const user = userEvent.setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: /Your company's GitHub/ }));
    const dialog = await screen.findByRole('dialog', { name: "Sign in to your company's GitHub" });
    await user.type(within(dialog).getByLabelText("Your company's GitHub address"), 'acme.ghe.com');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sent).toEqual({ input: 'https://acme.ghe.com' }));
    expect((await within(dialog).findByRole('link', { name: /Open GitHub/ })).getAttribute('href')).toBe('https://acme.ghe.com/login/oauth/authorize?x=1');
  });

  it('switches to another signed-in account and connects with a token', async () => {
    let used = '';
    let token: unknown;
    const both = [
      { id: 'a1', login: 'mona', host: 'github.com', active: true, source: 'copilot' },
      { id: 'a2', login: 'mona_acme', host: 'acme.ghe.com', active: false, source: 'gh' },
    ];
    mockApi(
      routes({ signedIn: true, active: both[0], accounts: both, providers, host: 'github.com' }, {
        'POST /api/copilot/accounts/a2/use': () => ((used = 'a2'), { signedIn: true, active: { ...both[1], active: true }, accounts: both, providers }),
        'POST /api/copilot/token': (b: unknown) => ((token = b), { login: 'mona', host: 'github.com', saved: true }),
      }),
    );
    const user = userEvent.setup();
    renderApp('/settings');
    expect(await screen.findByText('Also signed in')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use this account' }));
    await waitFor(() => expect(used).toBe('a2'));
    expect(await screen.findByText('Tandem now uses mona_acme.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Add another account/ }));
    await user.click(screen.getByRole('button', { name: 'Use a token instead' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect with a token' });
    expect(within(dialog).getByRole('link', { name: /Fine-grained tokens/ }).getAttribute('href')).toBe('https://github.com/settings/personal-access-tokens/new');
    await user.type(within(dialog).getByLabelText('Token'), 'github_pat_abcdefghijklmnopqrstuvwxyz');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(token).toEqual({ host: 'github.com', token: 'github_pat_abcdefghijklmnopqrstuvwxyz' }));
  });
});
