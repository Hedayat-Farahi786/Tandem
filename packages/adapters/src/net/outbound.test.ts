import { afterEach, describe, expect, it } from 'vitest';
import { GitHubHost } from '../source-github/github-host.js';
import { MemorySecrets } from '../secrets/keychain.js';
import { DEFAULT_SETTINGS } from '@tandem/shared';
import { JiraTracker } from '../tracker-jira/jira-tracker.js';
import { checkOutbound, isPrivateAddress, restrictOutbound } from './outbound.js';

afterEach(() => restrictOutbound(false));

describe("Tandem's cloud reaches public services only", () => {
  it('tells private and internal addresses from public ones', () => {
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.3.4', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['140.82.112.3', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses http, credentials in the address, and names that lead inside', async () => {
    await expect(checkOutbound('http://169.254.169.254/latest/meta-data')).resolves.toBeUndefined();
    restrictOutbound(true);
    await expect(checkOutbound('http://jira.example.com')).rejects.toThrow(/only over https/);
    await expect(checkOutbound('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private or internal/);
    await expect(checkOutbound('https://[::1]:8080/')).rejects.toThrow(/private or internal/);
    await expect(checkOutbound('https://localhost/')).rejects.toThrow(/private or internal/);
    await expect(checkOutbound('https://user:pw@example.com/')).rejects.toThrow(/no user name/);
    await expect(checkOutbound('https://1.1.1.1/')).resolves.toBeUndefined();
  });

  it('keeps Jira from being pointed at the metadata service', async () => {
    restrictOutbound(true);
    let called = false;
    const jira = new JiraTracker({ baseUrl: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/x?', email: 'a@b.c', token: 't', fetch: async () => ((called = true), new Response('{}')) as never });
    await expect(jira.myself()).rejects.toThrow(/private or internal/);
    expect(called).toBe(false);
  });

  it('adds GitHub.com and GitHub Enterprise Cloud repositories only', () => {
    const cloud = new GitHubHost({ home: '/nonexistent', settings: async () => DEFAULT_SETTINGS, secrets: new MemorySecrets(), ambient: false });
    expect(cloud.detect('https://github.com/acme/shop.git')?.name).toBe('shop');
    expect(cloud.detect('https://acme.ghe.com/acme/shop.git')?.name).toBe('shop');
    expect(() => cloud.detect('https://github.internal.acme.local/acme/shop.git')).toThrow(/GitHub Enterprise Server, use a company runner/);
    expect(() => cloud.detect('https://github.169.254.169.254.nip.io/a/b.git')).toThrow(/not github\.169/);
    // The local app and company runners use whatever GitHub their computer reaches.
    const local = new GitHubHost({ home: '/nonexistent', settings: async () => DEFAULT_SETTINGS, secrets: new MemorySecrets() });
    expect(local.detect('https://github.internal.acme.local/acme/shop.git')?.name).toBe('shop');
  });
});
