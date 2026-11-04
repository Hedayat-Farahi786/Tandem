import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvalState, checkReadiness, finalizeSpec, stepsOf, validateSpec, currentSpecTemplate, affectedRepos, Budget, ownerNameOf } from '@tandem/core';
import { runGit } from '@tandem/adapters';
import { Requirement, SkippableCheck, TaskState, type Task } from '@tandem/shared';
import { HttpError, type ServerContext } from '../app.js';
import { specPdf } from '../pdf.js';
import { auditOwner } from '../audit.js';

const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : undefined);

/**
 * A task's change in one repo, read from the mirror once its workspace is gone. Before the merge it
 * is the branch against the default branch. Once merged, that difference is empty, so it is the
 * branch against where it started: recorded at push, or the merge commit's other side, or (older
 * tasks merged fast-forward) the parent of the task's own commits.
 */
async function changeInMirror(mirror: string, base: string, task: Task, repoId: string): Promise<string> {
  const g = async (args: string[]) => runGit(args, { gitDir: mirror, allowFail: true });
  let head = sha((task.progress.pushed as Record<string, unknown> | undefined)?.[repoId]);
  if (!head || (await g(['cat-file', '-e', `${head}^{commit}`])).code !== 0) {
    head = undefined;
    for (const ref of [`refs/heads/${task.branch}`, `refs/remotes/origin/${task.branch}`]) {
      const r = await g(['rev-parse', '--verify', '--quiet', ref]);
      if (r.code === 0) {
        head = r.stdout.trim();
        break;
      }
    }
  }
  if (!head) return '';
  const diff = async (from: string) => (await g(['diff', '--no-color', '--no-ext-diff', `${from}...${head}`])).stdout;
  const merged = (await g(['merge-base', '--is-ancestor', head, base])).code === 0;
  if (!merged) return diff(base);
  const from = sha((task.progress.pushedBase as Record<string, unknown> | undefined)?.[repoId]);
  if (from) return diff(from);
  // Merged with a merge commit: the oldest one that brought the branch in; diff against its first parent.
  const merges = (await g(['rev-list', '--ancestry-path', '--merges', '--reverse', `${head}..${base}`])).stdout.split('\n').filter(Boolean);
  for (const m of merges) if ((await g(['merge-base', '--is-ancestor', head, `${m}^1`])).code !== 0) return diff(`${m}^1`);
  // Fast-forward: the task's own commits sit on top of where it started, each naming its key.
  const log = (await g(['log', '--first-parent', '--format=%H %s', '-n', '200', head])).stdout.split('\n').filter(Boolean);
  const mine = (s: string) => s.includes(`(${task.key})`) || s.startsWith(`${task.key}:`) || s.startsWith(`${task.key} `);
  let i = 0;
  while (i < log.length && mine(log[i]!.slice(41))) i++;
  return i > 0 && log[i] ? diff(log[i]!.slice(0, 40)) : '';
}

const id = (req: { params: unknown }) => (req.params as { id: string }).id;

/** Zod 4 applies field defaults even inside .partial(): keep only the fields the client sent, so a PATCH never clears the others. */
export function sentOnly<T extends object>(parsed: T | undefined, raw: unknown): Partial<T> | undefined {
  if (!parsed || !raw || typeof raw !== 'object') return undefined;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<T>;
}

