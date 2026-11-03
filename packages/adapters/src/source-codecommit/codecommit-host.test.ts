import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type PullRequest, type Repo } from '@tandem/shared';
import { RetryableError } from '@tandem/core';
import { RepoGit } from '../git/repo-git.js';
import { CodeCommitHost, consoleCreatePrUrl, consolePrUrl, parseCodeCommitUrl, type CodeCommitApi } from './codecommit-host.js';

const repo: Repo = {
  id: 'r1',
  url: 'codecommit::eu-central-1://hedayat@tandem-sandbox-backend',
  host: { kind: 'codecommit', region: 'eu-central-1', name: 'tandem-sandbox-backend', profile: 'hedayat' },
  name: 'tandem-sandbox-backend',
  defaultBranch: 'main',
  role: 'backend',
  commands: {},
  createdAt: '',
};

function host(send: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown) {
  const calls: Array<{ name: string; input: Record<string, unknown>; region: string; profile: string | undefined }> = [];
  const api = (region: string, profile: string | undefined): CodeCommitApi => ({
    send: async (cmd) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push({ name: c.constructor.name, input: c.input, region, profile });
      return send(c);
    },
  });
  const home = mkdtempSync(join(tmpdir(), 'tandem-cc-'));
  const h = new CodeCommitHost({ home, git: new RepoGit(() => ''), settings: async () => ({ ...DEFAULT_SETTINGS, aws: { profile: 'fallback', region: '' } }), api, sts: api });
  return { h, calls, home };
}

const awsError = (name: string) => Object.assign(new Error(name), { name });
const req = { repo, sourceBranch: 'agent/TND-1-health', destinationBranch: 'main', title: 'TND-1: Health', description: 'd'.repeat(20_000), idempotencyKey: 'task1:r1' };

describe('CodeCommit URLs', () => {
  it('parses SSH, HTTPS and codecommit:: URLs', () => {
    expect(parseCodeCommitUrl('ssh://git-codecommit.eu-central-1.amazonaws.com/v1/repos/my-repo')).toEqual({ region: 'eu-central-1', name: 'my-repo', transport: 'ssh' });
    expect(parseCodeCommitUrl('ssh://APKAEXAMPLE@git-codecommit.us-east-1.amazonaws.com/v1/repos/r.x_y-z/')).toEqual({ region: 'us-east-1', name: 'r.x_y-z', transport: 'ssh' });
    expect(parseCodeCommitUrl('https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/r')).toEqual({ region: 'eu-west-1', name: 'r', transport: 'https' });
    expect(parseCodeCommitUrl('codecommit::eu-central-1://hedayat@app')).toEqual({ region: 'eu-central-1', name: 'app', transport: 'grc', profile: 'hedayat' });
    expect(parseCodeCommitUrl('codecommit::eu-central-1://app')).toEqual({ region: 'eu-central-1', name: 'app', transport: 'grc' });
    expect(parseCodeCommitUrl('git@github.com:o/r.git')).toBeUndefined();
    expect(parseCodeCommitUrl('codecommit::eu-central-1://a/b')).toBeUndefined();
  });

  it('detects repos and normalises git to HTTPS (SSH stays SSH)', () => {
    const { h } = host(() => ({}));
    expect(h.detect('codecommit::eu-central-1://hedayat@app')).toEqual({ host: { kind: 'codecommit', region: 'eu-central-1', name: 'app', profile: 'hedayat' }, name: 'app', gitUrl: 'https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/app' });
    expect(h.detect('ssh://git-codecommit.eu-central-1.amazonaws.com/v1/repos/app')?.gitUrl).toBe('ssh://git-codecommit.eu-central-1.amazonaws.com/v1/repos/app');
    expect(h.detect('https://example.com/x')).toBeUndefined();
  });

  it('builds console links', () => {
    expect(consoleCreatePrUrl('eu-central-1', 'tandem-sandbox-backend', 'main', 'agent/console-link-check')).toBe(
      'https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/tandem-sandbox-backend/pull-requests/new/refs/heads/main/.../refs/heads/agent/console-link-check?region=eu-central-1',
    );
    expect(consolePrUrl('eu-central-1', 'app', '7')).toBe('https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/app/pull-requests/7/details?region=eu-central-1');
  });

  it('uses the AWS CLI credential helper for HTTPS, with the profile from the URL first', async () => {
    const { h } = host(() => ({}));
    const a = await h.access(repo);
    expect(a.gitUrl).toBe('https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/tandem-sandbox-backend');
    expect(a.config).toEqual(['credential.helper=', 'credential.helper=!aws --profile hedayat codecommit credential-helper $@', 'credential.UseHttpPath=true']);
    const viaSettings = await h.access({ ...repo, url: 'https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/x', host: { kind: 'codecommit', region: 'eu-central-1', name: 'x' } });
    expect(viaSettings.config[1]).toContain('--profile fallback');
    expect((await h.access({ ...repo, url: 'ssh://git-codecommit.eu-central-1.amazonaws.com/v1/repos/x' })).config).toEqual([]);
    expect(h.mirrorPath(repo)).toMatch(/mirrors[\\/]codecommit-eu-central-1[\\/]tandem-sandbox-backend\.git$/);
  });
});

