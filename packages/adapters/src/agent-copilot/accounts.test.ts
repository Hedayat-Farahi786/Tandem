import { describe, expect, it } from 'vitest';
import { RuntimeAccounts, hostName, settingsHost, type AccountClientLike, type AccountSessionLike } from './accounts.js';

type Step = { kind: string; url?: string; prompt?: string; message?: string; result?: { status: string; host?: string; login?: string; accounts?: Array<{ selectionId: string; host: string; login: string }> } };

/** A pretend runtime: a scripted list of login steps, and a record of what Tandem asked for. */
function fakeRuntime(steps: Step[], users: Array<{ type: string; host: string; login: string; id: string }> = []) {
  const calls: string[] = [];
  const hosts: string[] = [];
  let current = users[0];
  const session: AccountSessionLike = {
    rpc: {
      accounts: {
        enumerate: async () => ({ kind: 'providers', items: [{ kind: 'githubDotCom', label: 'GitHub.com', available: true }, { kind: 'proxima', label: 'GitHub Enterprise Cloud (*.ghe.com)', available: true }, { kind: 'entra', label: 'Microsoft Entra', available: false }] }),
        set: async (p) => {
          calls.push(`set:${p.command.kind}:${'selectionId' in p.command ? p.command.selectionId : ''}`);
          if (p.command.kind === 'switchActive') current = users.find((u) => u.id === (p.command as { selectionId: string }).selectionId);
          return { ok: true };
        },
        login: {
          begin: async (p) => {
            calls.push(`begin:${p.kind}`);
            return { flowId: 'flow1', step: steps.shift()! };
          },
          advance: async (p) => {
            calls.push(`advance:${p.input ?? ''}`);
            return steps.shift()!;
          },
          cancel: async () => {
            calls.push('cancel');
          },
        },
      },
    },
    disconnect: async () => {
      calls.push('disconnect');
    },
  };
  const client: AccountClientLike = {
    rpc: {
      account: {
        getAllUsers: async () => users.map((u) => ({ authInfo: { type: u.type, host: u.host, login: u.login }, selectionId: u.id, token: 'secret-token' }) as never),
        getCurrentAuth: async () => (current ? { authInfo: { type: current.type, host: current.host, login: current.login } } : {}),
        login: async (p) => {
          calls.push(`token-login:${p.host}`);
          return { storedInVault: true };
        },
      },
    },
    createSession: async () => session,
  };
  const accounts = new RuntimeAccounts({ client: async () => client, useHost: async (h) => void hosts.push(settingsHost(h)) });
  return { accounts, calls, hosts };
}

