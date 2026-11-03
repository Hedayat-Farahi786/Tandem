import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRun, AgentRunKind, AgentStep, Project, Repo, Settings, Task } from '@tandem/shared';
import { Budget, BudgetError } from '../budget.js';
import type {
  AgentEvent,
  AgentMode,
  AgentRuntime,
  AgentSession,
  AgentTool,
  AgentUsage,
  Clock,
  EventSink,
  GitOps,
  IdGenerator,
  Logger,
  Paths,
  ProcessRunner,
  SourceHost,
  Store,
  Tracker,
} from '../ports.js';
import { redactor } from '../policies/redact.js';
import type { ZodType } from 'zod';

export interface WorkflowDeps {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  paths: Paths;
  hosts: (repo: Repo) => SourceHost;
  git: GitOps;
  tracker: () => Promise<Tracker>;
  agent: AgentRuntime;
  process: ProcessRunner;
  settings: () => Promise<Settings>;
  events?: EventSink;
  logger?: Logger;
}

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export async function loadProject(deps: WorkflowDeps, projectId: string): Promise<Project> {
  const p = await deps.store.projects.get(projectId);
  if (!p) throw new NotFoundError(`Project ${projectId} not found.`);
  return p;
}

/** Affected repos in contract order (backend first by default). */
export async function affectedRepos(deps: WorkflowDeps, task: Task, project: Project): Promise<Repo[]> {
  const repos: Repo[] = [];
  const order = [...project.contractOrder, ...project.repoIds.filter((id) => !project.contractOrder.includes(id))];
  const ids = task.affectedRepoIds.length ? task.affectedRepoIds : project.repoIds;
  for (const id of order) {
    if (!ids.includes(id)) continue;
    const r = await deps.store.repos.get(id);
    if (r) repos.push(r);
  }
  if (repos.length === 0) throw new NotFoundError(`Task ${task.key} has no repos.`);
  return repos;
}

export const worktreeOf = (deps: WorkflowDeps, task: Task, repo: Repo): string => join(deps.paths.taskDir(task.id), repo.name);

/** Owner-configured command lines the build agent may run. */
export function repoCommands(repos: readonly Repo[], project?: Project): string[] {
  const out = new Set<string>();
  for (const r of repos) for (const c of Object.values(r.commands)) if (c && !c.includes('{')) out.add(c);
  if (project?.integrationCommand) out.add(project.integrationCommand);
  return [...out];
}

/** Repo guidance the agent must follow: copilot instructions, custom agents and learned rules. */
export async function repoContext(dir: string): Promise<string> {
  const parts: string[] = [];
  const read = async (rel: string) => {
    const p = join(dir, rel);
    if (existsSync(p)) parts.push(`### ${rel}\n\n${(await readFile(p, 'utf8')).slice(0, 20_000)}`);
  };
  await read('.github/copilot-instructions.md');
  const agentsDir = join(dir, '.github', 'agents');
  if (existsSync(agentsDir)) {
    for (const f of (await readdir(agentsDir)).filter((f) => f.endsWith('.md')).sort()) await read(`.github/agents/${f}`);
  }
  await read('docs/agent-rules.md');
  return parts.join('\n\n');
}

/** Refreshes the read-only reference checkouts (default branch) used by Ask, size, spec and review. */
export async function refreshReferences(deps: WorkflowDeps, project: Project, repos: readonly Repo[]): Promise<string> {
  for (const repo of repos) {
    const host = deps.hosts(repo);
    await host.mirror(repo);
    await host.createWorktree(repo, { path: deps.paths.referenceDir(project.id, repo.name), branch: repo.defaultBranch, base: `origin/${repo.defaultBranch}`, detach: true });
  }
  return deps.paths.referenceRoot(project.id);
}

export interface GatedSession {
  readonly id: string;
  readonly runId: string;
  send(prompt: string): Promise<string>;
  structured<T>(prompt: string, schema: ZodType<T>): Promise<T>;
  stop(): Promise<void>;
}

