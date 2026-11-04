import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CodeCommitClient,
  CreatePullRequestCommand,
  GetPullRequestCommand,
  BatchGetRepositoriesCommand,
  GetRepositoryCommand,
  ListRepositoriesCommand,
  UpdatePullRequestDescriptionCommand,
  UpdatePullRequestTitleCommand,
} from '@aws-sdk/client-codecommit';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { RetryableError, type DetectedRepo, type MirrorInfo, type PreflightCheck, type PullRequestRequest, type PullRequestResult, type PushResult, type RebaseResult, type SourceHost, type Worktree } from '@tandem/core';
import type { PullRequest, PullRequestStatus, Repo, Settings } from '@tandem/shared';
import { runGit } from '../git/git.js';
import type { AwsConnections } from '../aws/aws-connection.js';
import type { RepoChoice } from '../source-github/github-host.js';
import { tandemAccess } from '../git/credential-helper.js';
import { addWorktree, codeCommitHttpsAccess, ensureMirror, localAccess, localGitDir, plainAccess, pushBranch, rebaseOnto, remoteDefaultBranch, type RemoteAccess, type RepoGit } from '../git/repo-git.js';

export interface ParsedCodeCommitUrl {
  region: string;
  name: string;
  transport: 'ssh' | 'https' | 'grc';
  profile?: string;
}

/** SSH, HTTPS and git-remote-codecommit (codecommit::region://[profile@]repo) URLs. */
export function parseCodeCommitUrl(url: string): ParsedCodeCommitUrl | undefined {
  const u = url.trim();
  const ssh = /^ssh:\/\/(?:[^@/]+@)?git-codecommit\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([A-Za-z0-9._-]+?)\/?$/.exec(u);
  if (ssh) return { region: ssh[1]!, name: ssh[2]!, transport: 'ssh' };
  const https = /^https:\/\/git-codecommit\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([A-Za-z0-9._-]+?)\/?$/.exec(u);
  if (https) return { region: https[1]!, name: https[2]!, transport: 'https' };
  const grc = /^codecommit::([a-z0-9-]+):\/\/(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+)$/.exec(u);
  if (grc) return { region: grc[1]!, name: grc[3]!, transport: 'grc', ...(grc[2] ? { profile: grc[2] } : {}) };
  return undefined;
}

export const consoleRepoUrl = (region: string, name: string) => `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${encodeURIComponent(name)}`;

/** Prefilled "Create pull request" page in the CodeCommit console. */
export function consoleCreatePrUrl(region: string, name: string, destination: string, source: string): string {
  const seg = (b: string) => b.split('/').map(encodeURIComponent).join('/');
  return `${consoleRepoUrl(region, name)}/pull-requests/new/refs/heads/${seg(destination)}/.../refs/heads/${seg(source)}?region=${region}`;
}

export const consolePrUrl = (region: string, name: string, id: string) => `${consoleRepoUrl(region, name)}/pull-requests/${id}/details?region=${region}`;

/** The AWS SDK calls this host needs; injectable for tests. */
export interface CodeCommitApi {
  send(command: unknown): Promise<unknown>;
}

export interface CodeCommitHostOptions {
  home: string;
  git: RepoGit;
  settings: () => Promise<Settings>;
  api?: (region: string, profile: string | undefined) => CodeCommitApi;
  sts?: (region: string, profile: string | undefined) => CodeCommitApi;
  /** Test seam: reach a repo through another remote (for example a local bare repo). */
  accessOverride?: (repo: Repo) => RemoteAccess | undefined;
  /** The AWS connection made in Tandem (SSO, access key or profile); used before any profile. */
  aws?: AwsConnections;
  /** Tandem's git credential helper, once the server runs: signs HTTPS git with the AWS connection. */
  gitHelper?: () => string | undefined;
  /** False in hosted mode: never the machine's AWS profiles, default credentials or SSH keys. */
  ambient?: boolean;
}

const errName = (err: unknown) => (err as { name?: string })?.name ?? '';
const THROTTLED = /Throttling|TooManyRequests|ServiceUnavailable|RequestTimeout|InternalServerError|ECONNRESET|ETIMEDOUT/;
const NO_CREDS = /CredentialsProviderError|ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|TokenProviderError|SSO|ValidationException|AccessDenied/;

