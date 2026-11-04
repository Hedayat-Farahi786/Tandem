import { join } from 'node:path';
import { RetryableError, type DetectedRepo, type MirrorInfo, type PreflightCheck, type PullRequestRequest, type PullRequestResult, type PushResult, type RebaseResult, type SourceHost, type Worktree } from '@tandem/core';
import type { PullRequest, PullRequestStatus, Repo, Settings } from '@tandem/shared';
import { tandemAccess } from '../git/credential-helper.js';
import { addWorktree, ensureMirror, localAccess, localGitDir, plainAccess, pushBranch, rebaseOnto, remoteDefaultBranch, type RemoteAccess } from '../git/repo-git.js';
import type { SecretStore } from '../secrets/keychain.js';


const isGitHubHost = (h: string) => /github/i.test(h) || /\.ghe\.com$/i.test(h);

export function parseGitHubUrl(url: string): { owner: string; name: string; transport: 'ssh' | 'https'; host: string } | undefined {
  const u = url.trim();
  const scp = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (scp && isGitHubHost(scp[1]!)) return { host: scp[1]!, owner: scp[2]!, name: scp[3]!, transport: 'ssh' };
  const ssh = /^ssh:\/\/git@([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (ssh && isGitHubHost(ssh[1]!)) return { host: ssh[1]!, owner: ssh[2]!, name: ssh[3]!, transport: 'ssh' };
  const https = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (https && isGitHubHost(https[1]!)) return { host: https[1]!, owner: https[2]!, name: https[3]!, transport: 'https' };
  return undefined;
}

export type { Fetch } from '../tracker-jira/jira-tracker.js';
import type { Fetch } from '../tracker-jira/jira-tracker.js';

/** A repository someone can pick to add: on GitHub or CodeCommit. */
export interface RepoChoice {
  id: string;
  name: string;
  owner?: string;
  url: string;
  description: string;
  updatedAt: string;
  defaultBranch: string;
  private?: boolean;
  canPush?: boolean;
}

export interface GitHubHostOptions {
  home: string;
  settings: () => Promise<Settings>;
  secrets: SecretStore;
  fetch?: Fetch;
  /** The token of the GitHub account connected in Tandem (the Copilot sign-in) for this host. */
  accountToken?: (host: string) => Promise<string | undefined>;
  /** Tandem's git credential helper, once the server runs (HTTPS clone, fetch and push). */
  gitHelper?: () => string | undefined;
}

/** The REST API of a GitHub host: github.com, GitHub Enterprise Cloud (api.<tenant>.ghe.com) or a server (/api/v3). */
export function githubApiBase(host: string): string {
  if (host === 'github.com') return 'https://api.github.com';
  if (/\.ghe\.com$/i.test(host)) return `https://api.${host}`;
  return `https://${host}/api/v3`;
}

export class GitHubHost implements SourceHost {
  readonly kind = 'github' as const;
  readonly descriptionLimit = 65_000;

  constructor(private readonly o: GitHubHostOptions) {}

  detect(url: string): DetectedRepo | undefined {
    const p = parseGitHubUrl(url);
    if (!p) return undefined;
    return { host: { kind: 'github', owner: p.owner, name: p.name, ...(p.host !== 'github.com' ? { apiBase: githubApiBase(p.host) } : {}) }, name: p.name, gitUrl: url };
  }

  private ref(repo: Repo): { owner: string; name: string; apiBase: string; webHost: string } {
    if (repo.host.kind !== 'github') throw new Error(`${repo.name} is not a GitHub repo.`);
    const webHost = parseGitHubUrl(repo.url)?.host ?? 'github.com';
    return { owner: repo.host.owner, name: repo.host.name, apiBase: repo.host.apiBase ?? 'https://api.github.com', webHost };
  }

  /** HTTPS through Tandem's helper (the connected account's token); SSH with the user's own keys. */
  access(repo: Repo): RemoteAccess {
    if (repo.localPath) return localAccess(repo.url);
    const helper = this.o.gitHelper?.();
    return parseGitHubUrl(repo.url)?.transport === 'https' && helper ? tandemAccess(repo.url, helper) : plainAccess(repo.url);
  }

  mirrorPath(repo: Repo): string {
    if (repo.localPath) return localGitDir(repo.localPath);
    const { owner, name, webHost } = this.ref(repo);
    return join(this.o.home, 'mirrors', webHost, owner, `${name}.git`);
  }

  private async token(repo: Repo): Promise<string | undefined> {
    return (await this.o.accountToken?.(this.ref(repo).webHost)) ?? (await this.o.secrets.get('github-token'));
  }

  private async api<T>(repo: Repo, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token(repo);
    if (!token) throw new Error('No GitHub account is connected for this repository. Connect it in Settings › Copilot, or save a token in Settings › GitHub.');
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    const res = await f(`${this.ref(repo).apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tandem', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`GitHub returned ${res.status}.`);
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * The repositories the connected account can work in on a host, most recently pushed first: its
   * own, its organizations' and those it collaborates on. Undefined when no account is connected.
   */
  async listRepositories(host = 'github.com'): Promise<RepoChoice[] | undefined> {
    const token = await this.o.accountToken?.(host);
    if (!token) return undefined;
    const f = this.o.fetch ?? (globalThis.fetch as unknown as Fetch);
    const out: RepoChoice[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await f(`${githubApiBase(host)}/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tandem' },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(res.status === 401 ? 'GitHub no longer accepts the connected account. Connect it again in Settings › Copilot.' : `GitHub returned ${res.status} listing your repositories.`);
      const list = JSON.parse(text) as Array<{ full_name: string; name: string; owner: { login: string }; private: boolean; archived?: boolean; description?: string | null; pushed_at?: string; default_branch?: string; clone_url: string; permissions?: { push?: boolean } }>;
      for (const r of list) {
        if (r.archived) continue;
        out.push({ id: r.full_name, name: r.name, owner: r.owner.login, url: r.clone_url, description: r.description ?? '', updatedAt: r.pushed_at ?? '', defaultBranch: r.default_branch ?? '', private: r.private, canPush: r.permissions?.push !== false });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  async preflight(repo: Repo): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    try {
      const b = await remoteDefaultBranch(this.access(repo));
      checks.push({ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'pass', message: `Reachable; default branch ${b ?? 'unknown'}.` });
    } catch (err) {
      checks.push({ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'fail', message: String((err as Error).message).split('\n')[0]!, fix: parseGitHubUrl(repo.url)?.transport === 'https' ? 'Connect the GitHub account that can see this repository in Settings › Copilot.' : 'Check your SSH key (ssh -T git@github.com), or use the HTTPS clone URL.' });
    }
    if (!(await this.token(repo))) {
      checks.push({ id: `pr:${repo.id}`, label: 'Create pull requests', status: 'warn', message: 'No GitHub account connected for this host; Tandem will give you a compare link instead.', fix: 'Connect your GitHub account in Settings › Copilot.' });
    } else {
      try {
        const { owner, name } = this.ref(repo);
        const r = await this.api<{ permissions?: { push?: boolean } }>(repo, 'GET', `/repos/${owner}/${name}`);
        checks.push({ id: `pr:${repo.id}`, label: 'Create pull requests', status: r.permissions?.push ? 'pass' : 'warn', message: r.permissions?.push ? 'Token can push and open pull requests.' : 'Token has no push permission on this repo.' });
      } catch (err) {
        checks.push({ id: `pr:${repo.id}`, label: 'Create pull requests', status: 'warn', message: String((err as Error).message) });
      }
    }
    return checks;
  }

  async mirror(repo: Repo): Promise<MirrorInfo> {
    return ensureMirror(this.mirrorPath(repo), this.access(repo), repo.defaultBranch || undefined);
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

  compareUrl(repo: Repo, base: string, head: string, title: string): string {
    const { owner, name, webHost } = this.ref(repo);
    return `https://${webHost}/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1&title=${encodeURIComponent(title)}`;
  }

  async openPullRequest(req: PullRequestRequest): Promise<PullRequestResult> {
    const { owner, name } = this.ref(req.repo);
    if (!(await this.token(req.repo))) return { kind: 'manual', url: this.compareUrl(req.repo, req.destinationBranch, req.sourceBranch, req.title), reason: 'No GitHub account connected. Open the link and paste the description Tandem prepared.' };
    // Idempotent: reuse an existing PR for this branch (for example after a restart).
    const existing = await this.api<Array<{ number: number; html_url: string }>>(req.repo, 'GET', `/repos/${owner}/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${req.sourceBranch}`)}`);
    if (existing[0]) return { kind: 'created', providerId: String(existing[0].number), url: existing[0].html_url };
    try {
      const pr = await this.api<{ number: number; html_url: string }>(req.repo, 'POST', `/repos/${owner}/${name}/pulls`, { title: req.title, head: req.sourceBranch, base: req.destinationBranch, body: req.description.slice(0, this.descriptionLimit), maintainer_can_modify: true });
      return { kind: 'created', providerId: String(pr.number), url: pr.html_url };
    } catch (err) {
      if ((err as { status?: number }).status === 403 || (err as { status?: number }).status === 404) {
        return { kind: 'manual', url: this.compareUrl(req.repo, req.destinationBranch, req.sourceBranch, req.title), reason: `GitHub refused to create the pull request (${(err as Error).message}). Open the link instead.` };
      }
      throw err;
    }
  }

  async updatePullRequestDescription(repo: Repo, pr: PullRequest, description: string, title?: string): Promise<void> {
    if (!pr.providerId) return;
    const { owner, name } = this.ref(repo);
    await this.api(repo, 'PATCH', `/repos/${owner}/${name}/pulls/${pr.providerId}`, { body: description.slice(0, this.descriptionLimit), ...(title && title !== pr.title ? { title } : {}) });
  }

  async getPullRequestStatus(repo: Repo, pr: PullRequest): Promise<PullRequestStatus> {
    if (!pr.providerId) return pr.status;
    const { owner, name } = this.ref(repo);
    const r = await this.api<{ state: string; merged_at: string | null }>(repo, 'GET', `/repos/${owner}/${name}/pulls/${pr.providerId}`);
    if (r.merged_at) return 'merged';
    return r.state === 'closed' ? 'closed' : 'open';
  }
}
