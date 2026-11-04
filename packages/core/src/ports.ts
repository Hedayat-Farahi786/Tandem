/**
 * Ports: the only way core reaches the outside world. Adapters implement these; core never
 * imports an adapter, an SDK, a database driver or child_process.
 */
import type { ZodType } from 'zod';
import type {
  AgentRun,
  Approval,
  ChatMessage,
  ChatThread,
  CriterionTest,
  HostKind,
  HostRef,
  ModelOption,
  Project,
  PullRequest,
  PullRequestStatus,
  Repo,
  ReviewFinding,
  Rule,
  Settings,
  SpecVersion,
  TandemEvent,
  Task,
  TaskState,
  TaskTransition,
  UsageRecord,
  VerifyRun,
  AuditEntry,
  AuditInput,
  AgentStep,
} from '@tandem/shared';

/* ================================================================== storage */

export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  upsert(item: T): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TaskScoped<T extends { id: string; taskId: string }> {
  get(id: string): Promise<T | undefined>;
  list(taskId: string): Promise<T[]>;
  upsert(item: T): Promise<void>;
}

export interface Job {
  taskId: string;
  state: TaskState;
  step: string;
  status: 'queued' | 'running';
  attempt: number;
  /** Epoch ms; the job is not run before this. */
  notBefore: number;
  leaseBootId?: string;
  lastError?: string;
}

export interface TrackerComment {
  id: string;
  key: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

/**
 * Repository layer. Async so a Postgres implementation can replace SQLite. All writes made inside
 * `transaction` commit or roll back together; use only the `tx` store inside the callback.
 */
export interface Store {
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  projects: Collection<Project>;
  repos: Collection<Repo>;
  tasks: Collection<Task> & {
    getByKey(key: string): Promise<Task | undefined>;
    listByState(states: readonly TaskState[]): Promise<Task[]>;
    /** Next free number for a key prefix (TND -> TND-1, TND-2, ...). */
    nextSeq(prefix: string): Promise<number>;
  };
  transitions: { add(t: Omit<TaskTransition, 'id'>): Promise<TaskTransition>; list(taskId: string): Promise<TaskTransition[]> };
  specs: { add(v: SpecVersion): Promise<void>; list(taskId: string): Promise<SpecVersion[]>; latest(taskId: string): Promise<SpecVersion | undefined> };
  approvals: TaskScoped<Approval>;
  runs: Collection<AgentRun> & { listFor(scope: { taskId?: string; threadId?: string }): Promise<AgentRun[]> };
  verifyRuns: TaskScoped<VerifyRun>;
  criterionTests: { replace(taskId: string, items: CriterionTest[]): Promise<void>; list(taskId: string): Promise<CriterionTest[]> };
  findings: TaskScoped<ReviewFinding> & { replace(taskId: string, items: ReviewFinding[]): Promise<void> };
  prs: TaskScoped<PullRequest> & { listByStatus(statuses: readonly PullRequestStatus[]): Promise<PullRequest[]> };
  threads: Collection<ChatThread> & { listFor(scope: { projectId?: string; taskId?: string }): Promise<ChatThread[]> };
  messages: { add(m: ChatMessage): Promise<void>; list(threadId: string): Promise<ChatMessage[]> };
  rules: Collection<Rule> & { listPending(repoId: string): Promise<Rule[]> };
  usage: { add(u: UsageRecord): Promise<void>; prompts(scope: { taskId?: string; since?: string }): Promise<number>; list(scope: { taskId?: string; since?: string }): Promise<UsageRecord[]> };
  jobs: {
    get(taskId: string): Promise<Job | undefined>;
    upsert(job: Job): Promise<void>;
    delete(taskId: string): Promise<void>;
    list(): Promise<Job[]>;
  };
  settings: { get(): Promise<Settings>; set(s: Settings): Promise<void> };
  /** Comments for tracker-local, keyed by task key. */
  trackerComments: { add(c: TrackerComment): Promise<void>; list(key: string): Promise<TrackerComment[]> };
  /**
   * Append-only audit log with a hash chain (see audit.ts). `append` assigns the sequence number and
   * hashes; there is no update or delete. `list` returns entries in sequence order, newest last.
   */
  /** What each agent run did, step by step (see AgentStep). */
  agentSteps: { add(s: AgentStep): Promise<void>; list(scope: { taskId?: string; runId?: string }): Promise<AgentStep[]> };
  audit: {
    append(e: AuditInput): Promise<AuditEntry>;
    list(scope?: { taskId?: string; since?: string; until?: string; afterSeq?: number; limit?: number }): Promise<AuditEntry[]>;
  };
}

/* ================================================================== source hosts and git */

export interface MirrorInfo {
  path: string;
  defaultBranch: string;
}

export interface Worktree {
  repoId: string;
  path: string;
  branch: string;
  base: string;
}

export type RebaseResult = { kind: 'ok'; head: string } | { kind: 'conflict'; files: string[] };

export type PushResult = { kind: 'pushed'; sha: string } | { kind: 'rejected'; message: string };

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  message: string;
  fix?: string;
}

