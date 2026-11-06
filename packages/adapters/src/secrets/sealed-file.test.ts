import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecrets } from './keychain.js';
import { SealedFileSecrets, localSecrets } from './sealed-file.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('secrets on a computer without a keychain', () => {
  it('seals each value with this computer\'s key, owner-only, and never in plain text', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tandem-sealed-'));
    const s = new SealedFileSecrets(dir);
    expect((await s.available()).ok).toBe(true);
    await s.set('copilot-sign-ins', 'gho_very-secret-token');
    await s.set('runner-key', 'tdr_key');
    expect(await s.get('copilot-sign-ins')).toBe('gho_very-secret-token');
    const file = readFileSync(join(dir, 'secrets.sealed.json'), 'utf8');
    expect(file).not.toContain('very-secret');
    expect(file).not.toContain('tdr_key');
    expect(statSync(join(dir, 'secrets.sealed.json')).mode & 0o077).toBe(0);
    expect(statSync(join(dir, 'secret.key')).mode & 0o077).toBe(0);
    // Another start reads them back with the same key.
    expect(await new SealedFileSecrets(dir).get('runner-key')).toBe('tdr_key');
    await s.delete('runner-key');
    expect(await s.get('runner-key')).toBeUndefined();
    expect(await s.get('copilot-sign-ins')).toBe('gho_very-secret-token');
  });

  it('does not open with another computer\'s key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tandem-sealed-'));
    await new SealedFileSecrets(dir).set('jira-token', 'abc');
    const other = mkdtempSync(join(tmpdir(), 'tandem-sealed-other-'));
    try {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(join(dir, 'secrets.sealed.json'), join(other, 'secrets.sealed.json'));
      expect(await new SealedFileSecrets(other).get('jira-token')).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('uses the system keychain when there is one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tandem-sealed-'));
    const keychain = new MemorySecrets();
    expect(await localSecrets(dir, keychain)).toBe(keychain);
    const none = { ...keychain, available: async () => ({ ok: false, message: 'no keychain' }) } as unknown as MemorySecrets;
    expect(await localSecrets(dir, none)).toBeInstanceOf(SealedFileSecrets);
  });
});
