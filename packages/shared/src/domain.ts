import { z } from 'zod';
import { Actor, BlockedReason, TaskState } from './states.js';

const Id = z.string().min(1);
const Iso = z.string().min(1);

/* ------------------------------------------------------------------ repos and projects */

export const HostKind = z.enum(['codecommit', 'github']);
export type HostKind = z.infer<typeof HostKind>;

export const RepoRole = z.enum(['frontend', 'backend', 'full-stack', 'other']);
export type RepoRole = z.infer<typeof RepoRole>;

export const RepoCommands = z.object({
  install: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  /** Runs one test; `{file}` and `{name}` are replaced. */
  testSingle: z.string().optional(),
});
export type RepoCommands = z.infer<typeof RepoCommands>;

export const HostRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codecommit'), region: z.string(), name: z.string(), profile: z.string().optional() }),
  z.object({ kind: z.literal('github'), owner: z.string(), name: z.string(), apiBase: z.string().optional() }),
]);
export type HostRef = z.infer<typeof HostRef>;

export const Repo = z.object({
  id: Id,
  url: z.string().min(1),
  host: HostRef,
  name: z.string(),
  defaultBranch: z.string(),
  language: z.string().optional(),
  framework: z.string().optional(),
  packageManager: z.string().optional(),
  role: RepoRole,
  commands: RepoCommands,
  createdAt: Iso,
});
export type Repo = z.infer<typeof Repo>;

export const PmGate = z.enum(['tandem', 'jira', 'off']);
export type PmGate = z.infer<typeof PmGate>;

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  repoIds: z.array(Id).min(1),
  /** Implementation order for split repos (backend first by default). */
  contractOrder: z.array(Id),
  /** Repo where the approved spec is committed. */
  specRepoId: Id,
  integrationCommand: z.string().optional(),
  pmGate: PmGate,
  pmNames: z.array(z.string()).default([]),
  jiraPmAccountIds: z.array(z.string()).default([]),
  jiraProjectKey: z.string().optional(),
  jiraJql: z.string().optional(),
  keyPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).default('TND'),
  createdAt: Iso,
});
export type Project = z.infer<typeof Project>;

/* ------------------------------------------------------------------ tasks */

export const Criterion = z.object({
  given: z.string(),
  when: z.string(),
  then: z.string(),
});
export type Criterion = z.infer<typeof Criterion>;

export const Requirement = z.object({
  goal: z.string().default(''),
  userStory: z.string().default(''),
  criteria: z.array(Criterion).default([]),
  exampleData: z.string().default(''),
  affectedAreas: z.string().default(''),
  outOfScope: z.string().default(''),
  openQuestions: z.array(z.string()).default([]),
});
export type Requirement = z.infer<typeof Requirement>;

export const SizeEstimate = z.object({
  estimatedLines: z.number().int().nonnegative(),
  perRepo: z.array(z.object({ repo: z.string(), lines: z.number().int().nonnegative() })).default([]),
  features: z.array(z.string()).default([]),
  proposedSplit: z.array(z.object({ title: z.string(), criteria: z.array(z.number().int().positive()) })).default([]),
  rationale: z.string().default(''),
});
export type SizeEstimate = z.infer<typeof SizeEstimate>;

export const TaskSource = z.enum(['chat', 'form', 'jira', 'split']);

/** Checks the owner can skip for one task (a test runner that can't start on this machine, say). */
export const SkippableCheck = z.enum(['install', 'lint', 'typecheck', 'build', 'test', 'integration']);
export type SkippableCheck = z.infer<typeof SkippableCheck>;
/** A check the owner skipped for a task: Tandem doesn't run it, and the pull request says so. */
export const SkippedCheck = z.object({ repoId: Id.optional(), kind: SkippableCheck, reason: z.string(), at: Iso });
export type SkippedCheck = z.infer<typeof SkippedCheck>;

