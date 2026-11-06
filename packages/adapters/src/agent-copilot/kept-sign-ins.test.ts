import { describe, expect, it } from 'vitest';
import { MemorySecrets } from '../secrets/keychain.js';
import { RuntimeAccounts, keptSignIns, restoreSignIns, type AccountClientLike } from './accounts.js';

/** A runtime without a keychain: it accepts sign-ins but cannot save them, and forgets them when it restarts. */
function forgetfulRuntime() {
  let users: Array<{ host: string; login: string; token: string }> = [];
  let current: { host: string; login: string } | undefined;
  const logins: string[] = [];
  const client: AccountClientLike = {
    rpc: {
      account: {
        getAllUsers: async () => users.map((u, i) => ({ authInfo: { type: 'user', host: u.host, login: u.login }, selectionId: `s${i}`, token: u.token })),
        getCurrentAuth: async () => (current ? { authInfo: { type: 'user', host: current.host, login: current.login } } : {}),
        login: async (p) => {
          const login = p.token.includes('work') ? 'mona_work' : 'mona';
          logins.push(`${p.host}:${login}`);
          users = [...users.filter((u) => u.host !== p.host), { host: p.host, login, token: p.token }];
          current = { host: p.host, login };
          return { storedInVault: false };
        },
      },
    },
    createSession: async () => ({ rpc: { accounts: { set: async () => ({ ok: true }) } }, disconnect: async () => undefined }),
  };
  return {
    client,
    logins,
    restart() {
      users = [];
      current = undefined;
    },
    current: () => current,
  };
}

describe('Copilot sign-ins on a computer without a keychain', () => {
  it('keeps the sign-in sealed and hands it back after every restart, the active host last', async () => {
    const rt = forgetfulRuntime();
    const store = new MemorySecrets();
    const kept = keptSignIns(store);
    let host = '';
    const accounts = new RuntimeAccounts({ client: async () => rt.client, useHost: async (h) => void (host = h), kept });

    const work = await accounts.signInWithToken('https://acme.ghe.com', 'gho_work-token');
    expect(work).toEqual({ host: 'acme.ghe.com', login: 'mona_work', saved: true });
    await accounts.signInWithToken('github.com', 'gho_personal-token');
    expect(await kept.list()).toEqual([
      { host: 'acme.ghe.com', login: 'mona_work', token: 'gho_work-token' },
      { host: 'github.com', login: 'mona', token: 'gho_personal-token' },
    ]);

    // The runtime restarts (a new host, or Tandem itself) and has forgotten both.
    rt.restart();
    rt.logins.length = 0;
    expect(await restoreSignIns(rt.client, kept, 'acme.ghe.com')).toBe(2);
    expect(rt.logins).toEqual(['https://github.com:mona', 'https://acme.ghe.com:mona_work']);
    expect(rt.current()).toEqual({ host: 'https://acme.ghe.com', login: 'mona_work' });
    // Nothing to do while the runtime still knows them.
    expect(await restoreSignIns(rt.client, kept, 'acme.ghe.com')).toBe(0);
    expect(host).toBe('github.com');
  });

  it('forgets a kept sign-in when the account signs out', async () => {
    const rt = forgetfulRuntime();
    const kept = keptSignIns(new MemorySecrets());
    const accounts = new RuntimeAccounts({ client: async () => rt.client, useHost: async () => undefined, kept });
    await accounts.signInWithToken('acme.ghe.com', 'gho_work-token');
    await accounts.signOut('s0');
    expect(await kept.list()).toEqual([]);
  });

  it('says the sign-in was not kept when there is nowhere to keep it', async () => {
    const rt = forgetfulRuntime();
    const accounts = new RuntimeAccounts({ client: async () => rt.client, useHost: async () => undefined });
    expect((await accounts.signInWithToken('acme.ghe.com', 'gho_work-token')).saved).toBe(false);
  });
});
