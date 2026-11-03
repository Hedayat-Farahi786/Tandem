import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DraftUpdateArgs, Requirement, SpecChangeArgs, type ChatMessage, type ChatMode, type ChatThread, type Repo, type Task } from '@tandem/shared';
import type { AgentEvent, AgentTool } from '../ports.js';
import { checkReadiness, type ReadinessResult } from '../policies/ready.js';
import { requirementMarkdown } from '../spec/template.js';
import { ActionError, type TaskService } from '../workflow/service.js';
import { NotFoundError, affectedRepos, loadProject, openSession, refreshReferences, type WorkflowDeps } from '../workflow/context.js';
import { READ_ONLY_RULES } from '../workflow/prompts.js';
import { failuresOf } from '../workflow/verify.js';

export interface ChatReply {
  message: ChatMessage;
  thread: ChatThread;
  readiness?: ReadinessResult;
}

const ASK_RULES = `${READ_ONLY_RULES}
You answer questions about the code in the workspace (one folder per repo). Be concise. Always cite the files and lines you rely on as repo/path:line. If you are not sure, say so.`;

const REQUEST_RULES = `${READ_ONLY_RULES}
You help the owner turn a request into a task that meets Tandem's Definition of Ready: a clear goal, a user story, at least 2 acceptance criteria written as Given/When/Then, example data, affected areas, what is out of scope, and no open questions.
Read the code to ground your questions and to name real files and endpoints. Ask at most 3 short, specific questions per reply.
Every time you learn something, call tandem_update_draft with the fields you can now fill (only send what changed). Estimate size too: changed lines across repos including tests, and the independent features.
Do not invent requirements; ask. Never write code.`;

const TASK_RULES = `${READ_ONLY_RULES}
You answer the owner's questions about this task: its spec, the build, the diff and failing checks. Cite files as repo/path:line.
If the owner asks to change what will be built, call tandem_request_spec_change: kind "redraft" with the feedback for small or unclear changes, or kind "edit" with the full new spec Markdown when the change is precise. Tandem asks the owner to confirm before anything changes. You never change code.`;

/** File references in an answer (repo/path:line or path:line), kept only if the file exists. */
export function extractRefs(text: string, root: string, repos: readonly Repo[]): ChatMessage['refs'] {
  const out: ChatMessage['refs'] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}):(\d{1,6})(?:-\d+)?\b/g)) {
    const path = m[1]!;
    const line = Number(m[2]);
    const first = path.split('/')[0]!;
    const repo = repos.find((r) => r.name === first);
    const candidates = repo ? [{ repo, rel: path.slice(first.length + 1) }] : repos.map((r) => ({ repo: r, rel: path }));
    const hit = candidates.find((c) => existsSync(join(root, c.repo.name, c.rel)));
    if (!hit) continue;
    const key = `${hit.repo.id}:${hit.rel}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: hit.rel, line, repoId: hit.repo.id });
  }
  return out;
}

/** Chat: Ask (read-only questions), Request (clarify until ready, then create the task), task chat. */
/** A thread title from a question: its first line, cut at a word boundary. */
export function shortTitle(text: string, max = 60): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 15)).trimEnd()}…`;
}

export class ChatService {
  constructor(
    private readonly deps: WorkflowDeps,
    private readonly tasks: TaskService,
  ) {}

  async createThread(input: { projectId: string; mode: Exclude<ChatMode, 'task'>; title?: string | undefined }): Promise<ChatThread> {
    await loadProject(this.deps, input.projectId);
    const now = this.deps.clock.iso();
    const t: ChatThread = { id: this.deps.ids(), projectId: input.projectId, mode: input.mode, title: input.title?.trim() || (input.mode === 'ask' ? 'Question' : 'New request'), createdAt: now, updatedAt: now };
    await this.deps.store.threads.upsert(t);
    return t;
  }

