import type { AgentRun, Approval, ChatMessage, ChatThread, CommandResult, CriterionTest, Project, PullRequest, Repo, ReviewFinding, Settings, SpecVersion, Task, TaskTransition, VerifyRun } from '@tandem/shared';

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
  usage: { prompts: number; modelCalls: number; aiCredits: number; budget: { today: number; perDay: number; task?: number; perTask: number } };
  running: boolean;
}

export interface ThreadView {
  thread: ChatThread;
  messages: ChatMessage[];
  readiness: Readiness | null;
}

export interface RepoDiff {
  repoId: string;
  name: string;
  branch: string;
  diff: string;
}

export type { CommandResult, Project, Repo, Settings, Task, ChatThread, ChatMessage, PullRequest, ReviewFinding };
