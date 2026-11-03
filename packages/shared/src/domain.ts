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
  createdAt: Iso,
});
export type PullRequest = z.infer<typeof PullRequest>;

/* ------------------------------------------------------------------ chat, rules, usage */

export const ChatMode = z.enum(['ask', 'request', 'task']);
export type ChatMode = z.infer<typeof ChatMode>;

export const ChatThread = z.object({
  id: Id,
  projectId: Id,
  taskId: Id.optional(),
  mode: ChatMode,
  title: z.string(),
  sessionId: z.string().optional(),
  draft: Requirement.optional(),
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
  model: z.string(),
  /** One per prompt sent; model calls counts every agent-loop call. */
  prompts: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  nanoAiu: z.number().nonnegative(),
  at: Iso,
});
export type UsageRecord = z.infer<typeof UsageRecord>;
