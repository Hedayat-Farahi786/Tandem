import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ExtractedRequirement,
  RecordTestArgs,
  ResolveFindingArgs,
  ReviewOutput,
  SizeEstimate,
  type Approval,
  type CriterionTest,
  type PrSyncState,
  type Project,
  type PullRequest,
  type Repo,
  type ReviewFinding,
  type Task,
  type VerifyRun,
} from '@tandem/shared';
import type { AgentTool } from '../ports.js';
import { checkReadiness, readinessMessage } from '../policies/ready.js';
import { decideSize } from '../policies/size.js';
import { redactor } from '../policies/redact.js';
import { buildPrDescription, prTitle } from '../pr/description.js';
import type { StepContext, StepHandlers, StepOutcome } from '../runner/runner.js';
import { DEFAULT_TEMPLATE, finalizeSpec, validateSpec } from '../spec/template.js';
import { specFileName } from '../naming.js';
import { affectedRepos, loadProject, openSession, refreshReferences, repoCommands, repoContext, worktreeOf, type GatedSession, type WorkflowDeps } from './context.js';
import * as P from './prompts.js';
import { failureNotes, failuresOf, verifyAll } from './verify.js';
import { assertDiskSpace, installKey, releaseDependencies, restoreDependencies } from './deps.js';

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asRecord = (v: unknown): Record<string, string> => (v && typeof v === 'object' ? (v as Record<string, string>) : {});

/** Strips a ```markdown fence if the model wrapped its whole answer in one. */
export function unwrapMarkdown(text: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return (m?.[1] ?? text).trim() + '\n';
}

export async function currentSpecTemplate(deps: WorkflowDeps, project: Project): Promise<string> {
  const specRepo = await deps.store.repos.get(project.specRepoId);
  if (specRepo) {
    const p = join(deps.paths.referenceDir(project.id, specRepo.name), 'specs', 'TEMPLATE.md');
    if (existsSync(p)) return readFile(p, 'utf8');
  }
  return DEFAULT_TEMPLATE;
}

/** Approval keys for the current spec version: owner always, PM unless the gate is off. */
export function approvalState(project: Project, version: number, approvals: readonly Approval[]): { owner?: Approval; pm?: Approval; complete: boolean } {
  const owner = approvals.find((a) => a.role === 'owner' && a.specVersion === version);
  const pm = approvals.find((a) => a.role === 'pm' && a.specVersion === version);
  const complete = Boolean(owner) && (project.pmGate === 'off' || Boolean(pm));
  return { ...(owner ? { owner } : {}), ...(pm ? { pm } : {}), complete };
}

function recordTestTool(deps: WorkflowDeps, task: Task, repos: readonly Repo[]): AgentTool<RecordTestArgs> {
  return {
    name: 'tandem_record_test',
    description: 'Record which automated test covers an acceptance criterion. Call once per criterion and test.',
    schema: RecordTestArgs,
    handler: async (args) => {
      const repo = repos.find((r) => r.name === args.repo || r.id === args.repo) ?? (repos.length === 1 ? repos[0] : undefined);
      if (!repo) return `Unknown repo "${args.repo}". Use one of: ${repos.map((r) => r.name).join(', ')}.`;
      if (args.criterion > task.requirement.criteria.length) return `There are only ${task.requirement.criteria.length} criteria.`;
      const existing = await deps.store.criterionTests.list(task.id);
      const next: CriterionTest[] = [
        ...existing.filter((t) => !(t.criterion === args.criterion && t.repoId === repo.id && t.file === args.file && t.name === args.name)),
        { taskId: task.id, criterion: args.criterion, repoId: repo.id, file: args.file, name: args.name, result: 'not-run', scope: 'suite' },
      ];
      await deps.store.criterionTests.replace(task.id, next);
      return `Recorded: criterion ${args.criterion} is covered by ${args.file} › ${args.name}.`;
    },
  };
}

function resolveFindingTool(deps: WorkflowDeps, task: Task): AgentTool<ResolveFindingArgs> {
  return {
    name: 'tandem_resolve_finding',
    description: 'Mark a self-review finding as fixed or dismissed (with a reason).',
    schema: ResolveFindingArgs,
    handler: async (args) => {
      const f = await deps.store.findings.get(args.id);
      if (!f || f.taskId !== task.id) return `No finding with id ${args.id}.`;
      await deps.store.findings.upsert({ ...f, status: args.status, ...(args.note ? { detail: `${f.detail}\n\nResolution: ${args.note}` } : {}) });
      return `Finding ${args.id} marked ${args.status}.`;
    },
  };
}

async function approvedSpec(deps: WorkflowDeps, task: Task, project: Project): Promise<{ markdown: string; version: number }> {
  const latest = await deps.store.specs.latest(task.id);
  if (!latest) throw new Error(`${task.key} has no spec.`);
  const approvals = await deps.store.approvals.list(task.id);
  return { markdown: finalizeSpec(latest.markdown, task, latest.version, approvalState(project, latest.version, approvals).complete ? 'Approved' : 'In review', approvals), version: latest.version };
}

