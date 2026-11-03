import { Requirement, type Approval, type Project, type PullRequest, type Rule, type Task, type TaskState } from '@tandem/shared';
import { branchName, slugify } from '../naming.js';
import { checkReadiness } from '../policies/ready.js';
import { redactor } from '../policies/redact.js';
import { applyTransition, scheduleJob } from '../runner/transition.js';
import { finalizeSpec, validateSpec } from '../spec/template.js';
import { canTransition } from '../state-machine.js';
import { NotFoundError, affectedRepos, loadProject, type WorkflowDeps } from './context.js';
import { approvalState, currentSpecTemplate } from './steps.js';

export class ActionError extends Error {
  override readonly name = 'ActionError';
}

/** Optional fields as they arrive from forms and APIs (undefined means "not given"). */
export type RequirementPatch = { [K in keyof Requirement]?: Requirement[K] | undefined };

/** Drops undefined entries so a patch never resets a field to its default. */
export function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface NewTaskInput {
  projectId: string;
  title: string;
  description?: string;
  requirement?: RequirementPatch;
  affectedRepoIds?: string[];
  source?: Task['source'];
  externalKey?: string;
  parentTaskId?: string;
  sizeOverride?: string;
  /** Copilot model for every step of the task ('' or absent = the defaults in Settings). */
  model?: string;
}

/** Checks a picked model against the account's models. '' clears the pick. */
export async function checkModel(deps: Pick<WorkflowDeps, 'agent'>, model: string): Promise<string> {
  const id = model.trim();
  if (!id || id === 'auto' || !deps.agent.models) return id;
  let models: Awaited<ReturnType<NonNullable<WorkflowDeps['agent']['models']>>>;
  try {
    models = await deps.agent.models();
  } catch {
    return id; // Copilot unreachable right now: keep the pick, the run reports a bad model clearly.
  }
  if (!models.some((m) => m.id === id)) throw new ActionError(`${id} is not available to this Copilot account. Pick another model.`);
  return id;
}

/** Human actions on tasks. Each is validated against the state machine and stored in one transaction. */
export class TaskService {
  constructor(
    private readonly deps: WorkflowDeps,
    private readonly hooks: { onCancel?: (taskId: string) => void; onWake?: () => void } = {},
  ) {}

  private async task(id: string): Promise<Task> {
    const t = await this.deps.store.tasks.get(id);
    if (!t) throw new NotFoundError(`Task ${id} not found.`);
    return t;
  }

  private requireState(task: Task, states: readonly TaskState[], action: string): void {
    if (!states.includes(task.state)) throw new ActionError(`Can't ${action} while ${task.key} is ${task.state.toLowerCase().replace(/_/g, ' ')}.`);
  }

  async create(input: NewTaskInput): Promise<Task> {
    const { store, clock, ids } = this.deps;
    const project = await loadProject(this.deps, input.projectId);
    const title = input.title.trim();
    if (!title) throw new ActionError('Give the task a title.');
    const repoIds = (input.affectedRepoIds ?? []).filter((id) => project.repoIds.includes(id));
    const task = await store.transaction(async (tx) => {
      const key = input.externalKey ?? `${project.keyPrefix}-${await tx.tasks.nextSeq(project.keyPrefix)}`;
      if (await tx.tasks.getByKey(key)) throw new ActionError(`A task with key ${key} already exists.`);
      const slug = slugify(title);
      const now = clock.iso();
      const t: Task = {
        id: ids(),
        key,
        projectId: project.id,
        title,
        source: input.source ?? 'form',
        ...(input.externalKey ? { externalKey: input.externalKey } : {}),
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        requirement: Requirement.parse(defined(input.requirement ?? {})),
        description: input.description ?? '',
        affectedRepoIds: repoIds.length ? repoIds : project.repoIds,
        state: 'DRAFT',
        needsAttention: false,
        attentionNotes: [],
        ...(input.sizeOverride ? { sizeOverride: input.sizeOverride } : {}),
        ...(input.model ? { model: input.model } : {}),
        progress: {},
        slug,
        branch: branchName(key, slug),
        createdAt: now,
        updatedAt: now,
      };
      await tx.tasks.upsert(t);
      await tx.transitions.add({ taskId: t.id, from: 'DRAFT', to: 'DRAFT', reason: `Created from ${t.source}.`, actor: 'owner', at: now });
      return t;
    });
    this.deps.events?.emit({ type: 'task.updated', taskId: task.id, at: clock.iso() });
    return task;
  }

