import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, Requirement, type Project, type Repo, type Settings } from '@tandem/shared';
import type { WorkflowDeps } from '../workflow/context.js';
import { workflowHandlers } from '../workflow/steps.js';
import { TaskService } from '../workflow/service.js';
import { Runner } from '../runner/runner.js';
import {
  CollectingEvents,
  FakeClock,
  FakeGit,
  FakeProcessRunner,
  FakeSourceHost,
  FakeTracker,
  MemoryStore,
  ScriptedAgent,
  sequentialIds,
  silentLogger,
  type FakeHostScript,
  type ScriptCall,
  type ScriptReply,
} from '../testing/index.js';
import { VALID_SPEC } from './fixtures.js';

export const GOOD_REQUIREMENT = Requirement.parse({
  goal: 'Expose service health and show it on the main page',
  userStory: 'As an operator I want to see whether the service is up',
  criteria: [
    { given: 'the backend is running', when: 'GET /health is called', then: 'it returns 200 {"status":"ok"}' },
    { given: 'the main page loads', when: 'the health call succeeds', then: 'the page shows "Status: ok"' },
  ],
  exampleData: 'GET /health -> 200 {"status":"ok"}',
  affectedAreas: 'API routes, main page',
  outOfScope: 'Authentication, metrics',
});

export const SINGLE_SPEC = VALID_SPEC;

export type ScriptOverrides = Partial<Record<'size' | 'extract' | 'review' | 'spec' | 'implement' | 'fix' | 'coverage' | 'reviewFix' | 'conflict' | 'chat', (call: ScriptCall) => ScriptReply | Promise<ScriptReply>>>;

function route(call: ScriptCall): keyof Required<ScriptOverrides> | 'unknown' {
  const p = call.prompt;
  if (p.startsWith('Estimate the size')) return 'size';
  if (p.startsWith('Turn this ticket')) return 'extract';
  if (p.startsWith('Review this change')) return 'review';
  if (p.startsWith('Write the implementation spec')) return 'spec';
  if (p.startsWith('Implement the approved spec')) return 'implement';
  if (p.startsWith('Verification failed')) return 'fix';
  if (p.startsWith('These acceptance criteria have no recorded test')) return 'coverage';
  if (p.startsWith('A separate reviewer')) return 'reviewFix';
  if (p.startsWith('Rebasing') || p.startsWith('The pull request branch')) return 'conflict';
  if (p.startsWith('Repos in the workspace') || p.startsWith('The request is complete')) return 'chat';
  return 'unknown';
}