/** The build session, resumed across steps (implement, fix, review fixes, conflicts); `kind` labels the run in the history. */
async function buildSession(deps: WorkflowDeps, ctx: StepContext, project: Project, repos: readonly Repo[], kind: 'build' | 'fix' | 'conflict', extraTools: readonly AgentTool<never>[] = []): Promise<GatedSession> {
  const task = ctx.task;
  const spec = await approvedSpec(deps, task, project);
  const context = (await Promise.all(repos.map(async (r) => `## ${r.name}\n\n${(await repoContext(worktreeOf(deps, task, r))) || '_No instructions._'}`))).join('\n\n');
  const resumeId = typeof task.progress.buildSessionId === 'string' ? task.progress.buildSessionId : undefined;
  const s = await openSession(deps, {
    taskId: task.id,
    kind,
    mode: 'build',
    workspace: deps.paths.taskDir(task.id),
    instructions: P.buildInstructions(context, spec.markdown),
    allowedCommands: repoCommands(repos, project),
    tools: [recordTestTool(deps, task, repos) as AgentTool<never>, ...extraTools],
    ...(resumeId ? { resumeId } : {}),
    signal: ctx.signal,
  });
  if (s.id !== resumeId) await ctx.saveProgress({ buildSessionId: s.id });
  return s;
}

async function readOnlySession(deps: WorkflowDeps, ctx: StepContext, kind: 'extract' | 'size' | 'spec' | 'review', workspace: string, instructions = P.READ_ONLY_RULES): Promise<GatedSession> {
  return openSession(deps, { taskId: ctx.task.id, kind, mode: 'read-only', workspace, instructions, signal: ctx.signal });
}

async function commitRepos(deps: WorkflowDeps, task: Task, repos: readonly Repo[], message: string): Promise<number> {
  let n = 0;
  for (const repo of repos) {
    const wt = worktreeOf(deps, task, repo);
    if ((await deps.git.status(wt)).length === 0) continue;
    if (await deps.git.commitAll(wt, message)) n++;
  }
  return n;
}

function attention(task: Task, notes: readonly string[]): Partial<Task> {
  const merged = [...new Set([...task.attentionNotes, ...notes])];
  return { needsAttention: merged.length > 0, attentionNotes: merged };
}

/* ======================================================================== handlers */

