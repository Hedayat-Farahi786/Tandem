import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { HostKind, ModelOption, PullRequest, PullRequestStatus, Repo, TandemEvent } from '@tandem/shared';
import { BudgetError } from '../budget.js';
import type {
  AgentRuntime,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  AgentUsage,
  Clock,
  DetectedRepo,
  EventSink,
  GitOps,
  Logger,
  MirrorInfo,
  PreflightCheck,
  ProcessResult,
  ProcessRunner,
  PullRequestRequest,
  PullRequestResult,
  PushResult,
  RebaseResult,
  SourceHost,
  Store,
  Tracker,
  TrackerComment,
  TrackerTask,
  Worktree,
} from '../ports.js';

export class FakeClock implements Clock {
  constructor(private t = Date.parse('2026-11-03T09:00:00.000Z')) {}
  now(): number {
    return this.t;
  }
  iso(): string {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class CollectingEvents implements EventSink {
  readonly events: TandemEvent[] = [];
  emit(e: TandemEvent): void {
    this.events.push(e);
  }
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/* ------------------------------------------------------------------ processes */

type FakeResult = Partial<ProcessResult> & { hang?: boolean };

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; cwd: string }> = [];
  /** Command -> result. A function lets a test fail the first run and pass later. */
  /** `hang: true` runs until stopped through the signal (a watch-mode test runner, say). */
  constructor(private readonly results: Record<string, FakeResult | ((n: number) => FakeResult)> = {}) {}
  async runCommand(command: string, opts: { cwd: string; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<ProcessResult> {
    this.calls.push({ command, cwd: opts.cwd });
    const n = this.calls.filter((c) => c.command === command).length;
    const spec = this.results[command];
    const { hang, ...r } = typeof spec === 'function' ? spec(n) : (spec ?? {});
    if (hang) {
      opts.onLine?.('Watching for file changes…');
      await new Promise<void>((resolve) => (opts.signal?.aborted ? resolve() : opts.signal?.addEventListener('abort', () => resolve(), { once: true })));
      return { exitCode: null, timedOut: false, durationMs: 5, stdout: 'Watching for file changes…', stderr: '' };
    }
    const out: ProcessResult = { exitCode: 0, timedOut: false, durationMs: 5, stdout: '', stderr: '', ...r };
    for (const line of `${out.stdout}${out.stderr}`.split('\n').filter(Boolean)) opts.onLine?.(line);
    return out;
  }
}

/* ------------------------------------------------------------------ trackers */

export class FakeTracker implements Tracker {
  /** 'jira' lets a test use the Jira paths (import, PM replies) with this fake. */
  kind: 'local' | 'jira' = 'local';
  readonly comments: TrackerComment[] = [];
  readonly queries: Array<string | undefined> = [];
  readonly transitions: Array<{ key: string; status: string }> = [];
  readonly tasks = new Map<string, TrackerTask>();
  private n = 0;
  constructor(private readonly clock: Clock = new FakeClock()) {}
  async getTask(key: string) {
    return this.tasks.get(key);
  }
  async findReadyTasks(query?: string) {
    this.queries.push(query);
    return [...this.tasks.values()].filter((t) => t.status === 'Ready for AI');
  }
  async comment(key: string, body: string) {
    const c: TrackerComment = { id: `c${++this.n}`, key, authorId: 'tandem', authorName: 'Tandem', body, createdAt: this.clock.iso() };
    this.comments.push(c);
    return { id: c.id, createdAt: c.createdAt };
  }
  async transition(key: string, status: string) {
    this.transitions.push({ key, status });
    return 'moved' as const;
  }
  async readReplies(key: string, since: string, authorIds?: readonly string[]) {
    return this.comments.filter((c) => c.key === key && c.createdAt > since && (!authorIds || authorIds.includes(c.authorId)));
  }
  link(key: string) {
    return `https://tracker.example/${key}`;
  }
  /** Simulates a PM replying on the ticket. */
  reply(key: string, authorId: string, body: string): void {
    this.comments.push({ id: `c${++this.n}`, key, authorId, authorName: authorId, body, createdAt: this.clock.iso() });
  }
}

/* ------------------------------------------------------------------ source host and git */

export interface FakeHostScript {
  rebase?: (repoId: string, n: number) => RebaseResult;
  push?: (repoId: string, n: number) => PushResult;
  openPr?: (req: PullRequestRequest) => PullRequestResult;
  prStatus?: (pr: PullRequest, n: number) => PullRequestStatus;
}

/** Source host that creates real folders (agents write files there) but does no git or network. */
export class FakeSourceHost implements SourceHost {
  readonly descriptionLimit = 10_240;
  readonly opened: PullRequestRequest[] = [];
  readonly pushes: Array<{ repoId: string; forceWithLease?: string }> = [];
  readonly updatedDescriptions: Array<{ prId: string; description: string }> = [];
  private counts = new Map<string, number>();
  constructor(
    readonly kind: HostKind = 'codecommit',
    private readonly script: FakeHostScript = {},
  ) {}
  private count(k: string): number {
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    return n;
  }
  detect(url: string): DetectedRepo | undefined {
    const m = /^fake:\/\/([\w-]+)$/.exec(url);
    return m ? { host: { kind: 'codecommit', region: 'eu-central-1', name: m[1]! }, name: m[1]!, gitUrl: url } : undefined;
  }
  async preflight(): Promise<PreflightCheck[]> {
    return [{ id: 'read', label: 'Read access', status: 'pass', message: 'ok' }];
  }
  async mirror(repo: Repo): Promise<MirrorInfo> {
    return { path: `/mirrors/${repo.name}.git`, defaultBranch: repo.defaultBranch };
  }
  async createWorktree(repo: Repo, opts: { path: string; branch: string; base?: string }): Promise<Worktree> {
    await mkdir(opts.path, { recursive: true });
    return { repoId: repo.id, path: opts.path, branch: opts.branch, base: opts.base ?? `origin/${repo.defaultBranch}` };
  }
  async rebase(repo: Repo): Promise<RebaseResult> {
    return this.script.rebase?.(repo.id, this.count(`rebase:${repo.id}`)) ?? { kind: 'ok', head: `head-${repo.id}` };
  }
  async push(repo: Repo, _wt: Worktree, opts?: { forceWithLease?: string }): Promise<PushResult> {
    this.pushes.push({ repoId: repo.id, ...(opts?.forceWithLease ? { forceWithLease: opts.forceWithLease } : {}) });
    return this.script.push?.(repo.id, this.count(`push:${repo.id}`)) ?? { kind: 'pushed', sha: `sha-${repo.id}-${this.pushes.length}` };
  }
  async openPullRequest(req: PullRequestRequest): Promise<PullRequestResult> {
    this.opened.push(req);
    return this.script.openPr?.(req) ?? { kind: 'created', providerId: `${this.opened.length}`, url: `https://pr.example/${req.repo.name}/${this.opened.length}` };
  }
  async updatePullRequestDescription(_repo: Repo, pr: PullRequest, description: string): Promise<void> {
    this.updatedDescriptions.push({ prId: pr.id, description });
  }
  async getPullRequestStatus(_repo: Repo, pr: PullRequest): Promise<PullRequestStatus> {
    const scripted = this.script.prStatus?.(pr, this.count(`status:${pr.id}`));
    if (scripted) return scripted;
    // Like the real adapters: a fallback PR nobody has created yet stays pending.
    return pr.manual && !pr.providerId ? 'manual-pending' : 'open';
  }
}

export class FakeGit implements GitOps {
  readonly commits: Array<{ worktree: string; message: string }> = [];
  readonly removed: string[] = [];
  conflicts: string[] = [];
  /** Setting it marks every worktree as changed; a commit cleans just its own worktree. */
  private changed = true;
  private readonly clean = new Set<string>();
  get dirty(): boolean {
    return this.changed;
  }
  set dirty(v: boolean) {
    this.changed = v;
    this.clean.clear();
  }
  async status(worktree?: string): Promise<string[]> {
    return this.changed && !(worktree && this.clean.has(worktree)) ? ['M file'] : [];
  }
  async commitAll(worktree: string, message: string): Promise<string | undefined> {
    this.commits.push({ worktree, message });
    this.clean.add(worktree);
    return `commit-${this.commits.length}`;
  }
  /** Files the checks changed (a `lint --fix`, say): set by a test, committed by commitTracked. */
  checksChanged = new Set<string>();
  async commitTracked(worktree: string, message: string): Promise<string | undefined> {
    if (!this.checksChanged.delete(worktree)) return undefined;
    this.commits.push({ worktree, message });
    return `commit-${this.commits.length}`;
  }
  async head(): Promise<string> {
    return `commit-${this.commits.length}`;
  }
  async diff(): Promise<string> {
    return 'diff --git a/src/app.ts b/src/app.ts\n+ added line\n';
  }
  async diffStat() {
    return { files: 1, insertions: 1, deletions: 0 };
  }
  async continueRebase(): Promise<string> {
    this.conflicts = [];
    return 'rebased-head';
  }
  async abortRebase(): Promise<void> {
    this.conflicts = [];
  }
  async conflictedFiles(): Promise<string[]> {
    return this.conflicts;
  }
  async removeWorktree(_repo: Repo, worktree: string): Promise<void> {
    this.removed.push(worktree);
  }
  /** Ancestry answers by "ref|of"; anything not listed is not an ancestor. */
  readonly ancestors = new Set<string>();
  async isAncestor(_repo: Repo, ref: string, of: string): Promise<boolean> {
    return this.ancestors.has(`${ref}|${of}`);
  }
  /** Remote branch heads by "repoId:branch" (what the last fetch saw). */
  readonly remote = new Map<string, string>();
  async remoteHead(repo: Repo, branch: string): Promise<string | undefined> {
    return this.remote.get(`${repo.id}:${branch}`);
  }
  /** Files a merge of the base would conflict in, per worktree (empty: merges cleanly). */
  readonly mergeConflicts = new Map<string, string[]>();
  readonly merges: Array<{ worktree: string; ref: string; message: string }> = [];
  readonly resets: Array<{ worktree: string; ref: string }> = [];
  async probeMerge(worktree: string): Promise<string[]> {
    return [...(this.mergeConflicts.get(worktree) ?? [])];
  }
  async merge(worktree: string, ref: string, message: string): Promise<RebaseResult> {
    this.merges.push({ worktree, ref, message });
    const files = this.mergeConflicts.get(worktree) ?? [];
    if (!files.length) return { kind: 'ok', head: `merge-${this.merges.length}` };
    this.conflicts = [...files];
    return { kind: 'conflict', files: [...files] };
  }
  async continueMerge(): Promise<string> {
    this.conflicts = [];
    return `merge-${this.merges.length}`;
  }
  async abortMerge(): Promise<void> {
    this.conflicts = [];
  }
  async resetTo(worktree: string, ref: string): Promise<void> {
    this.resets.push({ worktree, ref });
    this.conflicts = [];
  }
}

/* ------------------------------------------------------------------ scripted agent */

export interface ScriptCall {
  prompt: string;
  opts: AgentSessionOptions;
  structured: boolean;
  /** Index of this prompt within its session (0-based). */
  turn: number;
}

export interface ScriptReply {
  text?: string;
  /** Value for sendStructured (validated with the caller's schema). */
  value?: unknown;
  /** Files to write, relative to the session workspace. */
  edits?: Array<{ path: string; content: string }>;
  /** Tandem custom tools to call, as the model would. */
  tools?: Array<{ name: string; args: unknown }>;
  /** Throw this instead of answering (to test retries and failures). */
  error?: Error;
  /** What this turn costs (nano-AIU); the scripted agent is free otherwise. */
  nanoAiu?: number;
  /** What the agent says it is doing, and its reasoning (shown in the task's activity). */
  intent?: string;
  reasoning?: string;
  /** Files it reads and searches it runs (reported as steps; nothing is read). */
  reads?: string[];
  searches?: string[];
}

/** Models the scripted agent offers (prices in AI credits per million tokens). Test data only. */
export const SCRIPTED_MODELS: ModelOption[] = [
  { id: 'scripted-swift', name: 'Scripted Swift', vendor: 'Tandem', price: { input: 10, output: 50, cachedInput: 1 }, contextWindow: 272_000, maxOutput: 128_000, vision: false, reasoning: ['low', 'medium', 'high'] },
  { id: 'scripted-steady', name: 'Scripted Steady', vendor: 'Tandem', price: { input: 200, output: 1000, cachedInput: 10 }, contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: ['low', 'medium', 'high', 'max'] },
];

export type Script = (call: ScriptCall) => ScriptReply | Promise<ScriptReply>;

/**
 * Deterministic AgentRuntime: same interface as the Copilot adapter, no network. Used by all
 * workflow tests and the scripted end-to-end runs.
 */
export class ScriptedAgent implements AgentRuntime {
  readonly name = 'scripted';
  readonly calls: ScriptCall[] = [];
  private sessions = 0;
  constructor(
    private readonly script: Script,
    private readonly catalog: ModelOption[] = SCRIPTED_MODELS,
  ) {}

  async models(): Promise<ModelOption[]> {
    return this.catalog;
  }

  async defaultModel(tier: 'light' | 'build'): Promise<string | undefined> {
    return tier === 'light' ? this.catalog[0]?.id : undefined;
  }

  async startSession(opts: AgentSessionOptions): Promise<AgentSession> {
    const id = opts.resumeId ?? `scripted-${++this.sessions}`;
    let turn = 0;
    let spent = 0;
    let cost = 0;
    const usage = (): AgentUsage => ({ model: opts.model ?? 'scripted', modelCalls: 1, nanoAiu: cost });
    const act = async (prompt: string, structured: boolean): Promise<ScriptReply> => {
      const call: ScriptCall = { prompt, opts, structured, turn: turn++ };
      this.calls.push(call);
      const reply = await this.script(call);
      cost = reply.nanoAiu ?? 0;
      spent += cost;
      if (opts.maxNanoAiu !== undefined && spent >= opts.maxNanoAiu && cost > 0) {
        opts.onEvent?.({ type: 'usage', model: opts.model ?? 'scripted', nanoAiu: cost });
        throw Object.assign(new BudgetError('The run reached its credit limit.'), { usage: usage() });
      }
      if (reply.intent) opts.onEvent?.({ type: 'intent', text: reply.intent });
      if (reply.reasoning) opts.onEvent?.({ type: 'reasoning', text: reply.reasoning });
      if (reply.error) throw reply.error;
      let n = 0;
      for (const [tool, list] of [['view', reply.reads ?? []], ['grep', reply.searches ?? []]] as const)
        for (const input of list) {
          const id = `${tool}-${turn}-${n++}`;
          opts.onEvent?.({ type: 'tool-start', id, tool, input });
          opts.onEvent?.({ type: 'tool-end', id, ok: true });
        }
      for (const e of reply.edits ?? []) {
        if (opts.mode !== 'build') throw new Error('scripted agent tried to edit in a read-only session');
        const p = isAbsolute(e.path) ? e.path : join(opts.workspace, e.path);
        const id = `edit-${turn}-${n++}`;
        opts.onEvent?.({ type: 'tool-start', id, tool: 'edit', title: `Edit ${e.path}`, input: e.path });
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, e.content);
        opts.onEvent?.({ type: 'tool-end', id, ok: true, files: [{ kind: 'edit', path: e.path }] });
      }
      for (const t of reply.tools ?? []) {
        const tool = opts.tools?.find((x) => x.name === t.name);
        if (!tool) throw new Error(`scripted agent called unknown tool ${t.name}`);
        const id = `tool-${turn}-${n++}`;
        opts.onEvent?.({ type: 'tool-start', id, tool: t.name, input: JSON.stringify(t.args).slice(0, 300) });
        const out = await tool.handler(tool.schema.parse(t.args) as never);
        opts.onEvent?.({ type: 'tool', tool: t.name, summary: t.name, allowed: true });
        opts.onEvent?.({ type: 'tool-end', id, ok: true, ...(typeof out === 'string' ? { output: out } : {}) });
      }
      if (reply.text) opts.onEvent?.({ type: 'delta', text: reply.text });
      if (reply.text && !structured) opts.onEvent?.({ type: 'message', text: reply.text });
      return reply;
    };
    return {
      id,
      send: async (prompt): Promise<AgentTurn> => {
        const r = await act(prompt, false);
        return { text: r.text ?? 'Done.', usage: usage() };
      },
      sendStructured: async (prompt, schema) => {
        const r = await act(prompt, true);
        return { value: schema.parse(r.value), usage: usage() };
      },
      stop: async () => undefined,
    };
  }
}

/** Convenience: run something inside a store transaction in tests. */
export async function inTx<T>(store: Store, fn: (tx: Store) => Promise<T>): Promise<T> {
  return store.transaction(fn);
}
