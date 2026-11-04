import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AskOwnerArgs, ContinueArgs, DraftUpdateArgs, RenameTaskArgs, Requirement, type OwnerAnswer, type SkippableCheck, STATE_LABELS, SpecChangeArgs, type ChatMessage, type ChatMode, type ChatThread, type Repo, type Task } from '@tandem/shared';
import type { AgentEvent, AgentTool } from '../ports.js';
import { checkReadiness, type ReadinessResult } from '../policies/ready.js';
import { requirementMarkdown } from '../spec/template.js';
import { ActionError, checkModel, type TaskService } from '../workflow/service.js';
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
Read the code to ground your questions and to name real files and endpoints.
To ask the owner something, call tandem_ask_owner with 1 to 3 questions: a header of one to three words, one short plain question, and 2 to 4 distinct, realistic answers as options (a label of a few words and a one-line description, grounded in the code). Set multiSelect when several answers can apply. The owner can always write their own answer, so never add an "Other" option. Ask only what you cannot find in the code, most important first. After asking, reply with one short sentence and do not repeat the questions.
Every time you learn something, call tandem_update_draft with the fields you can now fill (only send what changed). The title is the change's short name, used for the task and its pull request: 3 to 8 words, starting with a verb, no task number or ticket key, no trailing period (for example "Enable Save only for changed arrows"). Estimate size too: changed lines across repos including tests, and the independent features (useful shipped on their own; an endpoint and the page that shows it are one feature).
Do not invent requirements; ask. Never write code.`;

const TASK_RULES = `${READ_ONLY_RULES}
You answer the owner's questions about this task: its spec, the build, the diff and failing checks. Cite files as repo/path:line.
If the owner asks to change what will be built, call tandem_request_spec_change: kind "redraft" with the feedback for small or unclear changes, or kind "edit" with the full new spec Markdown when the change is precise. Tandem asks the owner to confirm before anything changes. You never change code.
If the task is stuck (blocked, failed, or its pull request needs attention), explain in plain words what went wrong and what you would do. When you and the owner agree on how to go on, call tandem_continue_task with a one-line summary and clear guidance for the agent that will do the work; Tandem asks the owner to confirm.
You never create branches, commits or pull requests yourself, and neither does this chat: Tandem opens the pull requests on its own once the checks pass and the self-review is done, titles each one with the task's short name (never a task key or a status) and keeps it up to date. If the owner wants a different name for the task or its pull requests, call tandem_rename_task; it takes effect at once.
Call tandem_continue_task only when the task is stuck or the owner wants Copilot to work on the code again. Never say you "submitted a handoff" or that the owner must confirm something unless a tool told you so; say plainly what has happened and what Tandem will do next.
If a check fails or hangs for a reason outside the change (for example the test runner can't start on this machine) and the owner wants to go on without it, call tandem_continue_task with skipChecks listing the repo folder and the check (install, lint, typecheck, build, test or integration). Tandem asks the owner to confirm, stops that check if it is running, carries on without it, and says so on the pull request.`;

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
/** A question's header is shown as a chip: at most 24 characters, cut between words. */
function chipText(header: string): string {
  const h = header.trim().replace(/\s+/g, ' ');
  if (h.length <= 24) return h;
  const cut = h.slice(0, 25);
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : h.slice(0, 24)).replace(/[\s,;:.-]+$/, '');
}

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

  async createThread(input: { projectId: string; mode: Exclude<ChatMode, 'task'>; title?: string | undefined; model?: string | undefined }): Promise<ChatThread> {
    await loadProject(this.deps, input.projectId);
    const model = await checkModel(this.deps, input.model ?? '');
    const now = this.deps.clock.iso();
    const t: ChatThread = { id: this.deps.ids(), projectId: input.projectId, mode: input.mode, title: input.title?.trim() || (input.mode === 'ask' ? 'Question' : 'New request'), ...(model ? { model } : {}), createdAt: now, updatedAt: now };
    await this.deps.store.threads.upsert(t);
    return t;
  }

  /** The model this chat uses: its own pick, or its task's for a task chat ('' = defaults). */
  async modelOf(thread: ChatThread): Promise<string> {
    if (thread.mode === 'task' && thread.taskId) return (await this.deps.store.tasks.get(thread.taskId))?.model ?? '';
    return thread.model ?? '';
  }

  /** Picks the model for the chat's next replies. A task chat picks it for the whole task. */
  async setModel(threadId: string, model: string): Promise<ChatThread> {
    const t = await this.thread(threadId);
    if (t.mode === 'task' && t.taskId) {
      await this.tasks.setModel(t.taskId, model);
      return t;
    }
    if (t.createdTaskId) throw new ActionError('This request already became a task. Pick the model in the task.');
    const id = await checkModel(this.deps, model);
    const next: ChatThread = { ...t, updatedAt: this.deps.clock.iso() };
    if (id) next.model = id;
    else delete next.model;
    await this.deps.store.threads.upsert(next);
    return next;
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

  /** A chat by id (throws when missing). */
  async thread(id: string): Promise<ChatThread> {
    const t = await this.deps.store.threads.get(id);
    if (!t) throw new NotFoundError(`Chat ${id} not found.`);
    return t;
  }

  private async say(threadId: string, role: ChatMessage['role'], content: string, refs: ChatMessage['refs'] = [], runId?: string, answers?: OwnerAnswer[]): Promise<ChatMessage> {
    const m: ChatMessage = { id: this.deps.ids(), threadId, role, content, refs, ...(runId ? { runId } : {}), ...(answers?.length ? { answers } : {}), createdAt: this.deps.clock.iso() };
    await this.deps.store.messages.add(m);
    return m;
  }

  /**
   * Sends a message and streams the reply (agent.delta events and onEvent). `answers` are the
   * owner's picks for the agent's questions; any message (answers or not) closes those questions.
   */
  async send(threadId: string, text: string, onEvent?: (e: AgentEvent) => void, answers?: OwnerAnswer[]): Promise<ChatReply> {
    const content = text.trim();
    if (!content) throw new ActionError('Write a message first.');
    let thread = await this.thread(threadId);
    if (thread.mode === 'request' && thread.createdTaskId) throw new ActionError('This request already became a task. Use the task chat for changes.');
    if (thread.pendingQuestions) {
      const { pendingQuestions: _answered, ...rest } = thread;
      thread = rest;
      await this.deps.store.threads.upsert(thread);
    }
    await this.say(threadId, 'user', content, [], undefined, answers);
    const project = await loadProject(this.deps, thread.projectId);
    const task = thread.taskId ? await this.deps.store.tasks.get(thread.taskId) : undefined;
    const repos = await affectedRepos(this.deps, task ?? ({ affectedRepoIds: [] } as unknown as Task), project);

    // Read-only workspace: the task folder once it exists, else fresh reference checkouts.
    const taskDir = task ? this.deps.paths.taskDir(task.id) : undefined;
    const root = taskDir && existsSync(taskDir) ? taskDir : await refreshReferences(this.deps, project, repos);

    const tools: AgentTool<never>[] = [];
    if (thread.mode === 'request') tools.push(this.draftTool(threadId, repos) as AgentTool<never>, this.askTool(threadId) as AgentTool<never>);
    if (thread.mode === 'task') tools.push(this.specChangeTool(threadId) as AgentTool<never>, this.continueTool(threadId, repos) as AgentTool<never>, this.renameTool(threadId) as AgentTool<never>);
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
    const reply = await this.say(threadId, 'assistant', answer, extractRefs(answer, root, repos), session.runId);
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
    const prs = await this.deps.store.prs.list(task.id);
    const prLines = prs.map((p) => `- ${repos.find((r) => r.id === p.repoId)?.name ?? 'repo'}: "${p.title}" (${p.status}) ${p.url}`);
    return [
      repoLine,
      `Task ${task.key} "${task.title}" is ${task.state}${task.step ? ` (${task.step})` : ''}.${task.blockedMessage ? ` Note: ${task.blockedMessage}` : ''}${task.needsAttention ? ` Needs attention: ${task.attentionNotes.join('; ')}` : ''}`,
      prLines.length ? `Pull requests:\n${prLines.join('\n')}` : '',
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
        this.deps.events?.emit({ type: 'thread.updated', threadId });
        const r = checkReadiness(draft);
        return r.ready ? 'Draft updated. It now meets the Definition of Ready.' : `Draft updated. Still missing: ${r.missing.map((m) => m.label).join('; ')}.`;
      },
    };
  }

  /** Request mode: questions for the owner, shown as a card with answers to pick from. */
  private askTool(threadId: string): AgentTool<AskOwnerArgs> {
    return {
      name: 'tandem_ask_owner',
      description: 'Ask the owner 1 to 3 short questions, each with 2 to 4 likely answers to pick from. The owner can also write their own answer.',
      schema: AskOwnerArgs,
      handler: async (a) => {
        const t = await this.thread(threadId);
        const questions = a.questions.map((q, i) => ({
          id: `q${i + 1}`,
          header: chipText(q.header) || `Question ${i + 1}`,
          question: q.question.trim(),
          options: q.options.filter((o) => o.label.trim() && !/^other\b/i.test(o.label.trim())).map((o) => ({ label: o.label.trim(), ...(o.description?.trim() ? { description: o.description.trim() } : {}) })),
          multiSelect: Boolean(q.multiSelect),
        }));
        await this.deps.store.threads.upsert({ ...t, pendingQuestions: { questions, askedAt: this.deps.clock.iso() }, updatedAt: this.deps.clock.iso() });
        this.deps.events?.emit({ type: 'thread.updated', threadId });
        return 'The owner sees your questions as a card with the options, and can also write their own answer. Reply with one short sentence; do not repeat the questions.';
      },
    };
  }

  private renameTool(threadId: string): AgentTool<RenameTaskArgs> {
    return {
      name: 'tandem_rename_task',
      description: 'Rename the task when the owner asks; its open pull requests take the new name at once. Use a short name: 3 to 8 words, no task key.',
      schema: RenameTaskArgs,
      handler: async (a) => {
        const t = await this.thread(threadId);
        if (!t.taskId) return 'This chat has no task.';
        const task = await this.tasks.rename(t.taskId, a.title);
        const prs = (await this.deps.store.prs.list(task.id)).filter((p) => p.status === 'open');
        return `Renamed to "${task.title}".${prs.length ? ` ${prs.length === 1 ? 'Its pull request is' : 'Its pull requests are'} now titled "${task.title}".` : ''}`;
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

  private continueTool(threadId: string, repos: readonly Repo[]): AgentTool<ContinueArgs> {
    return {
      name: 'tandem_continue_task',
      description: 'Propose how the task should go on: a one-line summary for the owner, guidance for the agent that does the work, and optionally checks to skip for this task. The owner confirms in Tandem.',
      schema: ContinueArgs,
      handler: async (a) => {
        if (!a.guidance.trim()) return 'Write the guidance for the agent.';
        const skip: Array<{ repoId?: string; kind: SkippableCheck }> = [];
        for (const c of a.skipChecks ?? []) {
          if (c.kind === 'integration') {
            skip.push({ kind: c.kind });
            continue;
          }
          const repo = repos.find((r) => r.name === c.repo) ?? (repos.length === 1 ? repos[0] : undefined);
          if (!repo) return `Name the repo for the ${c.kind} check: one of ${repos.map((r) => r.name).join(', ')}.`;
          skip.push({ repoId: repo.id, kind: c.kind });
        }
        const t = await this.thread(threadId);
        await this.deps.store.threads.upsert({ ...t, pendingContinue: { summary: a.summary.trim() || 'Continue the task', guidance: a.guidance.trim(), ...(skip.length ? { skipChecks: skip } : {}) }, updatedAt: this.deps.clock.iso() });
        return skip.length ? 'Proposed. The owner will see "Continue with this"; once they confirm, Tandem skips those checks for this task and carries on.' : 'Proposed. The owner will see a "Continue with this" button.';
      },
    };
  }

  /**
   * The owner tells Copilot how to go on, from the task chat: the message is kept in the chat and
   * becomes guidance for the task (see TaskService.continueWith).
   */
  async continueTask(threadId: string, text?: string): Promise<{ task: Task; action: string }> {
    const t = await this.thread(threadId);
    if (!t.taskId) throw new ActionError('Only a task chat can continue a task.');
    const guidance = (text ?? t.pendingContinue?.guidance ?? '').trim();
    if (!guidance) throw new ActionError('Write what Copilot should do.');
    if (text?.trim()) await this.say(threadId, 'user', text.trim());
    // Confirming Copilot's proposal also applies the checks it proposed to skip.
    const skip = text?.trim() ? undefined : t.pendingContinue?.skipChecks;
    const { pendingContinue: _done, ...rest } = t;
    await this.deps.store.threads.upsert({ ...rest, updatedAt: this.deps.clock.iso() });
    const r = await this.tasks.continueWith(t.taskId, guidance, skip?.length ? { skip } : {});
    const repoNames = new Map((await this.deps.store.repos.list()).map((x) => [x.id, x.name]));
    const what = (skip ?? []).map((c) => `${c.kind}${c.repoId ? ` in ${repoNames.get(c.repoId) ?? 'the repo'}` : ''}`).join(', ');
    const note = {
      resumed: what ? `Skipping ${what} for this task and continuing.` : 'Continuing the task with your guidance.',
      fixing: 'Starting another round of fixes with your guidance; the pull request updates when checks pass.',
      redrafting: 'Redrafting the spec with your change. Earlier approvals will not count for the new version.',
      noted: r.task.state === 'PR_OPEN' ? 'Saved with the task. Its pull request is open for review, so Copilot has no step left to take; to change what is built, ask for a spec change.' : 'Noted. Copilot follows this from its next step.',
      skipping: `Skipping ${what} for this task. If it was running, it stopped; Tandem carries on without it and notes it on the pull request.`,
      rechecking: `Skipping ${what} and checking again; the pull request updates when the other checks pass.`,
    }[r.action];
    await this.say(threadId, 'system', note);
    this.deps.events?.emit({ type: 'chat.done', threadId, messageId: '' });
    return r;
  }

  async dismissContinue(threadId: string): Promise<void> {
    const t = await this.thread(threadId);
    const { pendingContinue: _gone, ...rest } = t;
    await this.deps.store.threads.upsert({ ...rest, updatedAt: this.deps.clock.iso() });
  }

  /** When a task gets stuck, Tandem says so in its chat and asks how to go on (like an agent asking for input). */
  async notifyStuck(taskId: string): Promise<void> {
    const task = await this.deps.store.tasks.get(taskId);
    if (!task) return;
    const stuck = task.state === 'BLOCKED' || task.state === 'FAILED' || (task.state === 'PR_OPEN' && task.needsAttention);
    if (!stuck || task.blockedReason === 'split-proposed' || task.blockedReason === 'readiness-missing') return;
    const thread = await this.taskThread(taskId);
    const why = task.state === 'PR_OPEN' ? `The pull request is open, but some checks still fail:\n${task.attentionNotes.map((n) => `- ${n}`).join('\n')}` : (task.blockedMessage ?? `The task stopped at ${STATE_LABELS[task.resumeTo?.state ?? task.state]}.`);
    const last = (await this.deps.store.messages.list(thread.id)).at(-1);
    const text = `I need your help with ${task.key}. ${why}\n\nTell me how to continue and choose **Continue with this**, or ask me what went wrong first.`;
    if (last?.content === text) return;
    const m = await this.say(thread.id, 'assistant', text);
    this.deps.events?.emit({ type: 'chat.done', threadId: thread.id, messageId: m.id });
  }

  /** After Tandem asked for help, say so when the problem resolved itself, so the alarm isn't the last word. */
  async notifyResolved(taskId: string): Promise<void> {
    const task = await this.deps.store.tasks.get(taskId);
    if (!task || !((task.state === 'PR_OPEN' && !task.needsAttention) || task.state === 'DONE')) return;
    const thread = await this.taskThread(taskId);
    // The latest help request, unless a later message already said it was sorted.
    const msgs = await this.deps.store.messages.list(thread.id);
    const help = msgs.findLastIndex((m) => m.role === 'assistant' && m.content.startsWith(`I need your help with ${task.key}.`));
    if (help < 0 || msgs.slice(help + 1).some((m) => m.role === 'assistant' && (m.content.startsWith("That's sorted") || m.content.startsWith(`${task.key} is done`)))) return;
    const text = task.state === 'DONE' ? `${task.key} is done: every pull request is merged.` : "That's sorted: the checks pass and the pull request is up to date. Nothing needs you right now.";
    const m = await this.say(thread.id, 'assistant', text);
    this.deps.events?.emit({ type: 'chat.done', threadId: thread.id, messageId: m.id });
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
      ...(t.model ? { model: t.model } : {}),
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