export class CodeCommitHost implements SourceHost {
  readonly kind = 'codecommit' as const;
  readonly descriptionLimit = 10_240;

  constructor(private readonly o: CodeCommitHostOptions) {}

  detect(url: string): DetectedRepo | undefined {
    const p = parseCodeCommitUrl(url);
    if (!p) return undefined;
    return { host: { kind: 'codecommit', region: p.region, name: p.name, ...(p.profile ? { profile: p.profile } : {}) }, name: p.name, gitUrl: p.transport === 'ssh' ? url : `https://git-codecommit.${p.region}.amazonaws.com/v1/repos/${p.name}` };
  }

  private ref(repo: Repo): { region: string; name: string; profile: string | undefined } {
    if (repo.host.kind !== 'codecommit') throw new Error(`${repo.name} is not a CodeCommit repo.`);
    return { region: repo.host.region, name: repo.host.name, profile: repo.host.profile };
  }

  private async profile(repo: Repo): Promise<string | undefined> {
    const s = await this.o.settings();
    return this.ref(repo).profile || s.aws.profile || undefined;
  }

  /**
   * SSH URLs use the user's ~/.ssh config. HTTPS is signed by Tandem from the AWS connection made in
   * the app (no AWS CLI); without the Tandem server (the terminal doctor), by the AWS CLI.
   */
  async access(repo: Repo): Promise<RemoteAccess> {
    const override = this.o.accessOverride?.(repo);
    if (override) return override;
    const hosted = this.o.ambient === false;
    if (repo.localPath && !hosted) return localAccess(repo.url);
    const { region, name } = this.ref(repo);
    if (parseCodeCommitUrl(repo.url)?.transport === 'ssh' && !hosted) return plainAccess(repo.url);
    const helper = this.o.gitHelper?.();
    if (helper) return tandemAccess(`https://git-codecommit.${region}.amazonaws.com/v1/repos/${name}`, helper);
    return codeCommitHttpsAccess(region, name, await this.profile(repo));
  }

  /** AWS credentials: the connection made in Tandem, else the repo's or Settings' profile, else the default chain. */
  private async credentials(repo: Repo) {
    if (await this.o.aws?.connection()) return this.o.aws!.provider();
    if (this.o.ambient === false) return this.o.aws!.provider(); // says "Connect AWS"
    const profile = await this.profile(repo);
    return profile ? fromIni({ profile }) : fromNodeProviderChain();
  }

  mirrorPath(repo: Repo): string {
    if (repo.localPath && this.o.ambient !== false) return localGitDir(repo.localPath);
    const { region, name } = this.ref(repo);
    return join(this.o.home, 'mirrors', `codecommit-${region}`, `${name}.git`);
  }

  private async api(repo: Repo): Promise<CodeCommitApi> {
    const { region } = this.ref(repo);
    const profile = await this.profile(repo);
    if (this.o.api) return this.o.api(region, profile);
    return new CodeCommitClient({ region, credentials: await this.credentials(repo) });
  }

  /** The CodeCommit repositories in a region, with the AWS connection made in the app (or the profile). */
  async listRepositories(region: string): Promise<RepoChoice[]> {
    const probe = { id: 'probe', url: `codecommit::${region}://probe`, host: { kind: 'codecommit', region, name: 'probe' }, name: 'probe', defaultBranch: '', role: 'other', commands: {}, createdAt: '' } as unknown as Repo;
    const api = this.o.api ? this.o.api(region, await this.profile(probe)) : new CodeCommitClient({ region, credentials: await this.credentials(probe) });
    const names: string[] = [];
    let next: string | undefined;
    do {
      const r = (await api.send(new ListRepositoriesCommand({ sortBy: 'lastModifiedDate', order: 'descending', ...(next ? { nextToken: next } : {}) }))) as { repositories?: Array<{ repositoryName?: string }>; nextToken?: string };
      for (const x of r.repositories ?? []) if (x.repositoryName) names.push(x.repositoryName);
      next = r.nextToken;
    } while (next && names.length < 1000);
    const out: RepoChoice[] = [];
    for (let i = 0; i < names.length; i += 25) {
      const r = (await api.send(new BatchGetRepositoriesCommand({ repositoryNames: names.slice(i, i + 25) }))) as { repositories?: Array<{ repositoryName?: string; repositoryDescription?: string; lastModifiedDate?: Date; defaultBranch?: string }> };
      const byName = new Map((r.repositories ?? []).map((x) => [x.repositoryName, x]));
      for (const n of names.slice(i, i + 25)) {
        const x = byName.get(n);
        out.push({ id: `${region}/${n}`, name: n, url: `codecommit::${region}://${n}`, description: x?.repositoryDescription ?? '', updatedAt: x?.lastModifiedDate ? new Date(x.lastModifiedDate).toISOString() : '', defaultBranch: x?.defaultBranch ?? '' });
      }
    }
    return out;
  }