export function registerTaskRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { tandem } = ctx;
  const { store, service } = tandem;

  const getTask = async (taskId: string): Promise<Task> => {
    const t = await store.tasks.get(taskId);
    if (!t) throw new HttpError(404, 'Task not found.');
    return t;
  };

  app.get('/api/tasks', async (req) => {
    const q = z.object({ projectId: z.string().optional(), state: TaskState.optional() }).parse(req.query);
    const tasks = (await store.tasks.list()).filter((t) => (!q.projectId || t.projectId === q.projectId) && (!q.state || t.state === q.state));
    const prs = await store.prs.listByStatus(['open', 'manual-pending', 'merged', 'closed']);
    return tasks
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => ({ ...t, prCount: prs.filter((p) => p.taskId === t.id).length }));
  });

  app.post('/api/tasks', async (req) => {
    const body = z
      .object({
        projectId: z.string(),
        title: z.string().trim().min(1, 'Give the task a title'),
        description: z.string().default(''),
        requirement: Requirement.partial().default({}),
        affectedRepoIds: z.array(z.string()).optional(),
        submit: z.boolean().default(false),
      })
      .parse(req.body);
    const t = await service.create({ projectId: body.projectId, title: body.title, description: body.description, requirement: body.requirement, ...(body.affectedRepoIds ? { affectedRepoIds: body.affectedRepoIds } : {}), source: 'form' });
    return body.submit ? service.submit(t.id) : t;
  });

  /** Readiness preview for the New task form and Request mode. */
  app.post('/api/readiness', async (req) => checkReadiness(Requirement.parse(req.body ?? {})));

  app.get('/api/tasks/:id', async (req) => {
    const task = await getTask(id(req));
    const project = await store.projects.get(task.projectId);
    if (!project) throw new HttpError(404, 'The task’s project no longer exists.');
    const [transitions, specs, approvals, verifyRuns, tests, findings, prs, usage, comments, runs] = await Promise.all([
      store.transitions.list(task.id),
      store.specs.list(task.id),
      store.approvals.list(task.id),
      store.verifyRuns.list(task.id),
      store.criterionTests.list(task.id),
      store.findings.list(task.id),
      store.prs.list(task.id),
      store.usage.list({ taskId: task.id }),
      store.trackerComments.list(task.externalKey ?? task.key),
      store.runs.listFor({ taskId: task.id }),
    ]);
    const latest = specs.at(-1);
    const repos = await affectedRepos(tandem.deps, task, project).catch(() => []);
    const template = await currentSpecTemplate(tandem.deps, project);
    const specCheck = latest ? validateSpec(latest.markdown, { template, multiRepo: repos.length > 1 }) : undefined;
    const budget = await new Budget(store, tandem.deps.clock, tandem.settings).summary(task.id);
    return {
      task,
      project,
      repos,
      steps: stepsOf(task.state),
      readiness: checkReadiness(task.requirement),
      transitions,
      specs: specs.map((s) => ({ version: s.version, source: s.source, feedback: s.feedback, createdAt: s.createdAt })),
      spec: latest ?? null,
      specCheck: specCheck ?? null,
      approvals,
      approvalState: latest ? approvalState(project, latest.version, approvals) : null,
      verifyRuns: verifyRuns.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      tests,
      findings,
      prs,
      comments,
      runs,
      usage: { prompts: usage.reduce((n, u) => n + u.prompts, 0), modelCalls: usage.reduce((n, u) => n + u.modelCalls, 0), aiCredits: usage.reduce((n, u) => n + u.nanoAiu, 0) / 1e9, budget },
      running: tandem.runner.isRunning(task.id),
    };
  });

  app.patch('/api/tasks/:id', async (req) => {
    const body = z.object({ title: z.string().optional(), description: z.string().optional(), requirement: Requirement.partial().optional(), affectedRepoIds: z.array(z.string()).optional() }).parse(req.body);
    return service.update(id(req), { ...body, requirement: sentOnly(body.requirement, (req.body as { requirement?: unknown }).requirement) });
  });

  /** Picks the Copilot model for the task's next agent steps ('' = Auto). */
  app.put('/api/tasks/:id/model', async (req) => {
    const { model } = z.object({ model: z.string() }).parse(req.body);
    const before = await getTask(id(req));
    const t = await service.setModel(id(req), model);
    if ((before.model ?? '') !== model) await auditOwner(store, { action: 'task.model', summary: `${t.key}: Copilot model set to ${model || 'Auto'}.`, taskId: t.id, projectId: t.projectId, detail: { from: before.model ?? '', to: model } });
    return t;
  });
  app.post('/api/tasks/:id/submit', async (req) => service.submit(id(req)));
  app.post('/api/tasks/:id/resume', async (req) => service.resume(id(req)));
  /** The owner tells Copilot how to go on (from the task page); it also shows in the task chat. */
  app.post('/api/tasks/:id/continue', async (req) => {
    const { text } = z.object({ text: z.string() }).parse(req.body);
    const thread = await ctx.chat.taskThread(id(req));
    return ctx.chat.continueTask(thread.id, text);
  });
  /** Skip one check for this task (it fails or hangs for reasons outside the change). */
  app.post('/api/tasks/:id/skip-check', async (req) => {
    const b = z.object({ repoId: z.string().optional(), kind: SkippableCheck, reason: z.string().optional() }).parse(req.body);
    const why = b.reason?.trim() || `Skipped the ${b.kind} check.`;
    const r = await service.continueWith(id(req), why, { skip: [{ repoId: b.repoId, kind: b.kind }] });
    return { action: r.action, task: r.task };
  });
  app.post('/api/tasks/:id/cancel', async (req) => service.cancel(id(req)));
  app.post('/api/tasks/:id/fix-conflicts', async (req) => {
    const t = await service.fixConflicts(id(req));
    await auditOwner(store, { action: 'task.fix-conflicts', summary: `${t.key}: asked Tandem to fix conflicts in its pull requests, including on branches others pushed to.`, taskId: t.id, projectId: t.projectId });
    return t;
  });
  app.post('/api/tasks/:id/accept-split', async (req) => service.acceptSplit(id(req)));
  app.post('/api/tasks/:id/override-split', async (req) => service.overrideSplit(id(req), z.object({ reason: z.string() }).parse(req.body).reason));
  app.post('/api/tasks/:id/request-changes', async (req) => {
    const { feedback } = z.object({ feedback: z.string() }).parse(req.body);
    const t = await service.requestChanges(id(req), feedback);
    await auditOwner(store, { action: 'spec.changes-requested', summary: `${t.key}: requested changes to the spec.`, taskId: t.id, projectId: t.projectId, detail: { feedback } });
    return t;
  });
  app.post('/api/tasks/:id/approve', async (req) => {
    const { name } = z.object({ name: z.string().optional() }).parse(req.body ?? {});
    return service.approve(id(req), name?.trim() || ownerNameOf(await tandem.settings()) || 'Owner');
  });
  app.post('/api/tasks/:id/pm-approval', async (req) => service.recordPmApproval(id(req), z.object({ name: z.string(), date: z.string(), evidence: z.string() }).parse(req.body)));
  app.put('/api/tasks/:id/spec', async (req) => service.editSpec(id(req), z.object({ markdown: z.string().min(1, 'The spec is empty') }).parse(req.body).markdown));

  /** Spec as Markdown or PDF (Copy as Markdown / Export as PDF), with the current approvals. */
  app.get('/api/tasks/:id/spec/:version', async (req, reply) => {
    const task = await getTask(id(req));
    const params = req.params as { version: string };
    const { format } = z.object({ format: z.enum(['md', 'pdf']).default('md') }).parse(req.query);
    const versions = await store.specs.list(task.id);
    const v = params.version === 'latest' ? versions.at(-1) : versions.find((s) => s.version === Number(params.version));
    if (!v) throw new HttpError(404, 'That spec version does not exist.');
    const project = (await store.projects.get(task.projectId))!;
    const approvals = await store.approvals.list(task.id);
    const status = approvalState(project, v.version, approvals).complete ? 'Approved' : v.version === versions.at(-1)?.version ? 'In review' : 'Superseded';
    const md = finalizeSpec(v.markdown, task, v.version, status, approvals);
    const file = `${task.key}-spec-v${v.version}`;
    if (format === 'pdf') {
      const pdf = await specPdf(md, { title: `${task.key}: ${task.title}`, subtitle: `${task.key} · spec version ${v.version} · ${status} · exported ${new Date().toISOString().slice(0, 10)}` });
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${file}.pdf"`).send(pdf);
    }
    return reply.type('text/markdown; charset=utf-8').header('Content-Disposition', `inline; filename="${file}.md"`).send(md);
  });

  /** Per-repo diff: from the task worktree while it exists, else from the pushed branch. */
  app.get('/api/tasks/:id/diff', async (req) => {
    const task = await getTask(id(req));
    const project = (await store.projects.get(task.projectId))!;
    const repos = await affectedRepos(tandem.deps, task, project);
    return Promise.all(
      repos.map(async (repo) => {
        const wt = join(tandem.paths.taskDir(task.id), repo.name);
        const base = `refs/remotes/origin/${repo.defaultBranch}`;
        let diff = '';
        if (existsSync(join(wt, '.git'))) diff = (await runGit(['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`], { cwd: wt, allowFail: true })).stdout;
        else {
          // No workspace any more (the task finished): the change from the mirror, merged or not.
          const mirror = tandem.hostFor(repo).mirrorPath(repo);
          if (existsSync(mirror)) diff = await changeInMirror(mirror, base, task, repo.id);
        }
        return { repoId: repo.id, name: repo.name, branch: task.branch, diff: diff.length > 2_000_000 ? `${diff.slice(0, 2_000_000)}\n… diff truncated …\n` : diff };
      }),
    );
  });

  app.get('/api/tasks/:id/thread', async (req) => ctx.chat.taskThread(id(req)));

  /** What Copilot did on this task, run by run and step by step, with each run's model and cost. */
  app.get('/api/tasks/:id/activity', async (req) => {
    const task = await getTask(id(req));
    const [runs, steps, usage] = await Promise.all([store.runs.listFor({ taskId: task.id }), store.agentSteps.list({ taskId: task.id }), store.usage.list({ taskId: task.id })]);
    return runs
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r) => {
        // Usage before 1.1 has no run id: match it by kind and time.
        const mine = usage.filter((u) => (u.runId ? u.runId === r.id : u.runKind === r.kind && u.at >= r.startedAt && (!r.endedAt || u.at <= r.endedAt)));
        return {
          ...r,
          ...(mine.length ? { model: mine.at(-1)!.model } : {}),
          prompts: mine.reduce((n, u) => n + u.prompts, 0),
          modelCalls: mine.reduce((n, u) => n + u.modelCalls, 0),
          aiCredits: Math.round((mine.reduce((n, u) => n + u.nanoAiu, 0) / 1e9) * 100) / 100,
          // Tandem's instructions to Copilot stay on the server: the Trace shows their fingerprint.
          steps: steps.filter((s) => s.runId === r.id && s.kind !== 'prompt').sort((a, b) => a.seq - b.seq),
        };
      });
  });

  app.post('/api/prs/:id/merged', async (req) => service.markMerged(id(req)));
  app.put('/api/prs/:id/url', async (req) => service.setManualPrUrl(id(req), z.object({ url: z.string() }).parse(req.body).url));

  app.get('/api/rules', async () => store.rules.list());
  app.post('/api/rules', async (req) => {
    const b = z.object({ repoId: z.string(), text: z.string(), source: z.string().default('Added in Tandem') }).parse(req.body);
    const rule = await service.addRule(b.repoId, b.text, b.source);
    await auditOwner(store, { action: 'rule.added', summary: `Added an agent rule: ${b.text}`, repoId: b.repoId, detail: { text: b.text, source: b.source } });
    return rule;
  });
  /** A rule can be taken back until a task has written it into the repository. */
  app.delete('/api/rules/:id', async (req) => {
    const rule = await store.rules.get(id(req));
    if (!rule) throw new HttpError(404, 'Rule not found.');
    if (rule.status === 'committed') throw new HttpError(409, 'This rule is already saved in the repository. Change it there (docs/agent-rules.md).');
    await store.rules.delete(rule.id);
    await auditOwner(store, { action: 'rule.removed', summary: `Removed an agent rule: ${rule.text}`, repoId: rule.repoId, detail: { text: rule.text } });
    return { deleted: true };
  });
}