  /** The one chat thread of a task (created on first use). */
  async taskThread(taskId: string): Promise<ChatThread> {
    const task = await this.deps.store.tasks.get(taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} not found.`);
    const existing = (await this.deps.store.threads.listFor({ taskId })).find((t) => t.mode === 'task');
    if (existing) return existing;
    const now = this.deps.clock.iso();
    const t: ChatThread = { id: this.deps.ids(), projectId: task.projectId, taskId, mode: 'task', title: `${task.key} chat`, createdAt: now, updatedAt: now };
    await this.deps.store.threads.upsert(t);
    return t;
  }

  async messages(threadId: string): Promise<ChatMessage[]> {
    return this.deps.store.messages.list(threadId);
  }

  private async thread(id: string): Promise<ChatThread> {
    const t = await this.deps.store.threads.get(id);
    if (!t) throw new NotFoundError(`Chat ${id} not found.`);
    return t;
  }

  private async say(threadId: string, role: ChatMessage['role'], content: string, refs: ChatMessage['refs'] = []): Promise<ChatMessage> {
    const m: ChatMessage = { id: this.deps.ids(), threadId, role, content, refs, createdAt: this.deps.clock.iso() };
    await this.deps.store.messages.add(m);
    return m;
  }

  /** Sends a message and streams the reply (agent.delta events and onEvent). */
  async send(threadId: string, text: string, onEvent?: (e: AgentEvent) => void): Promise<ChatReply> {
    const content = text.trim();
    if (!content) throw new ActionError('Write a message first.');
    let thread = await this.thread(threadId);
    if (thread.mode === 'request' && thread.createdTaskId) throw new ActionError('This request already became a task. Use the task chat for changes.');
    await this.say(threadId, 'user', content);
    const project = await loadProject(this.deps, thread.projectId);
    const task = thread.taskId ? await this.deps.store.tasks.get(thread.taskId) : undefined;
    const repos = await affectedRepos(this.deps, task ?? ({ affectedRepoIds: [] } as unknown as Task), project);

    // Read-only workspace: the task folder once it exists, else fresh reference checkouts.
    const taskDir = task ? this.deps.paths.taskDir(task.id) : undefined;
    const root = taskDir && existsSync(taskDir) ? taskDir : await refreshReferences(this.deps, project, repos);

    const tools: AgentTool<never>[] = [];
    if (thread.mode === 'request') tools.push(this.draftTool(threadId, repos) as AgentTool<never>);
    if (thread.mode === 'task') tools.push(this.specChangeTool(threadId) as AgentTool<never>);
    const instructions = thread.mode === 'ask' ? ASK_RULES : thread.mode === 'request' ? REQUEST_RULES : TASK_RULES;
    const session = await openSession(this.deps, {
      ...(task ? { taskId: task.id } : {}),
      threadId,
      kind: thread.mode === 'ask' ? 'ask' : thread.mode === 'request' ? 'request' : 'task-chat',
      mode: 'read-only',
      workspace: root,
      instructions,
      tools,
      ...(thread.sessionId ? { resumeId: thread.sessionId } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    let answer: string;
    try {
      if (session.id !== thread.sessionId) await this.deps.store.threads.upsert({ ...(await this.thread(threadId)), sessionId: session.id });
      answer = await session.send(await this.prompt(thread, content, task, repos));
    } finally {
      await session.stop();
    }
    thread = await this.thread(threadId);
    const reply = await this.say(threadId, 'assistant', answer, extractRefs(answer, root, repos));
    const title = thread.mode === 'request' && thread.title === 'New request' ? thread.draftTitle : thread.mode === 'ask' && thread.title === 'Question' ? shortTitle(content) : undefined;
    thread = { ...thread, updatedAt: this.deps.clock.iso(), ...(title ? { title } : {}) };
    await this.deps.store.threads.upsert(thread);
    this.deps.events?.emit({ type: 'chat.done', threadId, messageId: reply.id });
    return { message: reply, thread, ...(thread.mode === 'request' ? { readiness: checkReadiness(thread.draft ?? Requirement.parse({})) } : {}) };
  }

  private async prompt(thread: ChatThread, text: string, task: Task | undefined, repos: readonly Repo[]): Promise<string> {
    const repoLine = `Repos in the workspace: ${repos.map((r) => `${r.name}/ (${r.role})`).join(', ')}.`;
    if (thread.mode === 'ask') return `${repoLine}\n\nQuestion: ${text}`;
    if (thread.mode === 'request') {
      const draft = thread.draft ?? Requirement.parse({});
      const r = checkReadiness(draft);
      const status = r.ready ? 'The draft meets the Definition of Ready. Tell the owner it is ready and summarise it; ask only if something is clearly wrong.' : `Still missing for the Definition of Ready:\n${r.missing.map((m) => `- ${m.label}`).join('\n')}`;
      return [repoLine, `Draft so far:\n${requirementMarkdown(thread.draftTitle ?? 'Untitled', draft)}`, status, `Owner: ${text}`].join('\n\n');
    }
    if (!task) return text;
    const spec = await this.deps.store.specs.latest(task.id);
    const verify = (await this.deps.store.verifyRuns.list(task.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const fails = verify ? failuresOf(verify).map((f) => `- ${f.kind} \`${f.command}\` failed:\n${f.outputTail.slice(-1_500)}`) : [];
    return [
      repoLine,
      `Task ${task.key} "${task.title}" is ${task.state}${task.step ? ` (${task.step})` : ''}.${task.blockedMessage ? ` Note: ${task.blockedMessage}` : ''}`,
      spec ? `Current spec (version ${spec.version}):\n${spec.markdown.slice(0, 30_000)}` : 'No spec yet.',
      fails.length ? `Latest failing checks:\n${fails.join('\n')}` : '',
      `Owner: ${text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private draftTool(threadId: string, repos: readonly Repo[]): AgentTool<DraftUpdateArgs> {
    return {
      name: 'tandem_update_draft',
      description: 'Update the draft requirement for this request. Send only the fields you can now fill or that changed.',
      schema: DraftUpdateArgs,
      handler: async (a) => {
        const t = await this.thread(threadId);
        const cur = t.draft ?? Requirement.parse({});
        const draft = Requirement.parse({
          ...cur,
          ...(a.goal !== undefined ? { goal: a.goal } : {}),
          ...(a.userStory !== undefined ? { userStory: a.userStory } : {}),
          ...(a.criteria !== undefined ? { criteria: a.criteria } : {}),
          ...(a.exampleData !== undefined ? { exampleData: a.exampleData } : {}),
          ...(a.affectedAreas !== undefined ? { affectedAreas: a.affectedAreas } : {}),
          ...(a.outOfScope !== undefined ? { outOfScope: a.outOfScope } : {}),
          ...(a.openQuestions !== undefined ? { openQuestions: a.openQuestions } : {}),
        });
        const ids = a.affectedRepos ? repos.filter((r) => a.affectedRepos!.includes(r.name)).map((r) => r.id) : undefined;
        await this.deps.store.threads.upsert({ ...t, draft, ...(a.title ? { draftTitle: a.title } : {}), ...(ids?.length ? { draftRepoIds: ids } : {}), ...(a.size ? { draftSize: a.size } : {}), updatedAt: this.deps.clock.iso() });
        const r = checkReadiness(draft);
        return r.ready ? 'Draft updated. It now meets the Definition of Ready.' : `Draft updated. Still missing: ${r.missing.map((m) => m.label).join('; ')}.`;
      },
    };
  }

  private specChangeTool(threadId: string): AgentTool<SpecChangeArgs> {
    return {
      name: 'tandem_request_spec_change',
      description: 'Propose a change to the spec. The owner confirms it in Tandem before anything changes.',
      schema: SpecChangeArgs,
      handler: async (a) => {
        if (a.kind === 'edit' && !a.markdown?.trim()) return 'An edit needs the full new spec Markdown; or use kind "redraft" with feedback.';
        if (a.kind === 'redraft' && !a.feedback?.trim()) return 'A redraft needs feedback describing the change.';
        const t = await this.thread(threadId);
        await this.deps.store.threads.upsert({ ...t, pendingSpecChange: { kind: a.kind, summary: a.summary, ...(a.feedback ? { feedback: a.feedback } : {}), ...(a.markdown ? { markdown: a.markdown } : {}) }, updatedAt: this.deps.clock.iso() });
        return 'Proposed. The owner will see a "Confirm spec change" button.';
      },
    };
  }

  /** Request mode: turns a ready draft into a task (DRAFT -> READINESS). */
  async createTask(threadId: string): Promise<Task> {
    const t = await this.thread(threadId);
    if (t.mode !== 'request') throw new ActionError('Only a request chat can create a task.');
    if (t.createdTaskId) throw new ActionError('This request already became a task.');
    const draft = t.draft ?? Requirement.parse({});
    const r = checkReadiness(draft);
    if (!r.ready) throw new ActionError(`Not ready yet. Missing: ${r.missing.map((m) => m.label).join('; ')}.`);
    const task = await this.tasks.create({
      projectId: t.projectId,
      title: t.draftTitle || t.title,
      requirement: draft,
      ...(t.draftRepoIds?.length ? { affectedRepoIds: t.draftRepoIds } : {}),
      source: 'chat',
      description: (await this.messages(threadId)).filter((m) => m.role === 'user').map((m) => m.content).join('\n\n'),
    });
    if (t.draftSize) await this.deps.store.tasks.upsert({ ...task, sizeEstimate: t.draftSize });
    await this.deps.store.threads.upsert({ ...t, createdTaskId: task.id, updatedAt: this.deps.clock.iso() });
    await this.say(threadId, 'system', `Created ${task.key}. Tandem is checking readiness and size, then drafts the spec.`);
    return this.tasks.submit(task.id);
  }

  /** Task chat: applies the proposed spec change after the owner confirms it. */
  async applySpecChange(threadId: string): Promise<Task> {
    const t = await this.thread(threadId);
    if (!t.taskId || !t.pendingSpecChange) throw new ActionError('There is no proposed spec change to confirm.');
    const change = t.pendingSpecChange;
    const { pendingSpecChange: _done, ...rest } = t;
    await this.deps.store.threads.upsert({ ...rest, updatedAt: this.deps.clock.iso() });
    if (change.kind === 'edit') {
      const r = await this.tasks.editSpec(t.taskId, change.markdown ?? '');
      await this.say(threadId, 'system', `Spec version ${r.version} saved. Earlier approvals no longer count.${r.problems.length ? ` Problems to fix: ${r.problems.join(' ')}` : ''}`);
      return r.task;
    }
    const task = await this.tasks.requestChanges(t.taskId, change.feedback ?? change.summary);
    await this.say(threadId, 'system', 'Redrafting the spec with your change. Earlier approvals will not count for the new version.');
    return task;
  }

  async dismissSpecChange(threadId: string): Promise<void> {
    const t = await this.thread(threadId);
    const { pendingSpecChange: _gone, ...rest } = t;
    await this.deps.store.threads.upsert({ ...rest, updatedAt: this.deps.clock.iso() });
  }
}