export interface PullRequestRequest {
  repo: Repo;
  sourceBranch: string;
  destinationBranch: string;
  title: string;
  description: string;
  /** Stable per task and repo so a retry after a restart never creates a duplicate. */
  idempotencyKey: string;
}

export type PullRequestResult =
  | { kind: 'created'; providerId: string; url: string }
  | { kind: 'manual'; url: string; reason: string };

export interface DetectedRepo {
  host: HostRef;
  name: string;
  /** Normalized URL git uses (for example CodeCommit HTTPS with the AWS credential helper). */
  gitUrl: string;
}

export interface SourceHost {
  readonly kind: HostKind;
  detect(url: string): DetectedRepo | undefined;
  preflight(repo: Repo): Promise<PreflightCheck[]>;
  mirror(repo: Repo): Promise<MirrorInfo>;
  createWorktree(repo: Repo, opts: { path: string; branch: string; base?: string; detach?: boolean }): Promise<Worktree>;
  rebase(repo: Repo, worktree: Worktree): Promise<RebaseResult>;
  push(repo: Repo, worktree: Worktree, opts?: { forceWithLease?: string }): Promise<PushResult>;
  openPullRequest(req: PullRequestRequest): Promise<PullRequestResult>;
  updatePullRequestDescription(repo: Repo, pr: PullRequest, description: string): Promise<void>;
  getPullRequestStatus(repo: Repo, pr: PullRequest): Promise<PullRequestStatus>;
  /** Tracker/PR description limit for this host, in characters. */
  readonly descriptionLimit: number;
}

/** Local git operations on a worktree (no network). */
export interface GitOps {
  status(worktree: string): Promise<string[]>;
  commitAll(worktree: string, message: string): Promise<string | undefined>;
  /** Commits changes to files git already tracks (not new files such as reports); undefined when there are none. */
  commitTracked(worktree: string, message: string): Promise<string | undefined>;
  head(worktree: string): Promise<string>;
  diff(worktree: string, base: string): Promise<string>;
  diffStat(worktree: string, base: string): Promise<{ files: number; insertions: number; deletions: number }>;
  continueRebase(worktree: string): Promise<string>;
  abortRebase(worktree: string): Promise<void>;
  conflictedFiles(worktree: string): Promise<string[]>;
  removeWorktree(repo: Repo, worktree: string): Promise<void>;
  isAncestor(repo: Repo, ref: string, of: string): Promise<boolean>;
  /** Commit of `origin/<branch>` in the repo's mirror (as of its last fetch), if the branch exists. */
  remoteHead(repo: Repo, branch: string): Promise<string | undefined>;
  /** Files a merge of `ref` into the worktree's branch would conflict in. Leaves the worktree as it was. */
  probeMerge(worktree: string, ref: string): Promise<string[]>;
  /** Merges `ref` into the worktree's branch (a merge commit, no history rewrite). On conflict the merge stays in progress. */
  merge(worktree: string, ref: string, message: string): Promise<RebaseResult>;
  /** Commits a merge whose conflicts were resolved. */
  continueMerge(worktree: string): Promise<string>;
  abortMerge(worktree: string): Promise<void>;
  /** Moves the worktree's branch to `ref` (discarding local changes). Used to take others' commits or drop a failed merge. */
  resetTo(worktree: string, ref: string): Promise<void>;
}

