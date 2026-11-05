import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@tandem/adapters';
import { readHostedConfig } from '../hosted/server.js';
import { backup, restore } from '../backup.js';

/* Tandem is the web app: on a server, and on one computer to try it or develop it. */
const dir = mkdtempSync(join(tmpdir(), 'tandem-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const GH = { TANDEM_GITHUB_CLIENT_ID: 'Iv1.x', TANDEM_GITHUB_CLIENT_SECRET: 'secret' };

describe('the web app’s settings', () => {
  it('on one computer: localhost on its port, listening on loopback, with a secret key made once and kept', () => {
    const home = join(dir, 'one');
    const cfg = readHostedConfig({ ...GH, TANDEM_HOME: home, TANDEM_PORT: '4317' });
    expect(cfg).toMatchObject({ home, port: 4317, publicUrl: 'http://localhost:4317', listenHost: '127.0.0.1' });
    expect(Buffer.from(cfg.secretKey, 'base64')).toHaveLength(32);
    expect(statSync(join(home, 'secret.key')).mode & 0o777).toBe(0o600);
    // The next start uses the same key.
    expect(readHostedConfig({ ...GH, TANDEM_HOME: home, TANDEM_PORT: '4317' }).secretKey).toBe(cfg.secretKey);
  });

  it('on a server: the public address, a secret key of its own, all interfaces', () => {
    expect(() => readHostedConfig({ ...GH, TANDEM_HOME: join(dir, 'srv'), TANDEM_PUBLIC_URL: 'https://app.example.com' })).toThrow(/TANDEM_SECRET_KEY is required on a server/);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(readHostedConfig({ ...GH, TANDEM_HOME: join(dir, 'srv'), TANDEM_PUBLIC_URL: 'https://app.example.com/', TANDEM_SECRET_KEY: key })).toMatchObject({ publicUrl: 'https://app.example.com', listenHost: '0.0.0.0', secretKey: key });
  });

  it('needs the GitHub App, and says where to make one', () => {
    expect(() => readHostedConfig({ TANDEM_HOME: join(dir, 'gh') })).toThrow(/TANDEM_GITHUB_CLIENT_ID is required \(the GitHub App: Tandem signs people in with GitHub; docs\/DEPLOYMENT\.md section 1/);
  });

  it('backs up the secret key kept on one computer, and restores it owner-only', async () => {
    const home = join(dir, 'kept');
    readHostedConfig({ ...GH, TANDEM_HOME: home });
    (await openDatabase(join(home, 'directory.db'))).close();
    const to = join(dir, 'kept-backup');
    expect((await backup(home, to, 'test')).files).toEqual(['secret.key']);
    const back = join(dir, 'kept-restored');
    restore(to, back);
    expect(readFileSync(join(back, 'secret.key'), 'utf8')).toBe(readFileSync(join(home, 'secret.key'), 'utf8'));
    expect(statSync(join(back, 'secret.key')).mode & 0o777).toBe(0o600);
  });
});
