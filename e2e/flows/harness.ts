/**
 * End-to-end harness: the real Tandem server as a child process (so a restart can be a real
 * kill -9), driven over HTTP the way the web app drives it, with the scripted agent instead of
 * Copilot.
 *
 * Remotes:
 *   local (default)       bare repos seeded from spikes/sandbox, served in place of CodeCommit.
 *   real (TANDEM_E2E_REAL=1) the sandbox repos on CodeCommit. Each run works against its own base
 *                         branch e2e/<run> made from main, so main is never written to; agent
 *                         branches and PRs target that base branch and stay for review.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REAL = process.env.TANDEM_E2E_REAL === '1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'apps', 'server', 'dist', 'cli.js');
const REGION = process.env.TANDEM_AWS_REGION || 'eu-central-1';
const PROFILE = process.env.TANDEM_AWS_PROFILE ?? '';
const PREFIX = process.env.TANDEM_E2E_REPO_PREFIX ?? 'tandem-sandbox';

export type Shape = 'fullstack' | 'backend' | 'frontend';
export const repoName = (shape: Shape) => `${PREFIX}-${shape}`;

export interface Approval {
  name: string;
  role: string;
  specVersion: number;
}
export interface Pr {
  id: string;
  repoId: string;
  url: string;
  title: string;
  description: string;
  status: string;
  manual: boolean;
  providerId?: string;
}
export interface Detail {
  task: {
    id: string;
    key: string;
    title: string;
    state: string;
    step?: string;
    branch: string;
    source: string;
    parentTaskId?: string;
    blockedReason?: string;
    blockedMessage?: string;
    needsAttention: boolean;
    attentionNotes: string[];
    model?: string;
    sizeEstimate?: { estimatedLines: number; proposedSplit: Array<{ title: string }> };
  };
  spec: { version: number; markdown: string } | null;
  specs: Array<{ version: number; source: string }>;
  specCheck: { valid: boolean; problems: string[]; openQuestions: string[] } | null;
  approvalState: { owner?: Approval; pm?: Approval; complete: boolean } | null;
  transitions: Array<{ from: string; to: string; reason: string; actor: string }>;
  verifyRuns: Array<{ passed: boolean; results: Array<{ kind: string; exitCode: number | null }> }>;
  tests: Array<{ criterion: number; result: string; file: string }>;
  prs: Pr[];
  repos: Array<{ id: string; name: string }>;
  runs: Array<{ kind: string; status: string }>;
  findings: Array<{ severity: string; title: string; status: string }>;
  usage: { prompts: number; modelCalls: number; aiCredits: number };
}
export interface TandemEvent {
  type: string;
  taskId?: string;
  to?: string;
  step?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HarnessOptions {
  /** 'copilot' runs the real agent and costs AI credits: only with the owner's go-ahead. */
  agent?: 'scripted' | 'copilot';
  /** Extra environment for the server (limits, model defaults). */
  env?: Record<string, string>;
}

export class Harness {
  constructor(private readonly o: HarnessOptions = {}) {}
  readonly runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
  readonly work = process.env.TANDEM_E2E_DIR ?? mkdtempSync(join(tmpdir(), 'tandem-flows-'));
  readonly home = join(this.work, 'home');
  readonly remotes = join(this.work, 'remotes');
  readonly port = Number(process.env.TANDEM_E2E_PORT ?? 4410);
  readonly url = `http://127.0.0.1:${this.port}`;
  readonly base = REAL ? `e2e/${this.runId}` : 'main';
  readonly events: TandemEvent[] = [];
  readonly logFile = join(this.work, 'server.log');
  /** PRs opened during the run, for the evidence file. */
  readonly results: Array<{ scenario: string; task: string; state: string; prs: Array<{ repo: string; url: string; status: string }> } & Record<string, unknown>> = [];
  private proc: ChildProcess | undefined;
  private token = '';
  private sse: AbortController | undefined;
  starts = 0;

  /* ------------------------------------------------------------------ remotes */