export function workflowHandlers(deps: WorkflowDeps): StepHandlers {
  const repoNames = async (_task: Task) => new Map((await deps.store.repos.list()).map((r) => [r.id, r.name]));

  return {
    /* ---------------------------------------------------------------- READINESS */
    'READINESS:check-ready': async (ctx): Promise<StepOutcome> => {
      let task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const needsExtraction = (task.source === 'jira' || task.requirement.criteria.length === 0) && task.description.trim().length > 0;
      let patch: Partial<Task> = {};
      if (needsExtraction && !task.progress.extracted) {
        const all = await affectedRepos(deps, { ...task, affectedRepoIds: [] }, project);
        const root = await refreshReferences(deps, project, all);
        const s = await readOnlySession(deps, ctx, 'extract', root);
        try {
          const x = await s.structured(P.extractPrompt(task, all), ExtractedRequirement);
          const ids = all.filter((r) => x.affectedRepos.includes(r.name)).map((r) => r.id);
          patch = {
            requirement: { goal: x.goal, userStory: x.userStory, criteria: x.criteria, exampleData: x.exampleData, affectedAreas: x.affectedAreas, outOfScope: x.outOfScope, openQuestions: x.openQuestions },
            affectedRepoIds: ids.length ? ids : task.affectedRepoIds,
            sizeEstimate: x.size,
          };
        } finally {
          await s.stop();
        }
        task = await ctx.saveProgress({ extracted: true });
        task = { ...task, ...patch };
      }
      const r = checkReadiness(task.requirement);
      if (!r.ready) {
        const message = readinessMessage(r);
        const tracker = await deps.tracker();
        await tracker.comment(task.externalKey ?? task.key, `Tandem readiness check for ${task.key}\n\n${message}`);
        return { kind: 'block', reason: 'readiness-missing', message, resumeTo: { state: 'READINESS', step: 'check-ready' }, patch };
      }
      return { kind: 'next', patch };
    },

    'READINESS:check-size': async (ctx): Promise<StepOutcome> => {
      const task = ctx.task;
      if (task.sizeOverride) return { kind: 'goto', state: 'SPEC_DRAFTING', reason: `Size check overridden: ${task.sizeOverride}` };
      const settings = await deps.settings();
      let estimate = task.sizeEstimate;
      if (!estimate) {
        const project = await loadProject(deps, task.projectId);
        const repos = await affectedRepos(deps, task, project);
        const s = await readOnlySession(deps, ctx, 'size', await refreshReferences(deps, project, repos));
        try {
          estimate = await s.structured(P.sizePrompt(task, repos), SizeEstimate);
        } finally {
          await s.stop();
        }
      }
      const d = decideSize(estimate, settings.limits.sizeLineLimit);
      if (d.tooBig) {
        const split = estimate.proposedSplit.map((p, i) => `${i + 1}. ${p.title} (criteria ${p.criteria.join(', ') || '-'})`).join('\n');
        return {
          kind: 'block',
          reason: 'split-proposed',
          message: `This looks too big for one reviewable change.\n${d.reasons.map((r) => `- ${r}`).join('\n')}${split ? `\n\nProposed split:\n${split}` : ''}\n\nAccept the split, or override with a reason.`,
          resumeTo: { state: 'SPEC_DRAFTING' },
          patch: { sizeEstimate: estimate },
        };
      }
      return { kind: 'goto', state: 'SPEC_DRAFTING', reason: `Ready, and about ${estimate.estimatedLines} lines: one reviewable change.`, patch: { sizeEstimate: estimate } };
    },

    /* ---------------------------------------------------------------- SPEC_DRAFTING */
    'SPEC_DRAFTING:refresh-refs': async (ctx) => {
      const project = await loadProject(deps, ctx.task.projectId);
      await refreshReferences(deps, project, await affectedRepos(deps, ctx.task, project));
      return { kind: 'next' };
    },

    'SPEC_DRAFTING:draft': async (ctx): Promise<StepOutcome> => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const template = await currentSpecTemplate(deps, project);
      const latest = await deps.store.specs.latest(task.id);
      const feedback = task.specFeedback?.trim() || undefined;
      const s = await readOnlySession(deps, ctx, 'spec', deps.paths.referenceRoot(project.id));
      let markdown: string;
      let check: ReturnType<typeof validateSpec>;
      try {
        markdown = unwrapMarkdown(await s.send(P.specPrompt(task, { template, repos, ...(feedback ? { feedback } : {}), ...(latest && feedback ? { previous: latest.markdown } : {}) })));
        check = validateSpec(markdown, { template, multiRepo: repos.length > 1 });
        if (!check.valid) {
          markdown = unwrapMarkdown(await s.send(P.specPrompt(task, { template, repos, previous: markdown, problems: check.problems })));
          check = validateSpec(markdown, { template, multiRepo: repos.length > 1 });
        }
      } finally {
        await s.stop();
      }
      const version = (latest?.version ?? 0) + 1;
      await deps.store.specs.add({
        taskId: task.id,
        version,
        markdown: redactor.redact(finalizeSpec(markdown, task, version, 'In review', [])),
        source: latest ? 'redraft' : 'draft',
        ...(feedback ? { feedback } : {}),
        createdAt: deps.clock.iso(),
      });
      const clearFeedback: Partial<Task> = { specFeedback: '' };
      if (!check.valid) {
        return {
          kind: 'block',
          reason: 'spec-invalid',
          message: `Spec version ${version} still has problems after a redraft:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\nEdit the spec to fix them, or retry the draft.`,
          resumeTo: { state: 'SPEC_DRAFTING', step: 'draft' },
          patch: clearFeedback,
        };
      }
      if (project.pmGate === 'jira') {
        const tracker = await deps.tracker();
        const posted = await tracker.comment(task.externalKey ?? task.key, `Spec version ${version} for ${task.key} is ready for PM approval.\n\nReply "approve" to approve it, or "changes: <what to change>".\n\n${finalizeSpec(markdown, task, version, 'In review', [])}`);
        return { kind: 'goto', state: 'SPEC_REVIEW', reason: `Spec version ${version} drafted and sent to the PM in Jira.`, patch: { ...clearFeedback, pmRequestedAt: posted.createdAt } };
      }
      return { kind: 'goto', state: 'SPEC_REVIEW', reason: `Spec version ${version} drafted.`, patch: clearFeedback };
    },

    /* ---------------------------------------------------------------- SPEC_REVIEW */
    'SPEC_REVIEW:await-pm': async (ctx): Promise<StepOutcome> => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      if (project.pmGate !== 'jira' || !task.pmRequestedAt) return { kind: 'idle' };
      const latest = await deps.store.specs.latest(task.id);
      if (!latest) return { kind: 'idle' };
      const approvals = await deps.store.approvals.list(task.id);
      if (approvalState(project, latest.version, approvals).pm) return { kind: 'idle' };
      const settings = await deps.settings();
      const tracker = await deps.tracker();
      const replies = await tracker.readReplies(task.externalKey ?? task.key, task.pmRequestedAt, project.jiraPmAccountIds);
      for (const reply of replies) {
        const text = reply.body.trim();
        if (/^approve(d)?\b/i.test(text)) {
          await deps.store.approvals.upsert({ id: deps.ids(), taskId: task.id, specVersion: latest.version, role: 'pm', name: reply.authorName, date: reply.createdAt, evidence: `Jira comment ${reply.id}${tracker.link(task.externalKey ?? task.key) ? ` on ${tracker.link(task.externalKey ?? task.key)}` : ''}`, method: 'jira', createdAt: deps.clock.iso() });
          await deps.store.audit.append({ at: deps.clock.iso(), actor: 'pm', actorName: reply.authorName, action: 'spec.approved', summary: `${task.key}: PM approval of spec version ${latest.version} by ${reply.authorName}, from a Jira reply.`, taskId: task.id, projectId: task.projectId, detail: { role: 'pm', specVersion: latest.version, method: 'jira', commentId: reply.id, date: reply.createdAt } });
          const all = await deps.store.approvals.list(task.id);
          if (approvalState(project, latest.version, all).complete) return { kind: 'goto', state: 'BUILDING', reason: `Approved by the owner and by ${reply.authorName} (PM, in Jira) for spec version ${latest.version}.` };
          return { kind: 'idle' };
        }
        const changes = /^changes?\s*:\s*([\s\S]+)/i.exec(text);
        if (changes?.[1]) return { kind: 'goto', state: 'SPEC_DRAFTING', step: 'draft', reason: `${reply.authorName} (PM) asked for changes in Jira.`, patch: { specFeedback: changes[1].trim() } };
      }
      return { kind: 'wait', ms: settings.jira.pollIntervalMin * 60_000 };
    },

    /* ---------------------------------------------------------------- BUILDING */
    'BUILDING:prepare-workspace': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      await assertDiskSpace(deps);
      await mkdir(deps.paths.taskDir(task.id), { recursive: true });
      for (const repo of repos) {
        const host = deps.hosts(repo);
        await host.mirror(repo);
        // Always through the host: it reuses a sound worktree and remakes one a crash left broken.
        const path = worktreeOf(deps, task, repo);
        await host.createWorktree(repo, { path, branch: task.branch, base: `origin/${repo.defaultBranch}` });
        // Dependencies already installed for this lockfile appear at once, so the agent can run tests
        // without installing; on a cache miss the first verification installs them.
        const install = repo.commands.install;
        const key = install ? await installKey(path, install).catch(() => undefined) : undefined;
        if (key) await restoreDependencies(deps, repo, path, key).catch(() => false);
      }
      if (!task.progress.rulesApplied) {
        for (const repo of repos) {
          const pending = await deps.store.rules.listPending(repo.id);
          if (!pending.length) continue;
          const file = join(worktreeOf(deps, task, repo), 'docs', 'agent-rules.md');
          await mkdir(dirname(file), { recursive: true });
          if (!existsSync(file)) await writeFile(file, '# Agent rules\n\nRules learned from code review. Tandem appends to this file.\n');
          await appendFile(file, `\n${pending.map((r) => `- ${r.text.replace(/\n/g, ' ')}`).join('\n')}\n`);
          for (const r of pending) await deps.store.rules.upsert({ ...r, status: 'committed', committedInTaskId: task.id });
        }
        await ctx.saveProgress({ rulesApplied: true });
      }
      return { kind: 'next' };
    },

    'BUILDING:implement': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const s = await buildSession(deps, ctx, project, repos, 'build');
      try {
        for (const [index, repo] of repos.entries()) {
          if (asStringArray(ctx.task.progress.implemented).includes(repo.id)) continue;
          await s.send(P.implementPrompt(task, repo, { order: repos, index, criteriaCount: task.requirement.criteria.length }));
          await ctx.saveProgress({ implemented: [...asStringArray(ctx.task.progress.implemented), repo.id] });
        }
        const covered = async () => new Set((await deps.store.criterionTests.list(task.id)).map((t) => t.criterion));
        const have = await covered();
        let missing = task.requirement.criteria.map((_, i) => i + 1).filter((n) => !have.has(n));
        if (missing.length && !ctx.task.progress.coveragePrompted) {
          await s.send(P.coveragePrompt(missing));
          await ctx.saveProgress({ coveragePrompted: true });
          const now = await covered();
          missing = missing.filter((n) => !now.has(n));
        }
        if (missing.length) return { kind: 'next', patch: attention(ctx.task, [`No test recorded for acceptance criteria ${missing.join(', ')}.`]) };
        return { kind: 'next' };
      } finally {
        await s.stop();
      }
    },

    'BUILDING:commit': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const spec = await approvedSpec(deps, task, project);
      const specRepo = repos.find((r) => r.id === project.specRepoId) ?? repos[0]!;
      const specPath = join(worktreeOf(deps, task, specRepo), specFileName(task.key, task.slug));
      await mkdir(dirname(specPath), { recursive: true });
      await writeFile(specPath, spec.markdown);
      await commitRepos(deps, task, repos, `feat(${task.key}): ${task.title}`);
      return { kind: 'goto', state: 'VERIFYING', reason: 'Implementation committed; running checks.' };
    },

    /* ---------------------------------------------------------------- VERIFYING */
    'VERIFYING:verify': async (ctx) => {
      const project = await loadProject(deps, ctx.task.projectId);
      const repos = await affectedRepos(deps, ctx.task, project);
      const settings = await deps.settings();
      const names = await repoNames(ctx.task);
      for (;;) {
        const attempt = typeof ctx.task.progress.fixAttempts === 'number' ? ctx.task.progress.fixAttempts : 0;
        const { run } = await verifyAll(deps, ctx.task, project, repos, attempt);
        if (run.passed) return { kind: 'goto', state: 'SELF_REVIEW', reason: attempt ? `All checks pass after ${attempt} fix attempt${attempt > 1 ? 's' : ''}.` : 'All checks pass.' };
        if (attempt >= settings.limits.maxFixAttempts) {
          return { kind: 'goto', state: 'SELF_REVIEW', reason: `Checks still fail after ${attempt} fix attempts; continuing and marking the PR "needs attention".`, patch: attention(ctx.task, failureNotes(run, names)) };
        }
        await ctx.saveProgress({ fixAttempts: attempt + 1 });
        const s = await buildSession(deps, ctx, project, repos, 'fix');
        try {
          await s.send(P.fixPrompt(failuresOf(run), attempt + 1, settings.limits.maxFixAttempts, names));
        } finally {
          await s.stop();
        }
        await commitRepos(deps, ctx.task, repos, `fix(${ctx.task.key}): address verification failures (attempt ${attempt + 1})`);
      }
    },

    /* ---------------------------------------------------------------- SELF_REVIEW */
    'SELF_REVIEW:review': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const names = await repoNames(task);
      if (!task.progress.reviewed) {
        const diff = (await Promise.all(repos.map(async (r) => `# repo: ${r.name}\n${await deps.git.diff(worktreeOf(deps, task, r), `origin/${r.defaultBranch}`)}`))).join('\n');
        const rules = (await Promise.all(repos.map(async (r) => repoContext(worktreeOf(deps, task, r))))).join('\n\n');
        const spec = await approvedSpec(deps, task, project);
        const s = await readOnlySession(deps, ctx, 'review', deps.paths.taskDir(task.id));
        let out: ReviewOutput;
        try {
          out = await s.structured(P.reviewPrompt({ spec: spec.markdown, diff, rules }), ReviewOutput);
        } finally {
          await s.stop();
        }
        const findings: ReviewFinding[] = out.findings.map((f, i) => {
          const repo = repos.find((r) => r.name === f.repo);
          return { id: `${task.key}-F${i + 1}`, taskId: task.id, severity: f.severity, category: f.category, ...(repo ? { repoId: repo.id } : {}), ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), title: f.title, detail: f.detail, status: 'open' };
        });
        await deps.store.findings.replace(task.id, findings);
        await ctx.saveProgress({ reviewed: true });
      }
      // Copilot fixes what matters (medium, high); low findings stay open and are listed on the PR for the
      // reviewer, instead of a fix run and another round of checks for a nit.
      const open = (await deps.store.findings.list(task.id)).filter((f) => f.status === 'open' && f.severity !== 'low');
      // A fix run that was stopped (credit limit, restart) may already have marked its findings fixed
      // without its edits being committed: commit and check them instead of leaving them behind.
      const started = ctx.task.progress.reviewFixStarted === true;
      if ((open.length || started) && !ctx.task.progress.reviewFixDone) {
        if (open.length) {
          await ctx.saveProgress({ reviewFixStarted: true });
          const s = await buildSession(deps, ctx, project, repos, 'fix', [resolveFindingTool(deps, task) as AgentTool<never>]);
          try {
            await s.send(P.reviewFixPrompt(open));
          } finally {
            await s.stop();
          }
        }
        await commitRepos(deps, ctx.task, repos, `fix(${task.key}): address self-review findings`);
        await ctx.saveProgress({ reviewFixDone: true });
        const { run } = await verifyAll(deps, ctx.task, project, repos, 100);
        if (!run.passed) return { kind: 'next', patch: attention(ctx.task, failureNotes(run, names).map((n) => `After review fixes: ${n}`)) };
      }
      return { kind: 'next' };
    },

    'SELF_REVIEW:sync': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const names = await repoNames(task);
      // Edits an interrupted run left uncommitted would block the rebase: keep them, and check them.
      let leftover: Partial<Task> | undefined;
      if (await commitRepos(deps, task, repos, `fix(${task.key}): keep changes from an interrupted Copilot run`)) {
        const { run } = await verifyAll(deps, task, project, repos, 150);
        if (!run.passed) leftover = attention(task, failureNotes(run, names).map((n) => `After an interrupted run: ${n}`));
      }
      for (const repo of repos) {
        const host = deps.hosts(repo);
        await host.mirror(repo);
        const wt = { repoId: repo.id, path: worktreeOf(deps, task, repo), branch: task.branch, base: `origin/${repo.defaultBranch}` };
        const r = await host.rebase(repo, wt);
        if (r.kind === 'ok') continue;
        const s = await buildSession(deps, ctx, project, repos, 'conflict');
        try {
          await s.send(P.conflictPrompt(repo, r.files));
        } finally {
          await s.stop();
        }
        const left = await deps.git.conflictedFiles(wt.path);
        if (left.length) {
          await deps.git.abortRebase(wt.path);
          return { kind: 'block', reason: 'rebase-conflict', message: `Rebasing ${repo.name} onto ${repo.defaultBranch} conflicts in ${r.files.join(', ')}, and the agent could not resolve ${left.join(', ')}. Resolve it on branch ${task.branch}, then retry.`, resumeTo: { state: 'SELF_REVIEW', step: 'sync' } };
        }
        await deps.git.continueRebase(wt.path);
        const { run } = await verifyAll(deps, ctx.task, project, repos, 200);
        if (!run.passed) {
          return {
            kind: 'block',
            reason: 'rebase-conflict',
            message: `The agent resolved the rebase conflict in ${repo.name} (${r.files.join(', ')}), but checks fail afterwards:\n${failureNotes(run, names).map((n) => `- ${n}`).join('\n')}\nFix it on branch ${task.branch}, then retry.`,
            resumeTo: { state: 'SELF_REVIEW', step: 'sync' },
          };
        }
      }
      return { kind: 'next', ...(leftover ? { patch: leftover } : {}) };
    },

    'SELF_REVIEW:push': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const pushed = asRecord(task.progress.pushed);
      for (const repo of repos) {
        const wt = { repoId: repo.id, path: worktreeOf(deps, task, repo), branch: task.branch, base: `origin/${repo.defaultBranch}` };
        const lease = pushed[repo.id];
        const r = await deps.hosts(repo).push(repo, wt, lease ? { forceWithLease: lease } : undefined);
        if (r.kind === 'rejected') return { kind: 'block', reason: 'push-rejected', message: `Pushing ${task.branch} to ${repo.name} was rejected: ${r.message}`, resumeTo: { state: 'SELF_REVIEW', step: 'sync' } };
        pushed[repo.id] = r.sha;
        await ctx.saveProgress({ pushed: { ...pushed } });
        await deps.store.audit.append({ at: deps.clock.iso(), actor: 'system', action: 'git.pushed', summary: `${task.key}: pushed ${task.branch} to ${repo.name} at ${r.sha.slice(0, 7)}.`, taskId: task.id, projectId: task.projectId, repoId: repo.id, detail: { branch: task.branch, commit: r.sha, ...(lease ? { replaced: lease } : {}) } });
      }
      // Waiting on review needs no dependencies: free them (checks restore them from the cache).
      for (const repo of repos) await releaseDependencies(worktreeOf(deps, task, repo)).catch(() => undefined);
      return { kind: 'goto', state: 'PR_OPEN', reason: `Pushed ${task.branch} to ${repos.map((r) => r.name).join(' and ')}.` };
    },

    /* ---------------------------------------------------------------- PR_OPEN */
    'PR_OPEN:open-prs': async (ctx) => {
      const task = ctx.task;
      const project = await loadProject(deps, task.projectId);
      const repos = await affectedRepos(deps, task, project);
      const specRepo = repos.find((r) => r.id === project.specRepoId) ?? repos[0]!;
      const facts = await prFacts(deps, task);
      const describe = (repo: Repo, others: Array<{ repoName: string; url: string }>) => describePr(deps, task, specRepo, repo, others, facts);
      const existing = await deps.store.prs.list(task.id);
      for (const repo of repos) {
        if (existing.some((p) => p.repoId === repo.id)) continue;
        const title = prTitle(task.title);
        const description = describe(repo, []);
        const r = await deps.hosts(repo).openPullRequest({ repo, sourceBranch: task.branch, destinationBranch: repo.defaultBranch, title, description, idempotencyKey: `${task.id}:${repo.id}` });
        const pr: PullRequest = {
          id: deps.ids(),
          taskId: task.id,
          repoId: repo.id,
          ...(r.kind === 'created' ? { providerId: r.providerId } : {}),
          url: r.url,
          title,
          description,
          status: r.kind === 'created' ? 'open' : 'manual-pending',
          manual: r.kind === 'manual',
          createdAt: deps.clock.iso(),
        };
        await deps.store.prs.upsert(pr);
        await deps.store.audit.append({ at: pr.createdAt, actor: 'system', action: pr.manual ? 'pr.prepared' : 'pr.opened', summary: pr.manual ? `${task.key}: no permission to open a pull request in ${repo.name}; prepared a link to create it by hand.` : `${task.key}: opened a pull request in ${repo.name}: ${pr.url}`, taskId: task.id, projectId: task.projectId, repoId: repo.id, detail: { url: pr.url, from: task.branch, into: repo.defaultBranch, ...(pr.providerId ? { providerId: pr.providerId } : {}), commit: asRecord(task.progress.pushed)[repo.id] ?? null } });
        existing.push(pr);
      }
      if (existing.length > 1 && !task.progress.crossLinked) {
        for (const pr of existing) {
          const repo = repos.find((r) => r.id === pr.repoId)!;
          const others = existing.filter((o) => o.id !== pr.id).map((o) => ({ repoName: repos.find((r) => r.id === o.repoId)?.name ?? o.repoId, url: o.url }));
          const description = describe(repo, others);
          if (!pr.manual) await deps.hosts(repo).updatePullRequestDescription(repo, pr, description);
          await deps.store.prs.upsert({ ...pr, description });
        }
        await ctx.saveProgress({ crossLinked: true });
      }
      // After another fix round the open PRs describe the new state of the branch (title too, in Tandem).
      if (ctx.task.progress.refreshPrs) {
        for (const pr of existing) {
          const repo = repos.find((r) => r.id === pr.repoId);
          if (!repo) continue;
          const others = existing.filter((o) => o.id !== pr.id).map((o) => ({ repoName: repos.find((r) => r.id === o.repoId)?.name ?? o.repoId, url: o.url }));
          const description = describe(repo, others);
          const title = prTitle(task.title);
          if (!pr.manual && pr.status === 'open') await deps.hosts(repo).updatePullRequestDescription(repo, pr, description, title);
          await deps.store.prs.upsert({ ...pr, description, title });
        }
        await ctx.saveProgress({ refreshPrs: false });
      }
      return { kind: 'next' };
    },

    'PR_OPEN:report': async (ctx) => {
      const task = ctx.task;
      const settings = await deps.settings();
      const tracker = await deps.tracker();
      const prs = await deps.store.prs.list(task.id);
      const repos = await deps.store.repos.list();
      const tests = await deps.store.criterionTests.list(task.id);
      const lines = [
        `Pull requests for ${task.key} are ready for review${task.needsAttention ? ' (needs attention)' : ''}:`,
        ...prs.map((p) => `- ${repos.find((r) => r.id === p.repoId)?.name ?? p.repoId}: ${p.url}${p.manual ? ' (create it with the prefilled title and description in Tandem)' : ''}`),
        '',
        `Acceptance criteria with a passing test: ${new Set(tests.filter((t) => t.result === 'pass').map((t) => t.criterion)).size} of ${task.requirement.criteria.length}.`,
        ...(task.needsAttention ? ['', 'Needs attention:', ...task.attentionNotes.map((n) => `- ${n}`)] : []),
      ];
      const key = task.externalKey ?? task.key;
      await tracker.comment(key, lines.join('\n'));
      if (tracker.kind === 'jira') await tracker.transition(key, settings.jira.inReviewStatus);
      return { kind: 'next' };
    },

    'PR_OPEN:poll': async (ctx) => {
      const task = ctx.task;
      const settings = await deps.settings();
      const prs = await deps.store.prs.list(task.id);
      for (const pr of prs) {
        if (pr.status === 'merged' || pr.status === 'closed') continue;
        const repo = await deps.store.repos.get(pr.repoId);
        if (!repo) continue;
        const status = await deps.hosts(repo).getPullRequestStatus(repo, pr);
        // A PR opened with an older title format ("[needs attention] KEY: ...") gets the plain name.
        const title = prTitle(task.title);
        if (status === 'open' && !pr.manual && pr.title !== title) {
          const renamed = await deps.hosts(repo).updatePullRequestDescription(repo, pr, pr.description, title).then(() => true, () => false);
          await deps.store.prs.upsert({ ...pr, ...(renamed ? { title } : {}), status, lastPolledAt: deps.clock.iso() });
        } else if (status !== pr.status) await deps.store.prs.upsert({ ...pr, status, lastPolledAt: deps.clock.iso() });
      }
      let fresh = await deps.store.prs.list(task.id);
      if (fresh.length && fresh.every((p) => p.status === 'merged')) return { kind: 'goto', state: 'DONE', reason: 'All pull requests are merged.' };
      await syncWithBase(deps, ctx);
      fresh = await deps.store.prs.list(task.id);
      const closed = fresh.filter((p) => p.status === 'closed');
      const patch = closed.length ? attention(task, closed.map((p) => `A pull request was closed without merging: ${p.url}`)) : undefined;
      return { kind: 'wait', ms: settings.polling.prPollIntervalMin * 60_000, ...(patch ? { patch } : {}) };
    },

    /* ---------------------------------------------------------------- DONE / CANCELLED */
    'DONE:cleanup': async (ctx) => cleanup(deps, ctx, true),
    'CANCELLED:cleanup': async (ctx) => cleanup(deps, ctx, false),
  };
}

