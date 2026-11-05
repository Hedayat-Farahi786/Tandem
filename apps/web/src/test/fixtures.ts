import type { Project, Repo, Settings, Task } from '@tandem/shared';
import type { TaskDetail } from '../lib/types';

export const repo: Repo = { id: 'r1', url: 'codecommit::eu-central-1://shop', host: { kind: 'codecommit', region: 'eu-central-1', name: 'shop' }, name: 'shop', defaultBranch: 'main', role: 'full-stack', language: 'TypeScript', framework: 'Fastify + React', commands: { install: 'npm ci', test: 'npm test' }, createdAt: '2026-11-03T00:00:00Z' };
export const project: Project = { id: 'p1', name: 'Shop', repoIds: ['r1'], contractOrder: ['r1'], specRepoId: 'r1', pmGate: 'tandem', pmNames: ['Pat Lee'], jiraPmAccountIds: [], jiraPmNames: {}, keyPrefix: 'TND', createdAt: '2026-11-03T00:00:00Z' };
export const settings: Settings = {
  ownerName: 'Sam',
  copilot: { host: '', buildModel: '', lightModel: '', cliPath: '' },
  aws: { profile: '', region: '' },
  limits: { maxConcurrentBuilds: 1, maxConcurrentReadOnly: 2, chatTimeoutMin: 5, readOnlyTimeoutMin: 15, buildTimeoutMin: 60, commandTimeoutMin: 15, maxFixAttempts: 2, sizeLineLimit: 400, minFreeDiskGb: 2 },
  budget: { perTaskPrompts: 15, perDayPrompts: 40, perRunModelCalls: 60, perTaskCredits: 25, perDayCredits: 75 },
  jira: { baseUrl: '', email: '', readyJql: 'status = "Ready for AI"', inReviewStatus: 'In Review', pollIntervalMin: 5 },
  github: { apiBase: 'https://api.github.com' },
  polling: { prPollIntervalMin: 5, fixConflicts: true },
};
export const boot = (over: Record<string, unknown> = {}) => ({ setupComplete: true, projects: [project], repos: [repo], settings, agent: 'copilot', doctor: null, jiraConfigured: false, ...over });


const T0 = '2026-11-03T09:00:00.000Z';
export const requirement = {
  goal: 'Add GET /health',
  userStory: 'As an operator I want to see whether the service is up',
  criteria: [
    { given: 'the backend runs', when: 'GET /health is called', then: 'it returns 200 {"status":"ok"}' },
    { given: 'the page loads', when: 'the call succeeds', then: 'it shows "Status: ok"' },
  ],
  exampleData: 'GET /health → 200',
  affectedAreas: 'Backend routes',
  outOfScope: 'Auth',
  openQuestions: [] as string[],
};

export function task(over: Partial<Task> = {}): Task {
  return { id: 'task1', key: 'TND-1', projectId: 'p1', title: 'Health endpoint', source: 'chat', requirement, description: '', affectedRepoIds: ['r1'], state: 'SPEC_REVIEW', needsAttention: false, attentionNotes: [], progress: {}, guidance: [], slug: 'health-endpoint', branch: 'feature/TND-1-health-endpoint', createdAt: T0, updatedAt: T0, ...over };
}

export const SPEC_MD = '# Health endpoint\n\n## Problem and goal\n\nAdd GET /health.\n';

export function detail(over: Partial<TaskDetail> = {}, t: Partial<Task> = {}): TaskDetail {
  const tk = task(t);
  return {
    task: tk,
    project,
    repos: [repo],
    steps: [],
    readiness: { ready: true, items: [{ id: 'goal', label: 'Clear goal', ok: true, detail: tk.requirement.goal }], missing: [] },
    transitions: [{ id: 1, taskId: tk.id, from: 'DRAFT', to: 'READINESS', reason: 'Submitted for the readiness check.', actor: 'owner', at: T0 }],
    specs: [{ version: 1, source: 'draft', createdAt: T0 }],
    spec: { taskId: tk.id, version: 1, markdown: SPEC_MD, source: 'draft', createdAt: T0 },
    specCheck: { valid: true, problems: [], openQuestions: [] },
    approvals: [],
    approvalState: { complete: false },
    verifyRuns: [],
    tests: [],
    findings: [],
    prs: [],
    comments: [],
    runs: [],
    usage: { prompts: 2, modelCalls: 5, aiCredits: 0.5, budget: { today: 2, perDay: 40, perTask: 15, credits: { today: 0.5, perDay: 75, task: 0.5, perTask: 25 } } },
    running: false,
    ...over,
  };
}

/** The model catalog as the server sends it (prices in AI credits per million tokens). */
export const catalog = {
  models: [
    { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', vendor: 'Anthropic', price: { input: 200, output: 1000, cachedInput: 10 }, contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: ['low', 'medium', 'high', 'max'], estimate: 48 },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', vendor: 'OpenAI', price: { input: 10, output: 50, cachedInput: 1 }, contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: ['none', 'max'], estimate: 3 },
  ],
  auto: { light: 'gpt-6-luna', build: null },
  credits: { today: 0.5, perDay: 75, perTask: 25 },
};
