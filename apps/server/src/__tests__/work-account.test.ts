import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CopilotAccounts, SignInStep } from '@tandem/adapters';
import { Directory } from '../hosted/directory.js';
import { GitHubTokens, WorkspaceAccounts, WorkspaceSecrets } from '../hosted/workspace.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A workspace with one member (Mona, whose own GitHub account has no Copilot plan). */
async function workspace() {
  dir = mkdtempSync(join(tmpdir(), 'tandem-work-'));
  const directory = await Directory.open(join(dir, 'directory.db'), randomBytes(32).toString('base64'));
  const mona = await directory.upsertGitHubUser({ id: 1, login: 'mona', name: 'Mona Lisa' });
  await directory.saveGitHubTokens(mona.id, { access: 'ghu_mona' });
  const ws = await directory.createWorkspace('Shop', mona.id);
  const tokens = new GitHubTokens(directory, { clientId: 'Iv1.test', clientSecret: 's', webUrl: 'https://github.example' });
  // The company's GitHub answers who the work token belongs to.
  const asked: string[] = [];
  const http = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    asked.push(`${String(url)} ${init?.headers?.Authorization ?? ''}`);
    return new Response(JSON.stringify({ login: 'mona-work' }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const secrets = new WorkspaceSecrets(directory, ws.id);
  const accounts = new WorkspaceAccounts(directory, ws.id, tokens, secrets, http);
  return { directory, ws, mona, accounts, secrets, asked };
}

/** The runtime's code sign-in, pretend: a host to enter, a code, then GitHub's token. */
function codeSignIn(onToken: (host: string, token: string) => Promise<unknown>): CopilotAccounts & { kinds: string[] } {
  const kinds: string[] = [];
  let host = '';
  return {
    kinds,
    begin: async (kind) => {
      kinds.push(kind);
      return { flowId: 'f1', step: { kind: 'input-required', prompt: 'host?' } };
    },
    advance: async (_id, input): Promise<SignInStep> => {
      if (input) {
        host = input.replace('https://', '');
        return { kind: 'device-code', code: 'WDJB-MJHT', url: `https://${host}/login/device`, expiresAt: '' };
      }
      await onToken(host, 'gho_work-token');
      return { kind: 'done', login: 'mona-work', host, saved: true };
    },
  } as CopilotAccounts & { kinds: string[] };
}

describe('a work Copilot account in a cloud workspace', () => {
  it('signs in with a code, keeps the account sealed for the workspace, and works as it', async () => {
    const { accounts, mona, secrets, asked } = await workspace();
    // Before: Copilot would run on Mona's own GitHub sign-in.
    expect(await accounts.identity()).toMatchObject({ token: 'ghu_mona', host: 'github.com' });
    expect((await accounts.state()).providers).toEqual([]);

    const runtime = codeSignIn((h, t) => accounts.keepWork(h, t));
    accounts.useCodeSignIn(runtime);
    expect((await accounts.state()).providers.map((p) => p.kind)).toEqual(['proxima', 'githubDotCom']);

    const b = await accounts.begin('proxima');
    expect(b.step.kind).toBe('input-required');
    expect(await accounts.advance(b.flowId, 'https://acme.ghe.com')).toMatchObject({ kind: 'device-code', url: 'https://acme.ghe.com/login/device' });
    expect(await accounts.advance(b.flowId)).toMatchObject({ kind: 'done', host: 'acme.ghe.com' });

    // Named as the company's GitHub names it, through its own API.
    expect(asked).toEqual(['https://api.acme.ghe.com/user Bearer gho_work-token']);
    expect(await accounts.state()).toMatchObject({ signedIn: true, active: { id: 'work', login: 'mona-work', host: 'acme.ghe.com' } });
    expect(await accounts.identity()).toEqual({ token: 'gho_work-token', host: 'acme.ghe.com', login: 'mona-work' });
    expect(await accounts.tokenFor('https://acme.ghe.com')).toBe('gho_work-token');
    expect(await accounts.tokenFor('github.com')).toBe('ghu_mona');
    // Sealed in the directory, never as plain text.
    expect(await secrets.get('copilot-work')).toContain('gho_work-token');

    // Disconnected: back on Mona's plan.
    await accounts.signOut('work');
    expect(await accounts.identity()).toMatchObject({ token: 'ghu_mona', host: 'github.com' });
    expect((await accounts.state()).active).toMatchObject({ id: mona.id, login: 'mona' });
  });

  it('keeps the work token sealed: the database never holds it in plain text', async () => {
    const { directory, accounts } = await workspace();
    await accounts.keepWork('acme.ghe.com', 'gho_never-plain');
    const raw = JSON.stringify(await (directory as unknown as { sql: { all(q: string): Promise<unknown[]> } }).sql.all('SELECT * FROM workspace_secrets'));
    expect(raw).not.toContain('gho_never-plain');
  });

  it('says plainly when no code sign-in is available, and refuses Microsoft Entra', async () => {
    const { accounts } = await workspace();
    await expect(accounts.begin('proxima')).rejects.toThrow(/needs the Copilot runtime/);
    accounts.useCodeSignIn(codeSignIn(async () => undefined));
    await expect(accounts.begin('entra')).rejects.toThrow(/company's GitHub/);
  });
});