describe('CodeCommit pull requests', () => {
  it('creates a PR with a stable idempotency token and trims the description', async () => {
    const { h, calls } = host(() => ({ pullRequest: { pullRequestId: '42' } }));
    const r = await h.openPullRequest(req);
    expect(r).toEqual({ kind: 'created', providerId: '42', url: consolePrUrl('eu-central-1', 'tandem-sandbox-backend', '42') });
    await h.openPullRequest(req);
    const [a, b] = calls;
    expect(a!.name).toBe('CreatePullRequestCommand');
    expect(a!.input.clientRequestToken).toBe(b!.input.clientRequestToken);
    expect(String(a!.input.clientRequestToken)).toHaveLength(64);
    expect(String(a!.input.description)).toHaveLength(10_240);
    expect(a!.input.targets).toEqual([{ repositoryName: 'tandem-sandbox-backend', sourceReference: 'refs/heads/agent/TND-1-health', destinationReference: 'refs/heads/main' }]);
    expect(a!.profile).toBe('hedayat');
  });

  it('falls back to the console link without permission or credentials, and retries when throttled', async () => {
    for (const n of ['AccessDeniedException', 'CredentialsProviderError', 'ExpiredTokenException']) {
      const { h } = host(() => Promise.reject(awsError(n)));
      const r = await h.openPullRequest(req);
      expect(r.kind).toBe('manual');
      expect(r.url).toBe(consoleCreatePrUrl('eu-central-1', 'tandem-sandbox-backend', 'main', 'agent/TND-1-health'));
    }
    const { h } = host(() => Promise.reject(awsError('ThrottlingException')));
    await expect(h.openPullRequest(req)).rejects.toBeInstanceOf(RetryableError);
    const dup = host(() => Promise.reject(awsError('PullRequestAlreadyExistsForSourceAndDestinationException')));
    expect((await dup.h.openPullRequest(req)).kind).toBe('manual');
    const odd = host(() => Promise.reject(awsError('InvalidTitleException')));
    await expect(odd.h.openPullRequest(req)).rejects.toThrow('InvalidTitleException');
  });

  it('maps PR status and updates descriptions', async () => {
    const answers: Record<string, unknown> = {
      '1': { pullRequest: { pullRequestStatus: 'OPEN', pullRequestTargets: [{ mergeMetadata: { isMerged: false } }] } },
      '2': { pullRequest: { pullRequestStatus: 'CLOSED', pullRequestTargets: [{ mergeMetadata: { isMerged: true } }] } },
      '3': { pullRequest: { pullRequestStatus: 'CLOSED', pullRequestTargets: [{ mergeMetadata: { isMerged: false } }] } },
    };
    const { h, calls } = host((c) => (c.constructor.name === 'GetPullRequestCommand' ? answers[String(c.input.pullRequestId)] : {}));
    const pr = (id: string): PullRequest => ({ id: `p${id}`, taskId: 't', repoId: 'r1', providerId: id, url: '', title: '', description: '', status: 'open', manual: false, createdAt: '' });
    expect(await h.getPullRequestStatus(repo, pr('1'))).toBe('open');
    expect(await h.getPullRequestStatus(repo, pr('2'))).toBe('merged');
    expect(await h.getPullRequestStatus(repo, pr('3'))).toBe('closed');
    await h.updatePullRequestDescription(repo, pr('1'), 'x'.repeat(11_000));
    expect(calls.at(-1)).toMatchObject({ name: 'UpdatePullRequestDescriptionCommand', input: { pullRequestId: '1' } });
    expect(String(calls.at(-1)!.input.description)).toHaveLength(10_240);
    await h.updatePullRequestDescription(repo, { ...pr('1'), providerId: undefined } as unknown as PullRequest, 'x');
    expect(calls.filter((c) => c.name === 'UpdatePullRequestDescriptionCommand')).toHaveLength(1);
  });

  it('probes PR permission without creating anything', async () => {
    expect(await host(() => Promise.reject(awsError('ReferenceDoesNotExistException'))).h.canCreatePullRequests(repo)).toBe(true);
    expect(await host(() => Promise.reject(awsError('AccessDeniedException'))).h.canCreatePullRequests(repo)).toBe(false);
    expect(await host(() => Promise.reject(awsError('Weird'))).h.canCreatePullRequests(repo)).toBeUndefined();
  });
});