  private git(args: string[], cwd?: string): string {
    const auth = REAL ? ['-c', 'credential.helper=', '-c', `credential.helper=!aws codecommit credential-helper ${PROFILE ? `--profile ${PROFILE} ` : ''}$@`, '-c', 'credential.UseHttpPath=true'] : [];
    return execFileSync('git', [...auth, ...args], { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString();
  }

  /** Where the harness itself pushes (upstream changes from "another developer"). */
  remoteUrl(shape: Shape): string {
    return REAL ? `https://git-codecommit.${REGION}.amazonaws.com/v1/repos/${repoName(shape)}` : pathToFileURL(join(this.remotes, `${repoName(shape)}.git`)).href;
  }

  async prepareRemotes(shapes: Shape[]): Promise<void> {
    mkdirSync(this.remotes, { recursive: true });
    for (const shape of shapes) {
      const seed = join(this.work, 'seed', shape);
      rmSync(seed, { recursive: true, force: true });
      const src = join(ROOT, 'spikes', 'sandbox', shape);
      const copyTemplate = () => cpSync(src, seed, { recursive: true, filter: (p) => !/[\\/](node_modules|dist|coverage)([\\/]|$)/.test(p.slice(src.length)) });
      if (REAL) {
        // A run branch from main with the current sandbox template: everything this run does
        // targets it, and main is never written to.
        this.git(['clone', '--quiet', this.remoteUrl(shape), seed]);
        copyTemplate();
        this.git(['add', '-A'], seed);
        if (this.git(['status', '--porcelain'], seed).trim()) this.git(['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.com', 'commit', '--quiet', '-m', 'Current sandbox template'], seed);
        this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${this.base}`], seed);
        continue;
      }
      const bare = join(this.remotes, `${repoName(shape)}.git`);
      this.git(['init', '--quiet', '--bare', bare]);
      this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
      this.git(['clone', '--quiet', pathToFileURL(bare).href, seed]);
      this.git(['checkout', '--quiet', '-b', 'main'], seed);
      copyTemplate();
      this.git(['add', '-A'], seed);
      this.git(['-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.com', 'commit', '--quiet', '-m', `seed ${shape}`], seed);
      this.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed);
    }
  }

  /** Another developer changes the base branch: edit one file, commit, push. */
  upstream(shape: Shape, file: string, edit: (src: string | undefined) => string | null, message: string): void {
    const dir = join(this.work, 'upstream', `${shape}-${Date.now()}`);
    this.git(['clone', '--quiet', '--branch', this.base, this.remoteUrl(shape), dir]);
    const path = join(dir, file);
    const next = edit(existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    if (next === null) rmSync(path);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next);
    }
    this.git(['add', '-A'], dir);
    this.git(['-c', 'user.name=Upstream Dev', '-c', 'user.email=dev@example.com', 'commit', '--quiet', '-m', message], dir);
    this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${this.base}`], dir);
    rmSync(dir, { recursive: true, force: true });
  }

  /** A file as pushed to a branch on the remote. */
  remoteFile(shape: Shape, branch: string, file: string): string {
    const dir = join(this.work, 'peek', `${shape}-${Date.now()}`);
    this.git(['clone', '--quiet', '--depth', '1', '--branch', branch, this.remoteUrl(shape), dir]);
    try {
      return readFileSync(join(dir, file), 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Branch names on the remote (to check what was pushed, and that main was not). */
  remoteBranches(shape: Shape): Map<string, string> {
    const out = this.git(['ls-remote', '--heads', this.remoteUrl(shape)]);
    return new Map(
      out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, ref] = l.split('\t');
          return [ref!.replace('refs/heads/', ''), sha!] as const;
        }),
    );
  }

  /* ------------------------------------------------------------------ server process */

  async start(): Promise<void> {
    if (!existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) throw new Error('Build first: pnpm build');
    const log = openSync(this.logFile, 'a');
    const copilot = this.o.agent === 'copilot';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TANDEM_AGENT: copilot ? 'copilot' : 'scripted',
      TANDEM_HOME: this.home,
      TANDEM_PORT: String(this.port),
      TANDEM_LOG_LEVEL: 'info',
      // The scripted agent counts against the prompt budget like Copilot; this suite needs more than a day's default.
      ...(copilot ? {} : { TANDEM_BUDGET_PER_DAY: '5000', TANDEM_BUDGET_PER_TASK: '200' }),
      ...(REAL ? { TANDEM_AWS_REGION: REGION, ...(PROFILE ? { TANDEM_AWS_PROFILE: PROFILE } : {}) } : { TANDEM_TEST_REMOTE_ROOT: this.remotes }),
      ...this.o.env,
    };
    if (REAL) delete env.TANDEM_TEST_REMOTE_ROOT;
    this.proc = spawn(process.execPath, [CLI, 'start', '--no-open'], { env, stdio: ['ignore', log, log], detached: process.platform !== 'win32' });
    closeSync(log);
    this.starts++;
    const end = Date.now() + 60_000;
    for (;;) {
      try {
        if ((await fetch(`${this.url}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (this.proc.exitCode !== null) throw new Error(`Tandem exited (${this.proc.exitCode}).\n${this.logTail()}`);
      if (Date.now() > end) throw new Error(`Tandem did not start.\n${this.logTail()}`);
      await sleep(200);
    }
    const html = await (await fetch(`${this.url}/`)).text();
    this.token = /<meta name="tandem-token" content="([^"]+)">/.exec(html)?.[1] ?? '';
    if (!this.token) throw new Error('No token in the served page.');
    this.listen();
  }

  private listen(): void {
    this.sse?.abort();
    const ctl = new AbortController();
    this.sse = ctl;
    void (async () => {
      const res = await fetch(`${this.url}/api/events`, { signal: ctl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (data) this.events.push(JSON.parse(data) as TandemEvent);
        }
      }
    })().catch(() => undefined);
  }

  /** A crash: SIGKILL to the server and everything it started (git, npm). */
  kill(): void {
    this.sse?.abort();
    const p = this.proc;
    if (!p?.pid || p.exitCode !== null) return;
    try {
      if (process.platform === 'win32') p.kill('SIGKILL');
      else process.kill(-p.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }

  async stop(): Promise<void> {
    this.sse?.abort();
    const p = this.proc;
    if (!p?.pid || p.exitCode !== null) return;
    const exited = new Promise((r) => p.once('exit', r));
    try {
      if (process.platform === 'win32') p.kill('SIGTERM');
      else process.kill(-p.pid, 'SIGTERM');
    } catch {
      return;
    }
    await Promise.race([exited, sleep(15_000)]);
    this.kill();
  }

  /** Removes a workspace the harness made for itself (keep it with TANDEM_E2E_DIR or TANDEM_E2E_KEEP=1). */
  cleanup(): void {
    if (process.env.TANDEM_E2E_DIR || process.env.TANDEM_E2E_KEEP === '1') return;
    rmSync(this.work, { recursive: true, force: true, maxRetries: 3 });
  }

  logTail(lines = 40): string {
    return existsSync(this.logFile) ? readFileSync(this.logFile, 'utf8').split('\n').slice(-lines).join('\n') : '';
  }

  /* ------------------------------------------------------------------ API */

  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Tandem-Token': this.token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text && (res.headers.get('content-type') ?? '').includes('json') ? (JSON.parse(text) as unknown) : text;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(data as { error?: string }).error ?? text}`);
    return data as T;
  }

  /** Adds a sandbox repo the way the setup wizard does: detect, then confirm (on the run's base branch). */
  async addRepo(shape: Shape): Promise<{ id: string; name: string; role: string }> {
    const url = `codecommit::${REGION}://${repoName(shape)}`;
    const detected = await this.api<{ repo: Record<string, unknown> & { role: string } }>('POST', '/api/repos/detect', { url });
    const role = shape === 'fullstack' ? 'full-stack' : shape;
    if (detected.repo.role !== role) throw new Error(`Detected role ${detected.repo.role} for ${shape}`);
    return this.api('POST', '/api/repos', { ...detected.repo, defaultBranch: this.base });
  }

  async project(name: string, repoIds: string[], keyPrefix: string): Promise<{ id: string; name: string }> {
    return this.api('POST', '/api/projects', { name, repoIds, pmGate: 'tandem', pmNames: ['Pat Lee'], keyPrefix });
  }

  /** Request mode: sends each message in turn; returns the replies and whether the draft was ready after each. */
  async request(projectId: string, messages: string[], threadId?: string, model?: string): Promise<{ threadId: string; replies: string[]; ready: boolean[] }> {
    const id = threadId ?? (await this.api<{ id: string }>('POST', '/api/threads', { projectId, mode: 'request', ...(model ? { model } : {}) })).id;
    const replies: string[] = [];
    const ready: boolean[] = [];
    for (const text of messages) {
      const r = await this.api<{ message: { content: string }; readiness?: { ready: boolean } }>('POST', `/api/threads/${id}/messages`, { text });
      replies.push(r.message.content);
      ready.push(r.readiness?.ready ?? false);
    }
    return { threadId: id, replies, ready };
  }

  detail(taskId: string): Promise<Detail> {
    return this.api<Detail>('GET', `/api/tasks/${taskId}`);
  }

  /** Polls the task until `done` holds. A FAILED task, or a block `done` doesn't expect, fails fast. */
  async waitFor(taskId: string, what: string, done: (d: Detail) => boolean, o: { ms?: number; allowBlocked?: boolean } = {}): Promise<Detail> {
    const end = Date.now() + (o.ms ?? 300_000);
    let last: Detail | undefined;
    while (Date.now() < end) {
      try {
        last = await this.detail(taskId);
      } catch (err) {
        if (!String(err).includes('fetch failed')) throw err;
      }
      if (last) {
        if (done(last)) return last;
        const t = last.task;
        if (t.state === 'FAILED' || (t.state === 'BLOCKED' && !o.allowBlocked)) throw new Error(`${t.key} is ${t.state} (${t.blockedReason ?? ''}) while waiting for ${what}: ${t.blockedMessage ?? ''}\n${this.logTail(20)}`);
      }
      await sleep(400);
    }
    throw new Error(`Timed out waiting for ${what}; last state ${last?.task.state}/${last?.task.step}.\n${this.logTail(20)}`);
  }

  async approveBoth(taskId: string): Promise<void> {
    await this.api('POST', `/api/tasks/${taskId}/approve`, {});
    await this.api('POST', `/api/tasks/${taskId}/pm-approval`, { name: 'Pat Lee', date: new Date().toISOString(), evidence: 'Approved in the planning channel' });
  }

  record(scenario: string, d: Detail, extra: Record<string, unknown> = {}): void {
    this.results.push({ scenario, task: d.task.key, state: d.task.state, prs: d.prs.map((p) => ({ repo: d.repos.find((r) => r.id === p.repoId)?.name ?? p.repoId, url: p.url, status: p.status })), ...extra });
    writeFileSync(join(this.work, 'results.json'), JSON.stringify({ mode: REAL ? 'real' : 'local', base: this.base, results: this.results }, null, 2));
  }
}