describe('Copilot accounts', () => {
  it('names hosts the way people write them', () => {
    expect(hostName('https://Acme.ghe.com/')).toBe('acme.ghe.com');
    expect(hostName('https://github.com')).toBe('github.com');
    expect(hostName('')).toBe('github.com');
    expect(settingsHost('https://github.com')).toBe('');
    expect(settingsHost('acme.ghe.com')).toBe('acme.ghe.com');
  });

  it('lists the signed-in accounts and which one Tandem uses, never their tokens', async () => {
    const { accounts } = fakeRuntime([], [
      { type: 'user', host: 'https://github.com', login: 'mona', id: 's1' },
      { type: 'gh-cli', host: 'https://acme.ghe.com', login: 'mona_acme', id: 's2' },
    ]);
    const s = await accounts.state();
    expect(s.signedIn).toBe(true);
    expect(s.active).toMatchObject({ login: 'mona', host: 'github.com', source: 'copilot' });
    expect(s.accounts.map((a) => [a.login, a.host, a.source, a.active])).toEqual([
      ['mona', 'github.com', 'copilot', true],
      ['mona_acme', 'acme.ghe.com', 'gh', false],
    ]);
    expect(s.providers.map((p) => p.kind)).toEqual(['githubDotCom', 'proxima', 'entra']);
    expect(JSON.stringify(s)).not.toContain('secret-token');
  });

  it('signs in with a company GitHub: asks for the address, opens GitHub, then keeps the host', async () => {
    const { accounts, calls, hosts } = fakeRuntime([
      { kind: 'input-required', prompt: 'Enter your GitHub Enterprise Cloud host' },
      { kind: 'open-url', url: 'https://acme.ghe.com/login/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A40123%2Fcallback' },
      { kind: 'completed', result: { status: 'completed', host: 'https://acme.ghe.com', login: 'mona_acme' } },
    ]);
    const b = await accounts.begin('proxima');
    expect(b.step).toEqual({ kind: 'input-required', prompt: 'Enter your GitHub Enterprise Cloud host' });
    const open = await accounts.advance(b.flowId, 'https://acme.ghe.com');
    expect(open.kind).toBe('open-url');
    // A paste is checked against the sign-in's own local callback: nothing else is fetched.
    expect(await accounts.finishWithUrl(b.flowId, 'https://evil.example/callback?code=1')).toMatchObject({ kind: 'error' });
    expect(await accounts.finishWithUrl(b.flowId, 'http://127.0.0.1:9999/callback?code=1')).toMatchObject({ kind: 'error' });
    expect(await accounts.advance(b.flowId)).toEqual({ kind: 'done', login: 'mona_acme', host: 'acme.ghe.com' });
    expect(hosts).toEqual(['acme.ghe.com']);
    expect(calls).toEqual(['begin:proxima', 'advance:https://acme.ghe.com', 'advance:', 'disconnect']);
  });

  it('asks which account to use when the sign-in offers several', async () => {
    const { accounts } = fakeRuntime([
      { kind: 'open-url', url: 'https://github.com/login/oauth/authorize?x=1' },
      { kind: 'completed', result: { status: 'needs-account-selection', accounts: [{ selectionId: 'p1', host: 'https://github.com', login: 'mona' }] } },
      { kind: 'completed', result: { status: 'completed', host: 'https://github.com', login: 'mona' } },
    ]);
    const b = await accounts.begin('githubDotCom');
    expect(await accounts.advance(b.flowId)).toEqual({ kind: 'choose-account', accounts: [{ id: 'p1', login: 'mona', host: 'github.com' }] });
    expect(await accounts.advance(b.flowId, 'p1')).toMatchObject({ kind: 'done', login: 'mona' });
  });

  it('does not keep a sign-in in plain text when there is no keychain', async () => {
    const { accounts, calls } = fakeRuntime([
      { kind: 'open-url', url: 'https://github.com/login/oauth/authorize?x=1' },
      { kind: 'completed', result: { status: 'needs-plaintext-consent' } },
    ]);
    const b = await accounts.begin('githubDotCom');
    const step = await accounts.advance(b.flowId);
    expect(step.kind).toBe('error');
    expect(step.kind === 'error' && step.message).toMatch(/keychain/);
    expect(calls).toContain('cancel');
  });

  it('takes a fine-grained token, refuses a classic one, and switches and signs out by id', async () => {
    const { accounts, calls, hosts } = fakeRuntime([], [
      { type: 'user', host: 'https://github.com', login: 'mona', id: 's1' },
      { type: 'user', host: 'https://acme.ghe.com', login: 'mona_acme', id: 's2' },
    ]);
    await expect(accounts.signInWithToken('github.com', 'ghp_abcdefghijklmnopqrstuvwxyz')).rejects.toThrow(/Classic tokens/);
    await expect(accounts.signInWithToken('github.com', 'not-a-token-at-all-really')).rejects.toThrow(/fine-grained/);
    expect(await accounts.signInWithToken('https://acme.ghe.com', 'github_pat_abcdefghijklmnopqrstuvwxyz')).toMatchObject({ host: 'acme.ghe.com', saved: true });
    await accounts.switchTo('s2');
    expect(hosts).toEqual(['acme.ghe.com', 'acme.ghe.com']);
    await accounts.signOut('s1');
    expect(calls).toEqual(expect.arrayContaining(['token-login:https://acme.ghe.com', 'set:switchActive:s2', 'set:logout:s1']));
  });
});