export interface SessionRequest {
  taskId?: string;
  threadId?: string;
  kind: AgentRunKind;
  mode: AgentMode;
  workspace: string;
  instructions: string;
  allowedCommands?: readonly string[];
  tools?: readonly AgentTool<never>[];
  resumeId?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

const MAX_TEXT = 20_000;
const MAX_OUTPUT = 4_000;
const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (shortened)` : text);

const LIGHT_KINDS: readonly AgentRunKind[] = ['ask', 'request', 'task-chat', 'extract', 'size', 'spec', 'review'];

/** The model picked for this task or chat ('' = none, use the defaults in Settings). */
export async function pickedModel(deps: Pick<WorkflowDeps, 'store'>, scope: { taskId?: string | undefined; threadId?: string | undefined }): Promise<string> {
  if (scope.taskId) return (await deps.store.tasks.get(scope.taskId))?.model ?? '';
  if (scope.threadId) return (await deps.store.threads.get(scope.threadId))?.model ?? '';
  return '';
}

/**
 * Every agent session goes through here: budget check before each prompt, usage recorded after,
 * events forwarded (redacted), an AgentRun row per session, and abort on cancel.
 */
export async function openSession(deps: WorkflowDeps, req: SessionRequest): Promise<GatedSession> {
  const settings = await deps.settings();
  const budget = new Budget(deps.store, deps.clock, deps.settings);
  const light = LIGHT_KINDS.includes(req.kind);
  const model = (await pickedModel(deps, req)) || (light ? settings.copilot.lightModel : settings.copilot.buildModel);
  await budget.assertCanSend(req.taskId);
  const maxNanoAiu = await budget.remainingNanoAiu(req.taskId);
  const timeoutMin = req.kind === 'ask' || req.kind === 'request' || req.kind === 'task-chat' ? settings.limits.chatTimeoutMin : req.mode === 'build' ? settings.limits.buildTimeoutMin : settings.limits.readOnlyTimeoutMin;
  const run: AgentRun = {
    id: deps.ids(),
    ...(req.taskId ? { taskId: req.taskId } : {}),
    ...(req.threadId ? { threadId: req.threadId } : {}),
    kind: req.kind,
    mode: req.mode,
    status: 'running',
    attempt: 0,
    startedAt: deps.clock.iso(),
  };
  // The run's story, step by step: saved in order (queued, so the agent never waits on the store).
  const scope = { ...(req.taskId ? { taskId: req.taskId } : {}), ...(req.threadId ? { threadId: req.threadId } : {}) };
  let seq = 0;
  let saving: Promise<void> = Promise.resolve();
  let lastIntent = '';
  const openTools = new Map<string, { tool: string; title?: string; input?: string; started: number }>();
  const step = (s: Omit<AgentStep, 'id' | 'runId' | 'seq' | 'at' | 'taskId' | 'threadId'>) => {
    const full: AgentStep = { id: deps.ids(), runId: run.id, ...scope, seq: seq++, at: deps.clock.iso(), ...s };
    saving = saving
      .then(() => deps.store.agentSteps.add(full))
      .then(() => deps.events?.emit({ type: 'agent.step', ...scope, runId: run.id }))
      .catch((err: unknown) => deps.logger?.warn('could not save an agent step', { runId: run.id, error: String(err) }));
  };
  const log = (e: AgentEvent) => {
    if (e.type === 'tool' && !e.allowed) step({ kind: 'blocked', tool: e.tool, text: e.summary, ...(e.reason ? { output: e.reason } : {}) });
    else if (e.type === 'intent' && e.text.trim() && e.text !== lastIntent) {
      lastIntent = e.text;
      step({ kind: 'intent', text: cap(e.text, 300) });
    } else if (e.type === 'reasoning' && e.text.trim()) step({ kind: 'reasoning', text: cap(e.text, MAX_TEXT) });
    else if (e.type === 'message' && e.text.trim()) step({ kind: 'message', text: cap(e.text, MAX_TEXT) });
    else if (e.type === 'tool-start') openTools.set(e.id, { tool: e.tool, ...(e.title ? { title: e.title } : {}), ...(e.input ? { input: cap(e.input, 600) } : {}), started: Date.now() });
    else if (e.type === 'tool-end') {
      const t = openTools.get(e.id);
      openTools.delete(e.id);
      step({ kind: 'tool', tool: t?.tool ?? 'tool', ...(t?.title ? { title: t.title } : {}), ...(t?.input ? { input: t.input } : {}), ok: e.ok, ...(e.output ? { output: cap(e.output, MAX_OUTPUT) } : {}), ...(e.files?.length ? { files: e.files.slice(0, 50) } : {}), ...(t ? { durationMs: Math.max(0, Date.now() - t.started) } : {}) });
    } else if (e.type === 'error') step({ kind: 'error', text: cap(e.message, 2_000) });
  };
  const emit = (e: AgentEvent) => {
    const safe = e.type === 'delta' ? { ...e, text: redactor.redact(e.text) } : e.type === 'tool' ? { ...e, summary: redactor.redact(e.summary) } : e;
    log(safe);
    req.onEvent?.(safe);
    if (safe.type === 'delta') deps.events?.emit({ type: 'agent.delta', ...(req.taskId ? { taskId: req.taskId } : {}), ...(req.threadId ? { threadId: req.threadId } : {}), runId: run.id, text: safe.text });
    if (safe.type === 'tool') deps.events?.emit({ type: 'agent.tool', ...(req.taskId ? { taskId: req.taskId } : {}), ...(req.threadId ? { threadId: req.threadId } : {}), runId: run.id, tool: safe.tool, summary: safe.summary, allowed: safe.allowed });
  };
  let session: AgentSession;
  try {
    session = await deps.agent.startSession({
      workspace: req.workspace,
      mode: req.mode,
      instructions: req.instructions,
      allowedCommands: req.allowedCommands ?? [],
      ...(req.tools ? { tools: req.tools } : {}),
      ...(model ? { model } : {}),
      tier: light ? 'light' : 'build',
      ...(req.resumeId ? { resumeId: req.resumeId } : {}),
      timeoutMs: timeoutMin * 60_000,
      maxModelCalls: settings.budget.perRunModelCalls,
      maxNanoAiu,
      onEvent: emit,
    });
  } catch (err) {
    await deps.store.runs.upsert({ ...run, status: 'failed', endedAt: deps.clock.iso(), error: redactor.redact(String(err)) });
    throw err;
  }
  run.sessionId = session.id;
  await deps.store.runs.upsert(run);
  const onAbort = () => void session.stop().catch(() => undefined);
  req.signal?.addEventListener('abort', onAbort, { once: true });

  const record = async (usage: { model: string; modelCalls: number; nanoAiu: number }) => {
    await deps.store.usage.add({
      id: deps.ids(),
      ...(req.taskId ? { taskId: req.taskId } : {}),
      ...(req.threadId ? { threadId: req.threadId } : {}),
      runKind: req.kind,
      runId: run.id,
      model: usage.model,
      prompts: 1,
      modelCalls: usage.modelCalls,
      nanoAiu: usage.nanoAiu,
      at: deps.clock.iso(),
    });
  };
  /** The owner's guidance for this task goes with every prompt, so it applies from the next step on. */
  const withGuidance = async (prompt: string) => {
    if (!req.taskId) return prompt;
    const g = (await deps.store.tasks.get(req.taskId))?.guidance ?? [];
    if (!g.length) return prompt;
    return `${prompt}\n\nGuidance from the owner for this task (follow it; if two notes disagree, the later one wins):\n${g.map((x) => `- ${x.text}`).join('\n')}`;
  };
  const guard = async () => {
    if (req.signal?.aborted) throw new Error('Stopped because the task was cancelled.');
    await budget.assertCanSend(req.taskId);
  };
  const finish = async (status: AgentRun['status'], error?: string) => {
    await deps.store.runs.upsert({ ...run, status, endedAt: deps.clock.iso(), ...(error ? { error: redactor.redact(error) } : {}) });
  };
  let failure: string | undefined;
  /** A stopped turn still cost something: record what it used, and explain a credit stop. */
  const failed = async (err: unknown): Promise<unknown> => {
    const partial = (err as { usage?: AgentUsage } | undefined)?.usage;
    if (partial && (partial.modelCalls > 0 || partial.nanoAiu > 0)) await record(partial);
    const out = err instanceof BudgetError ? new BudgetError(await budget.limitMessage(req.taskId)) : err;
    failure = String(out);
    await finish('failed', failure);
    return out;
  };
  return {
    id: session.id,
    runId: run.id,
    send: async (raw) => {
      await guard();
      const prompt = await withGuidance(raw);
      step({ kind: 'prompt', text: cap(prompt, MAX_TEXT) });
      try {
        const turn = await session.send(prompt);
        await record(turn.usage);
        return turn.text;
      } catch (err) {
        throw await failed(err);
      }
    },
    structured: async (raw, schema) => {
      await guard();
      const prompt = await withGuidance(raw);
      step({ kind: 'prompt', text: cap(prompt, MAX_TEXT) });
      try {
        const r = await session.sendStructured(prompt, schema);
        await record(r.usage);
        return r.value;
      } catch (err) {
        throw await failed(err);
      }
    },
    stop: async () => {
      req.signal?.removeEventListener('abort', onAbort);
      await session.stop();
      await saving;
      // A failed run stays failed; closing its session is not a success.
      if (req.signal?.aborted) await finish('aborted', failure);
      else if (!failure) await finish('succeeded');
    },
  };
}