async function cleanup(deps: WorkflowDeps, ctx: StepContext, done: boolean): Promise<StepOutcome> {
  const task = ctx.task;
  const project = await deps.store.projects.get(task.projectId);
  if (project) {
    const repos = await affectedRepos(deps, task, project).catch(() => [] as Repo[]);
    for (const repo of repos) {
      const wt = worktreeOf(deps, task, repo);
      if (existsSync(wt)) await deps.git.removeWorktree(repo, wt).catch(() => undefined);
    }
  }
  await rm(deps.paths.taskDir(task.id), { recursive: true, force: true, maxRetries: 3 });
  if (done && task.source === 'jira') {
    const tracker = await deps.tracker();
    await tracker.comment(task.externalKey ?? task.key, `All pull requests for ${task.key} are merged. Tandem marked it Done.`);
  }
  return { kind: 'idle', patch: { progress: { ...task.progress, cleanedUp: true } } };
}


/* ---------------------------------------------------------------- PR descriptions */

type PrFacts = {
  specVersion: number;
  tests: CriterionTest[];
  verification: VerifyRun['results'];
  findings: ReviewFinding[];
  trackerUrl: string | undefined;
};

async function prFacts(deps: WorkflowDeps, task: Task): Promise<PrFacts> {
  const tracker = await deps.tracker();
  const verify = (await deps.store.verifyRuns.list(task.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    specVersion: (await deps.store.specs.latest(task.id))?.version ?? 1,
    tests: await deps.store.criterionTests.list(task.id),
    verification: verify[verify.length - 1]?.results ?? [],
    findings: (await deps.store.findings.list(task.id)).filter((f) => f.status === 'open'),
    trackerUrl: tracker.link(task.externalKey ?? task.key),
  };
}

function describePr(deps: WorkflowDeps, task: Task, specRepo: Repo, repo: Repo, others: Array<{ repoName: string; url: string }>, f: PrFacts): string {
  return buildPrDescription({
    taskKey: task.key,
    title: task.title,
    summary: task.requirement.goal,
    specPath: `${specRepo.name}/${specFileName(task.key, task.slug)}`,
    specVersion: f.specVersion,
    repoName: repo.name,
    criteria: task.requirement.criteria,
    tests: f.tests.filter((t) => t.repoId === repo.id),
    // A check skipped after this run shows as skipped, not as its old failure.
    verification: f.verification.filter((r) => r.repoId === repo.id || !r.repoId).map((r) => (!r.skipped && (task.skippedChecks ?? []).some((c) => c.kind === (r.kind === 'test-single' ? 'test' : r.kind) && c.repoId === r.repoId) ? { ...r, skipped: true, outputTail: `Skipped by the owner: ${(task.skippedChecks ?? []).find((c) => c.kind === r.kind)?.reason ?? ''}` } : r)),
    openFindings: f.findings.filter((x) => !x.repoId || x.repoId === repo.id),
    otherPrs: others,
    ...(f.trackerUrl ? { trackerUrl: f.trackerUrl } : {}),
    needsAttention: task.needsAttention,
    attentionNotes: task.attentionNotes,
    limit: deps.hosts(repo).descriptionLimit,
  });
}

/* ---------------------------------------------------------------- open PRs vs. their base branch */

/**
 * Keeps open PRs mergeable while they wait for review. When the base branch moves and the PR
 * would conflict, Tandem merges the base into the PR branch (a merge commit: no history rewrite,
 * no force push, review comments stay where they are), lets the agent resolve the conflicts, runs
 * every check and pushes only if they pass. A branch someone else has pushed to is left to a
 * person unless they ask (the owner's "Fix conflicts"); a rewritten branch is never touched.
 * Each base/branch pair is handled once, so a conflict the agent could not fix is not retried
 * until the base or the branch moves again, or the owner asks.
 */
async function syncWithBase(deps: WorkflowDeps, ctx: StepContext): Promise<void> {
  const task = ctx.task;
  const settings = await deps.settings();
  const requested = task.progress.syncRequested === true;
  const project = await loadProject(deps, task.projectId);
  const repos = await affectedRepos(deps, task, project);
  const names = new Map(repos.map((r) => [r.id, r.name]));
  const notes: string[] = [];
  for (const pr of await deps.store.prs.list(task.id)) {
    if (pr.status !== 'open' && pr.status !== 'manual-pending') continue;
    const repo = repos.find((r) => r.id === pr.repoId);
    const wt = repo && worktreeOf(deps, task, repo);
    if (!repo || !wt || !existsSync(wt)) continue;
    const host = deps.hosts(repo);
    await host.mirror(repo);
    const base = await deps.git.remoteHead(repo, repo.defaultBranch);
    const head = await deps.git.remoteHead(repo, task.branch);
    if (!base || !head) continue;
    if (!requested && pr.sync?.base === base && pr.sync.head === head) continue;
    const record = async (state: PrSyncState, message: string, files: string[] = [], at = head) => {
      const cur = (await deps.store.prs.list(task.id)).find((p) => p.id === pr.id) ?? pr;
      await deps.store.prs.upsert({ ...cur, sync: { state, base, head: at, files, message, at: deps.clock.iso() } });
      deps.events?.emit({ type: 'task.updated', taskId: task.id, at: deps.clock.iso() });
    };
    const pushed = asRecord(ctx.task.progress.pushed)[repo.id];
    const othersPushed = Boolean(pushed && head !== pushed);
    if (othersPushed && !(await deps.git.isAncestor(repo, pushed!, head))) {
      await record('branch-rewritten', `Someone rewrote ${task.branch} (a force push), so Tandem no longer changes it. If it conflicts with ${repo.defaultBranch}, resolve it on the branch.`);
      continue;
    }
    if (await deps.git.isAncestor(repo, base, head)) {
      await record('up-to-date', `Up to date with ${repo.defaultBranch}.`);
      continue;
    }
    // Work on exactly what the PR holds, including commits others added.
    await deps.git.resetTo(wt, head);
    const files = await deps.git.probeMerge(wt, base);
    if (!files.length) {
      await record('mergeable', `${repo.defaultBranch} has moved on; the PR still merges without conflicts.`);
      continue;
    }
    const list = files.join(', ');
    if (!requested && (othersPushed || !settings.polling.fixConflicts)) {
      const why = othersPushed ? `Someone else has pushed to ${task.branch}, so Tandem leaves it to them.` : 'Fixing conflicts automatically is off in Settings.';
      await record('needs-person', `Conflicts with ${repo.defaultBranch} in ${list}. ${why} Use "Fix conflicts" to let Tandem merge ${repo.defaultBranch} in and resolve it, or resolve it on the branch.`, files);
      notes.push(`${repo.name}: the PR conflicts with ${repo.defaultBranch} in ${list} and waits for a person.`);
      continue;
    }
    const merged = await deps.git.merge(wt, base, `Merge ${repo.defaultBranch} into ${task.branch}`);
    if (merged.kind === 'conflict') {
      const s = await buildSession(deps, ctx, project, repos, 'conflict');
      try {
        await s.send(P.mergeConflictPrompt(repo, merged.files));
      } finally {
        await s.stop();
      }
      const left = await deps.git.conflictedFiles(wt);
      if (left.length) {
        await deps.git.resetTo(wt, head);
        await record('unresolved', `Conflicts with ${repo.defaultBranch} in ${list}. The agent could not resolve ${left.join(', ')}, so nothing was pushed. Resolve it on the branch, or use "Fix conflicts" to try again.`, files);
        notes.push(`${repo.name}: the PR conflicts with ${repo.defaultBranch} in ${list}; the agent could not resolve it.`);
        continue;
      }
      await deps.git.continueMerge(wt);
    }
    const { run } = await verifyAll(deps, ctx.task, project, repos, 300);
    if (!run.passed) {
      await deps.git.resetTo(wt, head);
      const failed = failureNotes(run, names);
      await record('checks-failed', `Tandem resolved the conflicts with ${repo.defaultBranch} in ${list}, but checks fail afterwards, so nothing was pushed:\n${failed.map((n) => `- ${n}`).join('\n')}`, files);
      notes.push(`${repo.name}: resolving the conflict with ${repo.defaultBranch} made checks fail; nothing was pushed.`);
      continue;
    }
    const r = await host.push(repo, { repoId: repo.id, path: wt, branch: task.branch, base: `origin/${repo.defaultBranch}` });
    if (r.kind === 'rejected') continue; // the branch moved meanwhile: the next check starts over from it
    await ctx.saveProgress({ pushed: { ...asRecord(ctx.task.progress.pushed), [repo.id]: r.sha } });
    await deps.store.audit.append({ at: deps.clock.iso(), actor: 'system', action: 'git.pushed', summary: `${task.key}: merged ${repo.defaultBranch} into ${task.branch} in ${repo.name}, checks passed, pushed ${r.sha.slice(0, 7)}.`, taskId: task.id, projectId: task.projectId, repoId: repo.id, detail: { branch: task.branch, commit: r.sha, reason: 'base-merged', conflicts: files } });
    const specRepo = repos.find((x) => x.id === project.specRepoId) ?? repos[0]!;
    const all = await deps.store.prs.list(task.id);
    const others = all.filter((o) => o.id !== pr.id).map((o) => ({ repoName: names.get(o.repoId) ?? o.repoId, url: o.url }));
    const description = describePr(deps, ctx.task, specRepo, repo, others, await prFacts(deps, ctx.task));
    const cur = all.find((p) => p.id === pr.id) ?? pr;
    if (!cur.manual) await host.updatePullRequestDescription(repo, cur, description);
    await deps.store.prs.upsert({ ...cur, description });
    await record('updated', `Merged ${repo.defaultBranch} into the branch${merged.kind === 'conflict' ? ` and resolved the conflicts in ${list}` : ''}; every check passed; pushed ${r.sha.slice(0, 7)}.`, files, r.sha);
    notes.push(`${repo.name}: ${repo.defaultBranch} changed and conflicted with the PR in ${list}. Tandem merged it in, resolved the conflicts and pushed; every check passed. Please review the merge commit.`);
    await releaseDependencies(wt).catch(() => undefined);
  }
  if (requested) await ctx.saveProgress({ syncRequested: false });
  if (notes.length) await (await deps.tracker()).comment(task.externalKey ?? task.key, [`Pull requests for ${task.key}:`, ...notes.map((n) => `- ${n}`)].join('\n'));
}