  async preflight(repo: Repo): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    const access = await this.access(repo);
    try {
      const b = await remoteDefaultBranch(access);
      checks.push({ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'pass', message: `Reachable; default branch ${b ?? 'unknown (empty repo?)'}.` });
    } catch (err) {
      checks.push({ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'fail', message: String((err as Error).message).split('\n')[0]!, fix: parseCodeCommitUrl(repo.url)?.transport === 'ssh' ? 'Check the SSH key ID in ~/.ssh/config and that the key is uploaded to your IAM user.' : 'Connect AWS again in Settings › AWS (your sign-in may have expired).' });
    }
    const { region } = this.ref(repo);
    const profile = await this.profile(repo);
    try {
      const sts = this.o.sts ? this.o.sts(region, profile) : new STSClient({ region, credentials: await this.credentials(repo) });
      await sts.send(new GetCallerIdentityCommand({}));
      checks.push({ id: `aws:${repo.id}`, label: 'AWS credentials', status: 'pass', message: `Signed in${profile ? ` with profile ${profile}` : ''}.` });
    } catch (err) {
      checks.push({ id: `aws:${repo.id}`, label: 'AWS credentials', status: 'warn', message: `No working AWS credentials${profile ? ` for profile ${profile}` : ''} (${errName(err) || 'error'}).`, fix: 'Connect AWS in Settings › AWS. Without it, pull requests use the console link.' });
      return checks;
    }
    const can = await this.canCreatePullRequests(repo);
    checks.push(
      can === true
        ? { id: `pr:${repo.id}`, label: 'Create pull requests', status: 'pass', message: 'Your AWS profile can create pull requests.' }
        : { id: `pr:${repo.id}`, label: 'Create pull requests', status: 'warn', message: can === false ? 'Your AWS profile cannot create pull requests; Tandem will give you a console link instead.' : 'Could not check pull request permission.', fix: 'Ask for codecommit:CreatePullRequest, or create PRs from the console link Tandem shows.' },
    );
    return checks;
  }

  /** Probe without side effects: a CreatePullRequest from a ref that doesn't exist. */
  async canCreatePullRequests(repo: Repo): Promise<boolean | undefined> {
    const { name } = this.ref(repo);
    try {
      await (await this.api(repo)).send(
        new CreatePullRequestCommand({ title: 'Tandem permission probe', targets: [{ repositoryName: name, sourceReference: `refs/heads/tandem-probe-${Date.now()}-does-not-exist`, destinationReference: `refs/heads/${repo.defaultBranch}` }] }),
      );
      return true; // should not happen; the ref does not exist
    } catch (err) {
      const n = errName(err);
      if (n === 'ReferenceDoesNotExistException') return true;
      if (/AccessDenied/.test(n)) return false;
      return undefined;
    }
  }

  async mirror(repo: Repo): Promise<MirrorInfo> {
    let branch = repo.defaultBranch || undefined;
    if (!branch) {
      try {
        const r = (await (await this.api(repo)).send(new GetRepositoryCommand({ repositoryName: this.ref(repo).name }))) as { repositoryMetadata?: { defaultBranch?: string } };
        branch = r.repositoryMetadata?.defaultBranch;
      } catch {
        // fall back to git
      }
    }
    return ensureMirror(this.mirrorPath(repo), await this.access(repo), branch);
  }

  async createWorktree(repo: Repo, opts: { path: string; branch: string; base?: string; detach?: boolean }): Promise<Worktree> {
    const base = opts.base ?? `origin/${repo.defaultBranch}`;
    await addWorktree(this.mirrorPath(repo), { path: opts.path, branch: opts.branch, base, ...(opts.detach ? { detach: true } : {}) });
    return { repoId: repo.id, path: opts.path, branch: opts.branch, base };
  }

  async rebase(repo: Repo, wt: Worktree): Promise<RebaseResult> {
    return rebaseOnto(wt.path, `origin/${repo.defaultBranch}`);
  }

  async push(_repo: Repo, wt: Worktree, opts?: { forceWithLease?: string }): Promise<PushResult> {
    const r = await pushBranch(wt.path, wt.branch, opts?.forceWithLease);
    return r.ok ? { kind: 'pushed', sha: r.sha } : { kind: 'rejected', message: r.message };
  }

  async openPullRequest(req: PullRequestRequest): Promise<PullRequestResult> {
    const { region, name } = this.ref(req.repo);
    const manual = (reason: string): PullRequestResult => ({ kind: 'manual', url: consoleCreatePrUrl(region, name, req.destinationBranch, req.sourceBranch), reason });
    try {
      const token = createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 64);
      const r = (await (await this.api(req.repo)).send(
        new CreatePullRequestCommand({
          title: req.title.slice(0, 150),
          description: req.description.slice(0, this.descriptionLimit),
          targets: [{ repositoryName: name, sourceReference: `refs/heads/${req.sourceBranch}`, destinationReference: `refs/heads/${req.destinationBranch}` }],
          clientRequestToken: token,
        }),
      )) as { pullRequest?: { pullRequestId?: string } };
      const id = r.pullRequest?.pullRequestId;
      if (!id) return manual('CodeCommit did not return a pull request id.');
      return { kind: 'created', providerId: id, url: consolePrUrl(region, name, id) };
    } catch (err) {
      const n = errName(err);
      if (THROTTLED.test(n)) throw new RetryableError(`CodeCommit is busy (${n}).`);
      if (NO_CREDS.test(n) || /credentials|Could not load/i.test(String(err))) return manual(`Your AWS profile can't create pull requests (${n || 'no credentials'}). Create it from the console link with the title and description Tandem prepared.`);
      if (n === 'PullRequestAlreadyExistsForSourceAndDestinationException' || n === 'IdempotencyParameterMismatchException') return manual(`A pull request for ${req.sourceBranch} already exists (${n}). Paste its link in Tandem.`);
      throw err;
    }
  }

  async updatePullRequestDescription(repo: Repo, pr: PullRequest, description: string, title?: string): Promise<void> {
    if (!pr.providerId) return;
    const api = await this.api(repo);
    await api.send(new UpdatePullRequestDescriptionCommand({ pullRequestId: pr.providerId, description: description.slice(0, this.descriptionLimit) }));
    if (title && title !== pr.title) await api.send(new UpdatePullRequestTitleCommand({ pullRequestId: pr.providerId, title }));
  }

  async getPullRequestStatus(repo: Repo, pr: PullRequest): Promise<PullRequestStatus> {
    if (pr.providerId) {
      try {
        const r = (await (await this.api(repo)).send(new GetPullRequestCommand({ pullRequestId: pr.providerId }))) as { pullRequest?: { pullRequestStatus?: string; pullRequestTargets?: Array<{ mergeMetadata?: { isMerged?: boolean } }> } };
        const merged = r.pullRequest?.pullRequestTargets?.every((t) => t.mergeMetadata?.isMerged) ?? false;
        if (merged) return 'merged';
        return r.pullRequest?.pullRequestStatus === 'CLOSED' ? 'closed' : 'open';
      } catch (err) {
        if (THROTTLED.test(errName(err))) throw new RetryableError(`CodeCommit is busy (${errName(err)}).`);
        if (!pr.manual) throw err;
      }
    }
    // Manual fallback without API access: merged when the branch tip is on the default branch.
    const mirror = this.mirrorPath(repo);
    await runGit(['fetch', '--prune', '--no-tags', 'origin'], { gitDir: mirror, allowFail: true });
    const branch = /refs\/heads\/((?:agent|feature)\/[^?]+)/.exec(decodeURIComponent(pr.url))?.[1];
    if (!branch) return pr.status;
    const tip = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { gitDir: mirror, allowFail: true });
    if (tip.code !== 0) return pr.status;
    const merged = await runGit(['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, `refs/remotes/origin/${repo.defaultBranch}`], { gitDir: mirror, allowFail: true });
    return merged.code === 0 ? 'merged' : pr.status;
  }
}