export const Task = z.object({
  id: Id,
  key: z.string(),
  projectId: Id,
  title: z.string().min(1),
  source: TaskSource,
  externalKey: z.string().optional(),
  parentTaskId: Id.optional(),
  requirement: Requirement,
  description: z.string().default(''),
  affectedRepoIds: z.array(Id),
  state: TaskState,
  step: z.string().optional(),
  blockedReason: BlockedReason.optional(),
  blockedMessage: z.string().optional(),
  /** Where the workflow continues once the block is resolved. */
  resumeTo: z.object({ state: TaskState, step: z.string().optional() }).optional(),
  needsAttention: z.boolean().default(false),
  attentionNotes: z.array(z.string()).default([]),
  sizeEstimate: SizeEstimate.optional(),
  sizeOverride: z.string().optional(),
  /** Feedback from "Request changes", used by the next spec draft. */
  specFeedback: z.string().optional(),
  /** When the spec was sent to the PM for approval through Jira. */
  pmRequestedAt: Iso.optional(),
  /** Step-local progress that must survive a restart (fix attempts, repos implemented, pushed shas). */
  progress: z.record(z.string(), z.unknown()).default({}),
  /** Copilot model for every agent step of this task. Absent = the defaults in Settings. */
  model: z.string().optional(),
  /** What the owner told Copilot to do differently; every later agent prompt for the task includes it. */
  guidance: z.array(z.object({ text: z.string(), at: Iso })).default([]),
  /** Checks the owner skipped for this task. */
  skippedChecks: z.array(SkippedCheck).optional(),
  slug: z.string(),
  branch: z.string(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Task = z.infer<typeof Task>;

export const TaskTransition = z.object({
  id: z.number().int(),
  taskId: Id,
  from: TaskState,
  to: TaskState,
  step: z.string().optional(),
  reason: z.string(),
  actor: Actor,
  at: Iso,
});
export type TaskTransition = z.infer<typeof TaskTransition>;

/* ------------------------------------------------------------------ specs and approvals */

export const SpecSource = z.enum(['draft', 'redraft', 'edit']);
export const SpecVersion = z.object({
  taskId: Id,
  version: z.number().int().positive(),
  markdown: z.string(),
  source: SpecSource,
  feedback: z.string().optional(),
  createdAt: Iso,
});
export type SpecVersion = z.infer<typeof SpecVersion>;

export const ApprovalRole = z.enum(['owner', 'pm']);
export const Approval = z.object({
  id: Id,
  taskId: Id,
  specVersion: z.number().int().positive(),
  role: ApprovalRole,
  name: z.string().min(1),
  date: Iso,
  evidence: z.string().default(''),
  method: z.enum(['tandem', 'jira']),
  createdAt: Iso,
});
export type Approval = z.infer<typeof Approval>;

/* ------------------------------------------------------------------ agent runs, verify, review */

export const AgentRunKind = z.enum(['ask', 'request', 'task-chat', 'extract', 'size', 'spec', 'build', 'fix', 'review', 'conflict']);
export type AgentRunKind = z.infer<typeof AgentRunKind>;

export const AgentRun = z.object({
  id: Id,
  taskId: Id.optional(),
  threadId: Id.optional(),
  kind: AgentRunKind,
  mode: z.enum(['read-only', 'build']),
  sessionId: z.string().optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'aborted']),
  attempt: z.number().int().nonnegative(),
  startedAt: Iso,
  endedAt: Iso.optional(),
  error: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const CommandKind = z.enum(['install', 'lint', 'typecheck', 'build', 'test', 'test-single', 'integration']);
export type CommandKind = z.infer<typeof CommandKind>;

export const CommandResult = z.object({
  repoId: Id.optional(),
  kind: CommandKind,
  command: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string(),
  logPath: z.string().optional(),
  /** Not run (or stopped) because the owner skipped this check for the task. */
  skipped: z.boolean().optional(),
  /** It fails on the base branch too, and this change adds no failures: not the task's to fix. */
  preexisting: z.object({ base: z.string(), failures: z.number().int().optional() }).optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;

export const VerifyRun = z.object({
  id: Id,
  taskId: Id,
  attempt: z.number().int().nonnegative(),
  passed: z.boolean(),
  results: z.array(CommandResult),
  createdAt: Iso,
});
export type VerifyRun = z.infer<typeof VerifyRun>;

export const TestResult = z.enum(['pass', 'fail', 'not-run']);
export const CriterionTest = z.object({
  taskId: Id,
  criterion: z.number().int().positive(),
  repoId: Id,
  file: z.string(),
  name: z.string(),
  result: TestResult,
  scope: z.enum(['single', 'suite']),
});
export type CriterionTest = z.infer<typeof CriterionTest>;

export const FindingSeverity = z.enum(['high', 'medium', 'low']);
export const ReviewFinding = z.object({
  id: Id,
  taskId: Id,
  severity: FindingSeverity,
  category: z.enum(['spec', 'criteria', 'rules', 'security', 'other']),
  repoId: Id.optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  title: z.string(),
  detail: z.string(),
  status: z.enum(['open', 'fixed', 'dismissed']),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/* ------------------------------------------------------------------ pull requests */

export const PullRequestStatus = z.enum(['open', 'merged', 'closed', 'manual-pending']);
export type PullRequestStatus = z.infer<typeof PullRequestStatus>;

/**
 * up-to-date: the base has not moved past the branch. mergeable: it moved, without conflicts.
 * updated: Tandem merged the base in, resolved the conflicts, checks passed, pushed.
 * needs-person: it conflicts and Tandem leaves it to a person (someone else pushed to the branch,
 * or fixing conflicts automatically is off). unresolved / checks-failed: Tandem tried and stopped.
 * branch-rewritten: the branch was force-pushed by someone else; Tandem no longer touches it.
 */
export const PrSyncState = z.enum(['up-to-date', 'mergeable', 'updated', 'needs-person', 'unresolved', 'checks-failed', 'branch-rewritten']);
export type PrSyncState = z.infer<typeof PrSyncState>;

export const PullRequest = z.object({
  id: Id,
  taskId: Id,
  repoId: Id,
  providerId: z.string().optional(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  status: PullRequestStatus,
  manual: z.boolean(),
  lastPolledAt: Iso.optional(),
  /** How the PR branch stands against its base branch, from the last check while the PR is open. */
  sync: z
    .object({
      state: PrSyncState,
      /** The base branch commit and the PR branch commit this check was made against. */
      base: z.string(),
      head: z.string(),
      files: z.array(z.string()).default([]),
      message: z.string(),
      at: Iso,
    })
    .optional(),
  createdAt: Iso,
});
export type PullRequest = z.infer<typeof PullRequest>;

/* ------------------------------------------------------------------ chat, rules, usage */

export const ChatMode = z.enum(['ask', 'request', 'task']);
export type ChatMode = z.infer<typeof ChatMode>;

/** A question the agent asks the owner in a request chat, with likely answers to pick from. */
export const OwnerQuestion = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().default(false),
});
export type OwnerQuestion = z.infer<typeof OwnerQuestion>;

/** The owner's answer to one question: the options picked and/or their own words. */
export const OwnerAnswer = z.object({ questionId: z.string(), header: z.string(), question: z.string(), answers: z.array(z.string()).min(1) });
export type OwnerAnswer = z.infer<typeof OwnerAnswer>;

export const ChatThread = z.object({
  id: Id,
  projectId: Id,
  taskId: Id.optional(),
  mode: ChatMode,
  title: z.string(),
  sessionId: z.string().optional(),
  /** Copilot model for this chat (ask and request). A task chat uses its task's model. */
  model: z.string().optional(),
  /** Request mode: the requirement gathered so far. */
  draft: Requirement.optional(),
  draftTitle: z.string().optional(),
  draftRepoIds: z.array(Id).optional(),
  draftSize: SizeEstimate.optional(),
  /** Set once "Create task" turned the draft into a task. */
  createdTaskId: Id.optional(),
  /** Task chat: a spec change the agent proposed, waiting for the owner to confirm. */
  pendingSpecChange: z.object({ kind: z.enum(['redraft', 'edit']), feedback: z.string().optional(), markdown: z.string().optional(), summary: z.string() }).optional(),
  /** Task chat: how the agent proposes to continue a stuck task, waiting for the owner to confirm. */
  pendingContinue: z.object({ summary: z.string(), guidance: z.string(), skipChecks: z.array(z.object({ repoId: Id.optional(), kind: SkippableCheck })).optional() }).optional(),
  /**
   * Copilot is answering a message right now (kept in the store, so a reloaded page shows it live).
   * `runId` is the agent run, once it started.
   */
  busy: z.object({ since: Iso, runId: Id.optional() }).optional(),
  /** Pinned to the top of Recents (when). */
  pinnedAt: Iso.optional(),
  /** Request chat: questions the agent asked, waiting for the owner's answers. */
  pendingQuestions: z.object({ questions: z.array(OwnerQuestion), askedAt: Iso }).optional(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type ChatThread = z.infer<typeof ChatThread>;

export const FileRef = z.object({ path: z.string(), line: z.number().int().positive().optional(), repoId: Id.optional() });
export const ChatMessage = z.object({
  id: Id,
  threadId: Id,
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  refs: z.array(FileRef).default([]),
  /** For an answer: the agent run that wrote it (its steps show above the answer). */
  runId: Id.optional(),
  /** For the owner's message: the answers they picked to the agent's questions. */
  answers: z.array(OwnerAnswer).optional(),
  createdAt: Iso,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const Rule = z.object({
  id: Id,
  repoId: Id,
  text: z.string().min(1),
  source: z.string(),
  status: z.enum(['pending', 'committed']),
  committedInTaskId: Id.optional(),
  createdAt: Iso,
});
export type Rule = z.infer<typeof Rule>;

export const UsageRecord = z.object({
  id: Id,
  taskId: Id.optional(),
  threadId: Id.optional(),
  runKind: AgentRunKind,
  /** The agent run this usage belongs to (missing on records from before 1.1). */
  runId: Id.optional(),
  model: z.string(),
  /** One per prompt sent; model calls counts every agent-loop call. */
  prompts: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  nanoAiu: z.number().nonnegative(),
  at: Iso,
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/* ------------------------------------------------------------------ audit log */

/**
 * One entry in the append-only audit log: who did what, when, to what. Entries form a hash chain
 * (each hash covers the previous one), so a changed or removed entry is detected on verification.
 * Never holds secret values: a secret change records only its name.
 */
export const AuditEntry = z.object({
  seq: z.number().int().positive(),
  at: Iso,
  /** "owner", "system", "agent", or "pm". */
  actor: Actor,
  /** Who acted, when known: the owner's name from Settings, a PM's name. */
  actorName: z.string().optional(),
  /** Dotted verb, e.g. "settings.updated", "task.approved", "git.pushed". */
  action: z.string().min(1),
  /** A short human summary, e.g. "Approved spec version 2". */
  summary: z.string(),
  taskId: Id.optional(),
  projectId: Id.optional(),
  repoId: Id.optional(),
  /** Structured facts: changed fields, commit, branch, URL, HTTP status. */
  detail: z.record(z.string(), z.unknown()).default({}),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export type AuditInput = Omit<AuditEntry, 'seq' | 'prevHash' | 'hash' | 'detail'> & { detail?: Record<string, unknown> };

/* ------------------------------------------------------------------ agent activity */

export const AgentStepKind = z.enum(['prompt', 'intent', 'reasoning', 'message', 'tool', 'blocked', 'error']);
export type AgentStepKind = z.infer<typeof AgentStepKind>;

/**
 * One thing an agent run did, in order: the instructions it got, what it said it was doing, its
 * reasoning, each tool it used (with the result), actions Tandem blocked, and its messages. Text is
 * redacted and capped before it is stored.
 */
export const AgentStep = z.object({
  id: Id,
  runId: Id,
  taskId: Id.optional(),
  threadId: Id.optional(),
  seq: z.number().int().nonnegative(),
  at: Iso,
  kind: AgentStepKind,
  text: z.string().optional(),
  tool: z.string().optional(),
  /** A human title for the tool call, e.g. "Run tests" or "View src/app.ts". */
  title: z.string().optional(),
  /** The tool's input, shortened: a command, a path, a search. */
  input: z.string().optional(),
  /** The tool's output, shortened. */
  output: z.string().optional(),
  ok: z.boolean().optional(),
  files: z.array(z.object({ kind: z.string(), path: z.string() })).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AgentStep = z.infer<typeof AgentStep>;