  /** Picks the Copilot model for the task's next agent steps ('' = the defaults in Settings). */
  async setModel(taskId: string, model: string): Promise<Task> {
    const task = await this.task(taskId);
    if (task.state === 'DONE' || task.state === 'CANCELLED') throw new ActionError(`${task.key} is ${task.state.toLowerCase()}; its model can't change.`);
    const id = await checkModel(this.deps, model);
    const next: Task = { ...task, updatedAt: this.deps.clock.iso() };
    if (id) next.model = id;
    else delete next.model;
    await this.deps.store.tasks.upsert(next);
    this.deps.events?.emit({ type: 'task.updated', taskId, at: this.deps.clock.iso() });
    return next;
  }

  /** Edits the requirement while the task is a draft or blocked on readiness/size. */
  async update(taskId: string, patch: { title?: string | undefined; description?: string | undefined; requirement?: RequirementPatch | undefined; affectedRepoIds?: string[] | undefined }): Promise<Task> {
    const task = await this.task(taskId);
    if (!(task.state === 'DRAFT' || (task.state === 'BLOCKED' && (task.blockedReason === 'readiness-missing' || task.blockedReason === 'split-proposed')))) {
      throw new ActionError(`The requirement of ${task.key} can only change while it is a draft or blocked on readiness. Use the spec for later changes.`);
    }
    const next: Task = {
      ...task,
      ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.requirement ? { requirement: Requirement.parse({ ...task.requirement, ...defined(patch.requirement) }) } : {}),
      ...(patch.affectedRepoIds?.length ? { affectedRepoIds: patch.affectedRepoIds } : {}),
      // A changed requirement needs a fresh size estimate.
      ...(patch.requirement ? { sizeEstimate: undefined, progress: { ...task.progress, extracted: true } } : {}),
      updatedAt: this.deps.clock.iso(),
    } as Task;
    if (patch.requirement) delete next.sizeEstimate;
    await this.deps.store.tasks.upsert(next);
    this.deps.events?.emit({ type: 'task.updated', taskId, at: this.deps.clock.iso() });
    return next;
  }

  /** DRAFT -> READINESS. */
  async submit(taskId: string): Promise<Task> {
    const task = await this.task(taskId);
    this.requireState(task, ['DRAFT'], 'submit');
    return this.move(task, 'READINESS', 'Submitted for the readiness check.', 'owner');
  }

  /** Resumes a blocked or failed task where it stopped (after the owner fixed the cause). */
  async resume(taskId: string): Promise<Task> {
    const task = await this.task(taskId);
    this.requireState(task, ['BLOCKED', 'FAILED'], 'retry');
    if (task.blockedReason === 'split-proposed') throw new ActionError('Accept the proposed split or override it with a reason.');
    const to = task.resumeTo ?? { state: 'READINESS' as TaskState };
    return this.move(task, to.state, task.state === 'FAILED' ? 'Retried by the owner.' : 'Resumed by the owner.', 'owner', to.step);
  }

  async acceptSplit(taskId: string): Promise<Task[]> {
    const task = await this.task(taskId);
    if (task.state !== 'BLOCKED' || task.blockedReason !== 'split-proposed') throw new ActionError(`${task.key} has no proposed split.`);
    const parts = task.sizeEstimate?.proposedSplit ?? [];
    if (parts.length < 2) throw new ActionError('The proposal has fewer than two parts. Override the size check instead, or edit the task.');
    const children: Task[] = [];
    for (const part of parts) {
      const criteria = part.criteria.map((n) => task.requirement.criteria[n - 1]).filter((c): c is NonNullable<typeof c> => Boolean(c));
      const child = await this.create({
        projectId: task.projectId,
        title: part.title,
        description: task.description,
        requirement: { ...task.requirement, criteria: criteria.length ? criteria : task.requirement.criteria, openQuestions: [] },
        affectedRepoIds: task.affectedRepoIds,
        source: 'split',
        parentTaskId: task.id,
        sizeOverride: `Split from ${task.key} by the owner.`,
      });
      children.push(await this.submit(child.id));
    }
    await this.move(task, 'CANCELLED', `Split into ${children.map((c) => c.key).join(', ')}.`, 'owner');
    return children;
  }

  async overrideSplit(taskId: string, reason: string): Promise<Task> {
    const task = await this.task(taskId);
    if (task.state !== 'BLOCKED' || task.blockedReason !== 'split-proposed') throw new ActionError(`${task.key} has no proposed split to override.`);
    if (!reason.trim()) throw new ActionError('Say why this should stay one change.');
    return this.move(task, 'SPEC_DRAFTING', `Size check overridden: ${reason.trim()}`, 'owner', undefined, { sizeOverride: reason.trim() });
  }

  /** Any spec edit creates a new version; approvals for older versions stop counting. */
  async editSpec(taskId: string, markdown: string): Promise<{ task: Task; version: number; problems: string[]; openQuestions: string[] }> {
    const task = await this.task(taskId);
    if (!(task.state === 'SPEC_REVIEW' || (task.state === 'BLOCKED' && task.blockedReason === 'spec-invalid'))) throw new ActionError(`The spec of ${task.key} can be edited while it is in review.`);
    const project = await loadProject(this.deps, task.projectId);
    const repos = await affectedRepos(this.deps, task, project);
    const template = await currentSpecTemplate(this.deps, project);
    const latest = await this.deps.store.specs.latest(task.id);
    const version = (latest?.version ?? 0) + 1;
    const check = validateSpec(markdown, { template, multiRepo: repos.length > 1 });
    await this.deps.store.specs.add({ taskId, version, markdown: redactor.redact(finalizeSpec(markdown, task, version, 'In review', [])), source: 'edit', createdAt: this.deps.clock.iso() });
    let next = task;
    let pmRequestedAt: string | undefined;
    if (project.pmGate === 'jira') {
      const tracker = await this.deps.tracker();
      pmRequestedAt = (await tracker.comment(task.externalKey ?? task.key, `Spec for ${task.key} changed (version ${version}); earlier approvals no longer count. Reply "approve" or "changes: …".\n\n${markdown}`)).createdAt;
    }
    if (task.state === 'BLOCKED') next = await this.move(task, 'SPEC_REVIEW', `Spec edited (version ${version}).`, 'owner', undefined, pmRequestedAt ? { pmRequestedAt } : {});
    else {
      next = { ...task, ...(pmRequestedAt ? { pmRequestedAt } : {}), updatedAt: this.deps.clock.iso() };
      await this.deps.store.transaction(async (tx) => {
        await tx.tasks.upsert(next);
        await tx.transitions.add({ taskId, from: task.state, to: task.state, reason: `Spec edited: version ${version}. Approvals reset.`, actor: 'owner', at: this.deps.clock.iso() });
        if (pmRequestedAt) await scheduleJob(tx, this.deps.clock, { ...next, step: 'await-pm' });
      });
    }
    this.deps.events?.emit({ type: 'task.updated', taskId, at: this.deps.clock.iso() });
    this.hooks.onWake?.();
    return { task: next, version, problems: check.problems, openQuestions: check.openQuestions };
  }

  async requestChanges(taskId: string, feedback: string): Promise<Task> {
    const task = await this.task(taskId);
    this.requireState(task, ['SPEC_REVIEW'], 'request changes');
    if (!feedback.trim()) throw new ActionError('Say what should change.');
    return this.move(task, 'SPEC_DRAFTING', 'Owner requested changes to the spec.', 'owner', 'draft', { specFeedback: feedback.trim() });
  }

  async approve(taskId: string, name: string): Promise<Task> {
    return this.addApproval(taskId, { role: 'owner', name, date: this.deps.clock.iso(), evidence: 'Approved in Tandem' });
  }

  /** PM gate "Recorded in Tandem": the owner records the PM's approval with evidence. */
  async recordPmApproval(taskId: string, input: { name: string; date: string; evidence: string }): Promise<Task> {
    const task = await this.task(taskId);
    const project = await loadProject(this.deps, task.projectId);
    if (project.pmGate !== 'tandem') throw new ActionError(project.pmGate === 'jira' ? 'This project takes PM approval from Jira replies.' : 'This project has no PM approval step.');
    if (!input.evidence.trim()) throw new ActionError('Add a note or a link to where the PM approved.');
    return this.addApproval(taskId, { role: 'pm', ...input });
  }

  private async addApproval(taskId: string, a: { role: Approval['role']; name: string; date: string; evidence: string }): Promise<Task> {
    const task = await this.task(taskId);
    this.requireState(task, ['SPEC_REVIEW'], 'approve');
    if (!a.name.trim()) throw new ActionError('Add the name of the person approving.');
    const project = await loadProject(this.deps, task.projectId);
    const latest = await this.deps.store.specs.latest(taskId);
    if (!latest) throw new ActionError(`${task.key} has no spec yet.`);
    const repos = await affectedRepos(this.deps, task, project);
    const check = validateSpec(latest.markdown, { template: await currentSpecTemplate(this.deps, project), multiRepo: repos.length > 1 });
    if (check.openQuestions.length) throw new ActionError(`Answer the open questions in the spec first: ${check.openQuestions.join('; ')}`);
    if (!check.valid) throw new ActionError(`Fix the spec first: ${check.problems.join(' ')}`);
    const approval: Approval = { id: this.deps.ids(), taskId, specVersion: latest.version, role: a.role, name: a.name.trim(), date: a.date, evidence: a.evidence.trim(), method: 'tandem', createdAt: this.deps.clock.iso() };
    await this.deps.store.approvals.upsert(approval);
    const state = approvalState(project, latest.version, await this.deps.store.approvals.list(taskId));
    if (state.complete) {
      const who = [state.owner?.name, state.pm ? `${state.pm.name} (PM)` : undefined].filter(Boolean).join(' and ');
      return this.move(task, 'BUILDING', `Spec version ${latest.version} approved by ${who}.`, a.role === 'pm' ? 'pm' : 'owner');
    }
    this.deps.events?.emit({ type: 'task.updated', taskId, at: this.deps.clock.iso() });
    return task;
  }

  async cancel(taskId: string): Promise<Task> {
    const task = await this.task(taskId);
    if (!canTransition(task.state, 'CANCELLED')) throw new ActionError(`${task.key} is ${task.state.toLowerCase()} and can't be cancelled.`);
    const next = await this.move(task, 'CANCELLED', 'Cancelled by the owner.', 'owner');
    this.hooks.onCancel?.(taskId);
    return next;
  }

  /** For squash merges and manual PRs the poller can't see. */
  async markMerged(prId: string): Promise<PullRequest> {
    const pr = await this.deps.store.prs.get(prId);
    if (!pr) throw new NotFoundError(`Pull request ${prId} not found.`);
    const next = { ...pr, status: 'merged' as const, lastPolledAt: this.deps.clock.iso() };
    await this.deps.store.prs.upsert(next);
    await this.wakePoll(pr.taskId);
    return next;
  }

  /** After creating a fallback PR by hand, the owner pastes its URL so Tandem can follow it. */
  async setManualPrUrl(prId: string, url: string): Promise<PullRequest> {
    const pr = await this.deps.store.prs.get(prId);
    if (!pr) throw new NotFoundError(`Pull request ${prId} not found.`);
    if (!/^https:\/\//.test(url.trim())) throw new ActionError('Paste the full https:// link of the pull request.');
    const id = /\/pull-requests\/(\d+)/.exec(url)?.[1] ?? /\/pull\/(\d+)/.exec(url)?.[1];
    const next: PullRequest = { ...pr, url: url.trim(), status: 'open', ...(id ? { providerId: id } : {}) };
    await this.deps.store.prs.upsert(next);
    await this.wakePoll(pr.taskId);
    return next;
  }

  async addRule(repoId: string, text: string, source: string): Promise<Rule> {
    if (!(await this.deps.store.repos.get(repoId))) throw new NotFoundError(`Repo ${repoId} not found.`);
    if (!text.trim()) throw new ActionError('Write the rule.');
    const rule: Rule = { id: this.deps.ids(), repoId, text: text.trim(), source, status: 'pending', createdAt: this.deps.clock.iso() };
    await this.deps.store.rules.upsert(rule);
    return rule;
  }

  /** Jira: import one issue by key, or every issue matching the project's JQL. */
  async importFromTracker(project: Project, keys?: readonly string[]): Promise<Task[]> {
    const tracker = await this.deps.tracker();
    if (tracker.kind !== 'jira') throw new ActionError('Jira is not configured. Add a token in Settings to import issues.');
    const found = keys?.length ? (await Promise.all(keys.map((k) => tracker.getTask(k)))).filter((t): t is NonNullable<typeof t> => Boolean(t)) : await tracker.findReadyTasks(project.jiraJql);
    const created: Task[] = [];
    for (const issue of found) {
      if (await this.deps.store.tasks.getByKey(issue.key)) continue;
      const t = await this.create({ projectId: project.id, title: issue.title, description: issue.description, source: 'jira', externalKey: issue.key });
      created.push(await this.submit(t.id));
    }
    return created;
  }

  /** Readiness preview for a requirement (used by chat Request mode and the New task form). */
  readiness(requirement: RequirementPatch) {
    return checkReadiness(Requirement.parse(defined(requirement)));
  }

  private async wakePoll(taskId: string): Promise<void> {
    const job = await this.deps.store.jobs.get(taskId);
    if (job && job.step === 'poll') await this.deps.store.jobs.upsert({ ...job, notBefore: this.deps.clock.now() });
    this.hooks.onWake?.();
  }

  private async move(task: Task, to: TaskState, reason: string, actor: 'owner' | 'pm' | 'system', step?: string, patch: Partial<Task> = {}): Promise<Task> {
    const next = await this.deps.store.transaction(async (tx) => {
      const fresh = await tx.tasks.get(task.id);
      if (!fresh) throw new NotFoundError(`Task ${task.id} not found.`);
      return applyTransition(tx, this.deps.clock, fresh, { to, reason, actor, ...(step ? { step } : {}), patch }, this.deps.events);
    });
    this.hooks.onWake?.();
    return next;
  }
}