/* ================================================================== trackers */

export interface TrackerTask {
  key: string;
  title: string;
  description: string;
  status: string;
  url?: string;
}

export interface Tracker {
  readonly kind: 'local' | 'jira';
  getTask(key: string): Promise<TrackerTask | undefined>;
  findReadyTasks(query?: string): Promise<TrackerTask[]>;
  comment(key: string, markdown: string): Promise<{ id: string; createdAt: string }>;
  transition(key: string, statusName: string): Promise<'moved' | 'not-available'>;
  readReplies(key: string, since: string, authorIds?: readonly string[]): Promise<TrackerComment[]>;
  /** Link to the issue for PR descriptions, when there is one. */
  link(key: string): string | undefined;
}

/* ================================================================== agent runtime */

export type AgentMode = 'read-only' | 'build';

export interface AgentTool<T = unknown> {
  name: string;
  description: string;
  schema: ZodType<T>;
  handler(args: T): Promise<string> | string;
}

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; summary: string; allowed: boolean; reason?: string }
  | { type: 'usage'; model: string; nanoAiu: number }
  | { type: 'error'; message: string }
  /** What the agent says it is doing now ("Reading the routes"). */
  | { type: 'intent'; text: string }
  /** The agent's reasoning, one finished block. */
  | { type: 'reasoning'; text: string }
  /** One finished message from the agent. */
  | { type: 'message'; text: string }
  | { type: 'tool-start'; id: string; tool: string; title?: string; input?: string }
  | { type: 'tool-end'; id: string; ok: boolean; output?: string; files?: Array<{ kind: string; path: string }> };

export interface AgentSessionOptions {
  /** Every file the agent may touch lives under this folder. */
  workspace: string;
  mode: AgentMode;
  instructions: string;
  /** Owner-configured command lines the build agent may run (repo commands). */
  allowedCommands: readonly string[];
  tools?: readonly AgentTool<never>[];
  /** Explicit model; when absent the adapter picks by tier (light = cheapest enabled, build = default). */
  model?: string;
  tier: 'light' | 'build';
  resumeId?: string;
  timeoutMs: number;
  /** The run is aborted after this many model calls. */
  maxModelCalls: number;
  /** The run is aborted (with BudgetError) once it has used this many nano-AIU. */
  maxNanoAiu?: number;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentUsage {
  model: string;
  modelCalls: number;
  nanoAiu: number;
}

export interface AgentTurn {
  text: string;
  usage: AgentUsage;
}

export interface AgentSession {
  readonly id: string;
  send(prompt: string): Promise<AgentTurn>;
  sendStructured<T>(prompt: string, schema: ZodType<T>): Promise<{ value: T; usage: AgentUsage }>;
  stop(): Promise<void>;
}

export interface AgentRuntime {
  readonly name: string;
  startSession(opts: AgentSessionOptions): Promise<AgentSession>;
  /** Models this account may use, with prices (no model call). */
  models?(): Promise<ModelOption[]>;
  /** The model a tier uses when none is picked (light = cheapest, build = runtime default). */
  defaultModel?(tier: 'light' | 'build'): Promise<string | undefined>;
}

/** Thrown by adapters for errors worth retrying (rate limits, transient network). */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
}

/* ================================================================== processes, clock, events */

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  /** Runs an owner-configured command line through the platform shell, in `cwd`. */
  /** Runs a command line; `signal` stops it (and everything it started) early. */
  runCommand(command: string, opts: { cwd: string; timeoutMs: number; env?: Record<string, string>; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<ProcessResult>;
}

export interface Clock {
  now(): number;
  iso(): string;
}

export interface EventSink {
  emit(e: TandemEvent): void;
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Paths {
  home: string;
  taskDir(taskId: string): string;
  /** Folder holding the read-only reference checkouts of a project's repos. */
  referenceRoot(projectId: string): string;
  /** Read-only reference checkout of a repo's default branch, per project. */
  referenceDir(projectId: string, repoName: string): string;
}

export type IdGenerator = () => string;