export function repoFromPrompt(prompt: string): string {
  return /in the `([^`]+)` repo/.exec(prompt)?.[1] ?? 'app';
}

const defaults: Required<ScriptOverrides> = {
  size: () => ({ value: { estimatedLines: 80, perRepo: [], features: ['health status'], proposedSplit: [], rationale: 'One endpoint and one status line.' } }),
  extract: () => ({
    value: { title: 'Health', ...GOOD_REQUIREMENT, affectedRepos: [], size: { estimatedLines: 60, perRepo: [], features: ['health'], proposedSplit: [], rationale: 'small' } },
  }),
  review: () => ({ value: { findings: [] } }),
  spec: () => ({ text: SINGLE_SPEC }),
  implement: (call) => {
    const repo = repoFromPrompt(call.prompt);
    const n = Number(/criterion \(1-(\d+)\)/.exec(call.prompt)?.[1] ?? /\(1-(\d+)\)/.exec(call.prompt)?.[1] ?? 2);
    return {
      text: `Implemented ${repo}.`,
      edits: [{ path: `${repo}/src/health.ts`, content: `export const health = () => ({ status: 'ok' });\n` }],
      tools: Array.from({ length: n }, (_, i) => ({ name: 'tandem_record_test', args: { criterion: i + 1, repo, file: `test/health-${i + 1}.test.ts`, name: `criterion ${i + 1}` } })),
    };
  },
  fix: () => ({ text: 'Fixed.' }),
  coverage: () => ({ text: 'Nothing to add.' }),
  reviewFix: (call) => ({ text: 'Fixed findings.', tools: [...call.prompt.matchAll(/- id (\S+)/g)].map((m) => ({ name: 'tandem_resolve_finding', args: { id: m[1], status: 'fixed', note: '' } })) }),
  conflict: () => ({ text: 'Resolved.' }),
  chat: () => ({ text: 'OK.' }),
};

export interface HarnessOptions {
  shape?: 'single' | 'split';
  pmGate?: Project['pmGate'];
  script?: ScriptOverrides;
  process?: ConstructorParameters<typeof FakeProcessRunner>[0];
  host?: FakeHostScript;
  settings?: Partial<Settings>;
  integrationCommand?: string;
}

export function harness(o: HarnessOptions = {}) {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = sequentialIds('x');
  const events = new CollectingEvents();
  const home = mkdtempSync(join(tmpdir(), 'tandem-core-'));
  const overrides: ScriptOverrides = { ...o.script };
  const agent = new ScriptedAgent(async (call) => {
    const r = route(call);
    if (r === 'unknown') throw new Error(`unrouted prompt: ${call.prompt.slice(0, 80)}`);
    // Like a real worktree: a run that edits code leaves changes until Tandem commits them.
    if (r === 'implement' || r === 'fix' || r === 'reviewFix' || r === 'conflict' || r === 'coverage') git.dirty = true;
    return (overrides[r] ?? defaults[r])(call);
  });
  const host = new FakeSourceHost('codecommit', o.host);
  const git = new FakeGit();
  const tracker = new FakeTracker(clock);
  const process = new FakeProcessRunner(o.process ?? {});
  const settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings, ownerName: 'Owner' };
  const deps: WorkflowDeps = {
    store,
    clock,
    ids,
    paths: {
      home,
      taskDir: (id) => join(home, 'tasks', id),
      referenceRoot: (pid) => join(home, 'projects', pid),
      referenceDir: (pid, name) => join(home, 'projects', pid, name),
    },
    hosts: () => host,
    git,
    tracker: async () => tracker,
    agent,
    process,
    settings: async () => (await store.settings.get()) ?? settings,
    events,
    logger: silentLogger,
  };
  const makeRunner = (bootId = 'boot-1') =>
    new Runner({ store, clock, bootId, handlers: workflowHandlers(deps), capacity: async () => ({ build: 1, read: 2, io: 4 }), events, logger: silentLogger, retry: { attempts: 3, baseMs: 1_000, maxMs: 10_000 }, random: () => 0.5 });
  const runner = makeRunner();
  const service = new TaskService(deps, { onCancel: (id) => runner.abort(id) });

  const repo = (id: string, name: string, role: Repo['role'], extra: Partial<Repo['commands']> = {}): Repo => ({
    id,
    url: `fake://${name}`,
    host: { kind: 'codecommit', region: 'eu-central-1', name },
    name,
    defaultBranch: 'main',
    role,
    commands: { install: 'npm ci', lint: 'npm run lint', typecheck: 'npm run typecheck', build: 'npm run build', test: 'npm test', ...extra },
    createdAt: clock.iso(),
  });
  const repos = o.shape === 'split' ? [repo('r-fe', 'frontend', 'frontend'), repo('r-be', 'backend', 'backend')] : [repo('r-app', 'app', 'full-stack')];
  const project: Project = {
    id: 'p1',
    name: 'Sandbox',
    repoIds: repos.map((r) => r.id),
    contractOrder: o.shape === 'split' ? ['r-be', 'r-fe'] : ['r-app'],
    specRepoId: o.shape === 'split' ? 'r-be' : 'r-app',
    ...(o.integrationCommand ? { integrationCommand: o.integrationCommand } : {}),
    pmGate: o.pmGate ?? 'tandem',
    pmNames: ['Pat'],
    jiraPmAccountIds: ['pm-1'],
    jiraPmNames: {},
    keyPrefix: 'TND',
    createdAt: clock.iso(),
  };

  const ready = (async () => {
    await store.settings.set(settings);
    for (const r of repos) await store.repos.upsert(r);
    await store.projects.upsert(project);
  })();

  /** Creates and submits a task, then runs until it waits for a person. */
  async function start(requirement = GOOD_REQUIREMENT, extra: Partial<Parameters<TaskService['create']>[0]> = {}) {
    await ready;
    const t = await service.create({ projectId: project.id, title: 'Add a GET /health endpoint', requirement, ...extra });
    await service.submit(t.id);
    await runner.runUntilIdle();
    return (await store.tasks.get(t.id))!;
  }

  async function approveAll(taskId: string) {
    await service.approve(taskId, 'Owner');
    if (project.pmGate === 'tandem') await service.recordPmApproval(taskId, { name: 'Pat', date: clock.iso(), evidence: 'Approved in the team channel' });
    await runner.runUntilIdle();
    return (await store.tasks.get(taskId))!;
  }

  const get = async (id: string) => (await store.tasks.get(id))!;

  return { store, clock, ids, events, home, agent, host, git, tracker, process, deps, runner, makeRunner, service, project, repos, ready, start, approveAll, get, overrides };
}
