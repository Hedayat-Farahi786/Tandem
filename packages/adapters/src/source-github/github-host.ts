import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RetryableError, type DetectedRepo, type MirrorInfo, type PreflightCheck, type PullRequestRequest, type PullRequestResult, type PushResult, type RebaseResult, type SourceHost, type Worktree } from '@tandem/core';
import type { PullRequest, PullRequestStatus, Repo, Settings } from '@tandem/shared';
import { addWorktree, ensureMirror, ghHttpsAccess, plainAccess, pushBranch, rebaseOnto, remoteDefaultBranch, type RemoteAccess } from '../git/repo-git.js';
import type { SecretStore } from '../secrets/keychain.js';

const pexec = promisify(execFile);

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

export interface GitHubHostOptions {
  home: string;
  settings: () => Promise<Settings>;
  secrets: SecretStore;
  fetch?: Fetch;
  /** Token from the GitHub CLI when no token is saved in Settings. */
  ghToken?: (host: string) => Promise<string | undefined>;
}

async function ghCliToken(host: string): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000, windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export class GitHubHost implements SourceHost {
  readonly kind = 'github' as const;
  readonly descriptionLimit = 65_000;

  constructor(private readonly o: GitHubHostOptions) {}

  detect(url: string): DetectedRepo | undefined {
    const p = parseGitHubUrl(url);
    if (!p) return undefined;
    return { host: { kind: 'github', owner: p.owner, name: p.name, ...(p.host !== 'github.com' ? { apiBase: `https://${p.host}/api/v3` } : {}) }, name: p.name, gitUrl: url };
  }

  private ref(repo: Repo): { owner: string; name: string; apiBase: string; webHost: string } {
    if (repo.host.kind !== 'github') throw new Error(`${repo.name} is not a GitHub repo.`);
    const webHost = parseGitHubUrl(repo.url)?.host ?? 'github.com';
    return { owner: repo.host.owner, name: repo.host.name, apiBase: repo.host.apiBase ?? 'https://api.github.com', webHost };
  }

  access(repo: Repo): RemoteAccess {
    return parseGitHubUrl(repo.url)?.transport === 'https' ? ghHttpsAccess(repo.url) : plainAccess(repo.url);
  }

  mirrorPath(repo: Repo): string {
    const { owner, name, webHost } = this.ref(repo);
    return join(this.o.home, 'mirrors', webHost, owner, `${name}.git`);
  }

  private async token(repo: Repo): Promise<string | undefined> {
    return (await this.o.secrets.get('github-token')) ?? (await (this.o.ghToken ?? ghCliToken)(this.ref(repo).webHost));
  }

  private async api<T>(repo: Repo, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token(repo);
    if (!token) throw new Error('No GitHub token: save one in Settings or run gh auth login.');
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

  async preflight(repo: Repo): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    try {
      const b = await remoteDefaultBranch(this.access(repo));
      checks.push({ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'pass', message: `Reachable; default branch ${b ?? 'unknown'}.` });
    } catch (err) {
      checks.push({ id: `read:${repo.id}`, label: `Read ${repo.name}`, status: 'fail', message: String((err as Error).message).split('\n')[0]!, fix: 'Check your SSH key (ssh -T git@github.com) or run gh auth login.' });
    }
    if (!(await this.token(repo))) {
      checks.push({ id: `pr:${repo.id}`, label: 'Create pull requests', status: 'warn', message: 'No GitHub token; Tandem will give you a compare link instead.', fix: 'Run gh auth login, or save a token in Settings.' });
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
    if (!(await this.token(req.repo))) return { kind: 'manual', url: this.compareUrl(req.repo, req.destinationBranch, req.sourceBranch, req.title), reason: 'No GitHub token. Open the link and paste the description Tandem prepared.' };
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
