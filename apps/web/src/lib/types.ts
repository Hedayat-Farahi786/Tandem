import type { AgentStep, AgentRun, Approval, ChatMessage, ChatThread, CommandResult, CriterionTest, ModelOption, Project, PullRequest, Repo, ReviewFinding, Settings, SpecVersion, Task, TaskTransition, VerifyRun } from '@tandem/shared';

export interface ReadinessItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}
export interface Readiness {
  ready: boolean;
  items: ReadinessItem[];
  missing: ReadinessItem[];
}

export interface DoctorCheck {
  id: string;
  group: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  message: string;
  fix?: string;
}
export interface DoctorReport {
  at: string;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface Bootstrap {
  setupComplete: boolean;
  projects: Project[];
  repos: Repo[];
  settings: Settings;
  agent: string;
  /** Test mode: CodeCommit repos come from local copies, so PRs are links to fill in by hand. */
  localRepoCopies?: boolean;
  doctor: DoctorReport | null;
  jiraConfigured: boolean;
}

export type TaskListItem = Task & { prCount: number };

export interface TaskDetail {
  task: Task;
  project: Project;
  repos: Repo[];
  steps: string[];
  readiness: Readiness;
  transitions: TaskTransition[];
  specs: Array<Pick<SpecVersion, 'version' | 'source' | 'feedback' | 'createdAt'>>;
  spec: SpecVersion | null;
  specCheck: { valid: boolean; problems: string[]; openQuestions: string[] } | null;
  approvals: Approval[];
  approvalState: { owner?: Approval; pm?: Approval; complete: boolean } | null;
  verifyRuns: VerifyRun[];
  tests: CriterionTest[];
  findings: ReviewFinding[];
  prs: PullRequest[];
  comments: Array<{ id: string; authorName: string; body: string; createdAt: string }>;
  runs: AgentRun[];
  usage: { prompts: number; modelCalls: number; aiCredits: number; budget: { today: number; perDay: number; task?: number; perTask: number; credits: { today: number; perDay: number; task?: number; perTask: number } } };
  running: boolean;
}

export interface ThreadView {
  thread: ChatThread;
  /** The model this chat uses ('' = Auto). A task chat shows its task's model. */
  model: string;
  messages: ChatMessage[];
  /** What Copilot did for each answer, by run id (prompt and message steps left out). */
  steps?: Record<string, AgentStep[]>;
  readiness: Readiness | null;
}

/** A model in the picker: prices in AI credits per million tokens, estimate for a typical task. */
export type ModelChoice = ModelOption & { estimate?: number };
export interface ModelCatalog {
  models: ModelChoice[];
  /** What "Auto" uses: Settings, else the cheapest model for light steps and Copilot's choice for builds. */
  auto: { light: string | null; build: string | null };
  credits: { today: number; perDay: number; perTask: number };
}

export interface RepoDiff {
  repoId: string;
  name: string;
  branch: string;
  diff: string;
}

export type { CommandResult, Project, Repo, Settings, Task, ChatThread, ChatMessage, PullRequest, ReviewFinding };

/* ------------------------------------------------------------------ traceability */

export type ActivityKind = 'task' | 'state' | 'spec' | 'approval' | 'git' | 'pr' | 'agent' | 'checks' | 'config';

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  action: string;
  actor: 'system' | 'owner' | 'pm' | 'agent';
  actorName?: string;
  summary: string;
  taskId?: string;
  taskKey?: string;
  projectId?: string;
  repoId?: string;
  detail?: Record<string, unknown>;
  seq?: number;
  hash?: string;
}

export interface AuditVerification {
  ok: boolean;
  count: number;
  brokenAt?: number;
  reason?: string;
  head: string;
}

export interface Trace {
  generatedAt: string;
  task: { id: string; key: string; title: string; state: string; source: string; externalKey?: string; branch: string; createdAt: string; updatedAt: string; project: string };
  requirement: { goal: string; userStory: string; exampleData: string; affectedAreas: string; outOfScope: string };
  criteria: Array<{ n: number; given: string; when: string; then: string; status: 'pass' | 'fail' | 'not-run' | 'no-test' | 'skipped'; tests: Array<{ repo: string; file: string; name: string; result: string; scope: string }> }>;
  specs: Array<{ version: number; source: string; createdAt: string; feedback?: string; sha256: string; status: 'approved' | 'in-review' | 'superseded'; approvals: Array<{ role: string; name: string; date: string; method: string; evidence: string }> }>;
  agent: Array<{ kind: string; runs: number; succeeded: number; failed: number; models: string[]; prompts: number; modelCalls: number; aiCredits: number; firstAt?: string; lastAt?: string }>;
  checks: Array<{ attempt: number; passed: boolean; at: string; results: Array<{ repo: string; kind: string; command: string; exitCode: number | null; durationMs: number; timedOut: boolean }> }>;
  findings: Array<{ severity: string; category: string; title: string; file?: string; line?: number; status: string }>;
  commits: Array<{ repo: string; branch: string; commit: string; at?: string; reason?: string }>;
  pullRequests: Array<{ repo: string; url: string; status: string; manual: boolean; createdAt?: string; sync?: string }>;
  usage: { prompts: number; modelCalls: number; aiCredits: number };
  audit: Array<{ seq: number; at: string; actor: string; actorName?: string; action: string; summary: string; hash: string }>;
  integrity: { ok: boolean; entries: number; head: string; reason?: string };
  request: { by?: string; at: string; text: string; ready: boolean; missing: string[]; size?: { lines: number; rationale: string } };
  runs: Array<{ id: string; kind: string; mode: string; model?: string; status: string; startedAt: string; endedAt?: string; durationMs?: number; prompts: number; modelCalls: number; aiCredits: number; actions: number; filesChanged: string[]; blocked: Array<{ tool: string; what: string; reason?: string }>; error?: string; instructionsSha?: string; withGuidance: boolean }>;
  changes: Array<{ repo: string; commit: string; message: string; files: string[]; at: string }>;
  decisions: Array<{ at: string; who: string; action: string; summary: string }>;
  exceptions: Array<{ at?: string; kind: 'failed-run' | 'stopped-run' | 'blocked-action' | 'limit' | 'failure' | 'skipped-check' | 'preexisting' | 'attention'; text: string }>;
  lifecycle: Array<{ at: string; from: string; to: string; actor: string; reason: string }>;
}
