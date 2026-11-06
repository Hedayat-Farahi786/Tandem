import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Budget, settingAt } from '@tandem/core';
import { inspectMirror } from '@tandem/adapters';
import { findLocalClones, readLocalClone } from '../local-clones.js';
import { Project, Repo, RepoCommands, RepoRole, Settings, PmGate, estimateTaskCredits, type ModelOption } from '@tandem/shared';
import { HttpError, type ServerContext } from '../app.js';
import { doctorHosted, runDoctor } from '../doctor.js';
import { auditOwner, settingsDiff } from '../audit.js';

const SecretName = z.enum(['jira-token', 'github-token']);

const ProjectInput = z.object({
  name: z.string().trim().min(1, 'Give the project a name'),
  repoIds: z.array(z.string()).min(1, 'Add at least one repository'),
  contractOrder: z.array(z.string()).optional(),
  specRepoId: z.string().optional(),
  integrationCommand: z.string().optional(),
  pmGate: PmGate.default('tandem'),
  pmNames: z.array(z.string()).default([]),
  jiraPmAccountIds: z.array(z.string()).default([]),
  jiraPmNames: z.record(z.string(), z.string().max(200)).default({}),
  jiraProjectKey: z.string().max(100).optional(),
  jiraJql: z.string().optional(),
  keyPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Use 2-10 capital letters or digits, starting with a letter').default('TND'),
});

const RepoInput = z.object({
  url: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  defaultBranch: z.string().trim().min(1),
  role: RepoRole,
  commands: RepoCommands,
  language: z.string().optional(),
  framework: z.string().optional(),
  packageManager: z.string().optional(),
  localPath: z.string().optional(),
});

/** A project saved before its repositories changed may still name old ones in its order or spec repo. */
export function consistent(p: Project): Project {
  const order = [...p.contractOrder.filter((id) => p.repoIds.includes(id)), ...p.repoIds.filter((id) => !p.contractOrder.includes(id))];
  return { ...p, contractOrder: order, specRepoId: p.repoIds.includes(p.specRepoId) ? p.specRepoId : p.repoIds[0]! };
}

export function registerSetupRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { tandem } = ctx;
  /** GitHub or CodeCommit, from a clone URL; a host Tandem may not use here is a plain 400. */
  const detectRepo = (url: string) => {
    try {
      return tandem.codecommit.detect(url) ?? tandem.github.detect(url);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  };
  const store = tandem.store;

  /* ------------------------------------------------------------------ bootstrap and settings */
  app.get('/api/bootstrap', async () => {
    const [stored, repos, settings] = await Promise.all([store.projects.list(), store.repos.list(), tandem.settings()]);
    const projects = stored.map(consistent);
    return {
      setupComplete: projects.length > 0,
      projects,
      repos,
      settings,
      agent: tandem.agent.name,
      /** Test mode: CodeCommit repos come from local copies (TANDEM_TEST_REMOTE_ROOT). */
      localRepoCopies: Boolean(process.env.TANDEM_TEST_REMOTE_ROOT),
      doctor: ctx.doctor.last ?? null,
      jiraConfigured: (await tandem.jira.state().catch(() => ({ connected: false }))).connected,
    };
  });

  app.get('/api/settings', async () => tandem.settings());
  /** Settings fixed by environment variables at start: shown read-only, with the variable's name. */
  app.get('/api/settings/locked', async () => tandem.lockedSettings);
  app.put('/api/settings', async (req) => {
    const given = Settings.parse(req.body);
    // Which Jira, and as whom, is the Jira connection's (Settings › Jira › Connect Jira): a page
    // opened before connecting must not undo it.
    const stored = (await store.settings.get()) ?? given;
    const next = { ...given, jira: { ...given.jira, baseUrl: stored.jira.baseUrl, email: stored.jira.email } };
    // A value set by an environment variable can't change here: saving it would do nothing.
    const current = await tandem.settings();
    const blocked = Object.entries(tandem.lockedSettings).filter(([path]) => JSON.stringify(settingAt(next, path)) !== JSON.stringify(settingAt(current, path)));
    if (blocked.length) throw new HttpError(409, `${blocked.map(([path, env]) => `${path} is set by ${env} when Tandem starts`).join('; ')}. Change it there and restart Tandem.`);
    const before = await store.settings.get();
    await store.settings.set(next);
    const changes = settingsDiff(before, next);
    if (changes.length) await auditOwner(store, { action: 'settings.updated', summary: `Changed ${changes.map((c) => c.field).join(', ')}.`, detail: { changes } });
    return tandem.settings();
  });

  app.get('/api/secrets', async () => {
    const kc = await tandem.secrets.available();
    return { keychain: kc, jiraToken: Boolean(await tandem.secrets.get('jira-token')), githubToken: Boolean(await tandem.secrets.get('github-token')) };
  });
  app.put('/api/secrets/:name', async (req) => {
    const name = SecretName.parse((req.params as { name: string }).name);
    const { value } = z.object({ value: z.string().trim().min(8, 'That token looks too short') }).parse(req.body);
    await tandem.secrets.set(name, value);
    await auditOwner(store, { action: 'secret.saved', summary: `Saved ${name} in the OS keychain.`, detail: { name } });
    return { saved: true };
  });
  app.delete('/api/secrets/:name', async (req) => {
    const name = SecretName.parse((req.params as { name: string }).name);
    await tandem.secrets.delete(name);
    await auditOwner(store, { action: 'secret.removed', summary: `Removed ${name} from the OS keychain.`, detail: { name } });
    return { deleted: true };
  });

  /* ------------------------------------------------------------------ repositories */
  app.get('/api/repos', async () => store.repos.list());

  /** Clones repositories already on this computer that Tandem can work in (GitHub or CodeCommit origin). */
  app.get('/api/repos/local', async () => {
    // Hosted: the server's folders are not anyone's to use.
    if (ctx.hosted) return [];
    const added = new Set((await store.repos.list()).map((r) => r.localPath).filter(Boolean));
    const found = await findLocalClones();
    return found.flatMap((c) => {
      const d = detectRepo(c.remote);
      return d ? [{ path: c.path, name: d.name, remote: c.remote, host: d.host.kind, branch: c.branch, added: added.has(c.path) }] : [];
    });
  });

  /** Clones (or fetches) the repo and suggests role and commands from its default branch. A folder uses that clone as it is. */
  app.post('/api/repos/detect', async (req) => {
    const body = z.object({ url: z.string().trim().min(1).optional(), path: z.string().trim().min(1).optional() }).refine((b) => b.url || b.path, 'Paste the clone URL').parse(req.body);
    let url = body.url ?? '';
    let localPath: string | undefined;
    if (body.path) {
      if (ctx.hosted) throw new HttpError(400, 'In the web app, add repositories from GitHub, CodeCommit or a clone URL.');
      const clone = await readLocalClone(body.path);
      url = clone.remote;
      localPath = clone.path;
    }
    const detected = detectRepo(url);
    if (!detected) throw new HttpError(400, localPath ? `The origin of that clone (${url}) is not on GitHub or CodeCommit.` : 'That is not a CodeCommit or GitHub URL. Use the SSH, HTTPS or codecommit:: clone URL.');
    const draft: Repo = { id: randomUUID(), url, host: detected.host, name: detected.name, defaultBranch: '', role: 'other', commands: {}, ...(localPath ? { localPath } : {}), createdAt: new Date().toISOString() };
    const host = tandem.hostFor(draft);
    let mirror;
    try {
      mirror = await host.mirror(draft);
    } catch (err) {
      throw new HttpError(502, `Could not read ${detected.name}. ${String((err as Error).message ?? err).split('\n').filter(Boolean).slice(0, 4).join(' ')}`);
    }
    const found = await inspectMirror(mirror.path, `refs/remotes/origin/${mirror.defaultBranch}`);
    return {
      repo: { ...draft, defaultBranch: mirror.defaultBranch, role: found.role, commands: found.commands, language: found.language, ...(found.framework ? { framework: found.framework } : {}), ...(found.packageManager ? { packageManager: found.packageManager } : {}) },
      evidence: found.evidence,
    };
  });

  app.post('/api/repos', async (req) => {
    const body = RepoInput.extend({ id: z.string().optional() }).parse(req.body);
    const detected = detectRepo(body.url);
    if (!detected) throw new HttpError(400, 'That is not a CodeCommit or GitHub URL.');
    const existing = (await store.repos.list()).find((r) => r.url === body.url && r.id !== body.id);
    if (existing) throw new HttpError(409, `${existing.name} is already added.`);
    const repo = Repo.parse({ ...body, id: body.id ?? randomUUID(), host: detected.host, name: body.name ?? detected.name, createdAt: new Date().toISOString() });
    await store.repos.upsert(repo);
    await auditOwner(store, { action: body.id ? 'repo.updated' : 'repo.added', summary: `${body.id ? 'Updated' : 'Added'} the repository ${repo.name}.`, repoId: repo.id, detail: { url: repo.url, defaultBranch: repo.defaultBranch, role: repo.role, commands: repo.commands } });
    return repo;
  });

  app.put('/api/repos/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const cur = await store.repos.get(id);
    if (!cur) throw new HttpError(404, 'Repository not found.');
    const body = RepoInput.partial().parse(req.body);
    const next = Repo.parse({ ...cur, ...body, commands: body.commands ? RepoCommands.parse(body.commands) : cur.commands });
    await store.repos.upsert(next);
    await auditOwner(store, { action: 'repo.updated', summary: `Updated the repository ${next.name}: ${Object.keys(body).join(', ')}.`, repoId: next.id, detail: { fields: Object.keys(body), role: next.role, commands: next.commands, defaultBranch: next.defaultBranch } });
    return next;
  });

  app.delete('/api/repos/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const used = (await store.projects.list()).find((p) => p.repoIds.includes(id));
    if (used) throw new HttpError(409, `Remove it from the project "${used.name}" first.`);
    const gone = await store.repos.get(id);
    await store.repos.delete(id);
    if (gone) await auditOwner(store, { action: 'repo.removed', summary: `Removed the repository ${gone.name}.`, repoId: id, detail: { url: gone.url } });
    return { deleted: true };
  });

  app.post('/api/repos/:id/preflight', async (req) => {
    const repo = await store.repos.get((req.params as { id: string }).id);
    if (!repo) throw new HttpError(404, 'Repository not found.');
    return tandem.hostFor(repo).preflight(repo);
  });

  /* ------------------------------------------------------------------ projects */
  app.get('/api/projects', async () => (await store.projects.list()).map(consistent));

  const toProject = async (input: z.infer<typeof ProjectInput>, base?: Project): Promise<Project> => {
    const repos = (await Promise.all(input.repoIds.map((id) => store.repos.get(id)))).filter((r): r is Repo => Boolean(r));
    if (repos.length !== input.repoIds.length) throw new HttpError(400, 'One of the repositories no longer exists.');
    const rank = (r: Repo) => (r.role === 'backend' ? 0 : r.role === 'full-stack' ? 1 : r.role === 'other' ? 2 : 3);
    // The build order and the spec repository only ever name repositories of this project, even
    // when its repositories change (an order or spec repo from before keeps only what still applies).
    const kept = (input.contractOrder ?? []).filter((id) => input.repoIds.includes(id));
    const contractOrder = [...kept, ...[...repos].sort((a, b) => rank(a) - rank(b)).map((r) => r.id).filter((id) => !kept.includes(id))];
    const specRepoId = input.specRepoId && input.repoIds.includes(input.specRepoId) ? input.specRepoId : (repos.find((r) => r.role === 'full-stack') ?? repos.find((r) => r.role === 'backend') ?? repos[0]!).id;
    if (input.pmGate === 'jira' && input.jiraPmAccountIds.length === 0) throw new HttpError(400, 'Choose the PMs whose replies in Jira count, or pick another way to approve.');
    return Project.parse({ ...base, ...input, contractOrder, specRepoId, id: base?.id ?? randomUUID(), createdAt: base?.createdAt ?? new Date().toISOString() });
  };

  app.post('/api/projects', async (req) => {
    const p = await toProject(ProjectInput.parse(req.body));
    await store.projects.upsert(p);
    await auditOwner(store, { action: 'project.created', summary: `Created the project ${p.name}.`, projectId: p.id, detail: { repoIds: p.repoIds, pmGate: p.pmGate, keyPrefix: p.keyPrefix } });
    return p;
  });
  app.put('/api/projects/:id', async (req) => {
    const cur = await store.projects.get((req.params as { id: string }).id);
    if (!cur) throw new HttpError(404, 'Project not found.');
    const p = await toProject(ProjectInput.parse({ ...cur, ...(req.body as object) }), cur);
    await store.projects.upsert(p);
    const changed = Object.keys(req.body as object).filter((k) => JSON.stringify((cur as Record<string, unknown>)[k]) !== JSON.stringify((p as Record<string, unknown>)[k]));
    if (changed.length) await auditOwner(store, { action: 'project.updated', summary: `Updated the project ${p.name}: ${changed.join(', ')}.`, projectId: p.id, detail: { changes: changed.map((k) => ({ field: k, from: (cur as Record<string, unknown>)[k] ?? null, to: (p as Record<string, unknown>)[k] ?? null })) } });
    return p;
  });
  app.delete('/api/projects/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const active = (await store.tasks.list()).filter((t) => t.projectId === id && !['DONE', 'CANCELLED'].includes(t.state));
    if (active.length) throw new HttpError(409, `Finish or cancel its ${active.length} open task${active.length > 1 ? 's' : ''} first.`);
    const gone = await store.projects.get(id);
    await store.projects.delete(id);
    if (gone) await auditOwner(store, { action: 'project.deleted', summary: `Deleted the project ${gone.name}.`, projectId: id, detail: { repoIds: gone.repoIds } });
    return { deleted: true };
  });

  /** Jira: import issues by key, or everything matching the project's JQL. */
  app.post('/api/projects/:id/import', async (req) => {
    const p = await store.projects.get((req.params as { id: string }).id);
    if (!p) throw new HttpError(404, 'Project not found.');
    const { keys } = z.object({ keys: z.array(z.string().trim().min(1)).optional() }).parse(req.body ?? {});
    const tasks = await tandem.service.importFromTracker(p, keys);
    return { imported: tasks.map((t) => ({ id: t.id, key: t.key })) };
  });

  /**
   * Models this Copilot account can use, with prices in AI credits per million tokens and an
   * estimate for a typical task (no model call). "Auto" is Tandem's defaults from Settings.
   */
  app.get('/api/copilot/models', async () => {
    const agent = tandem.agent;
    const settings = await tandem.settings();
    const budget = await new Budget(store, tandem.deps.clock, tandem.settings).summary();
    const credits = { today: budget.credits.today, perDay: budget.credits.perDay, perTask: budget.credits.perTask };
    if (!agent.models) return { models: [], auto: { light: settings.copilot.lightModel || null, build: settings.copilot.buildModel || null }, credits };
    let list: ModelOption[];
    try {
      list = await agent.models();
    } catch (err) {
      const why = String((err as Error).message ?? err);
      // The usual two, in words: nobody signed in yet, or an account without a Copilot plan.
      if (/not authenticated|please authenticate/i.test(why)) throw new HttpError(409, "Copilot isn't connected yet. Sign in under Copilot to choose models.");
      if (/not authorized to use this copilot feature|"status":403|forbidden/i.test(why)) throw new HttpError(409, 'This GitHub account has no Copilot plan Tandem can use. Sign in with the account that has one; for Copilot from work, use a company computer (Settings › Workspace).');
      throw new HttpError(502, `Could not list Copilot models: ${why.slice(0, 200)}. Check the Copilot host and run Doctor.`);
    }
    const order = ['Anthropic', 'OpenAI', 'Google', 'Microsoft', 'xAI'];
    const rank = (v: string) => (order.indexOf(v) + 1 || order.length + 1);
    const models = list
      .filter((m) => m.id !== 'auto')
      .map((m) => {
        const estimate = estimateTaskCredits(m);
        return { ...m, ...(estimate !== undefined ? { estimate: Math.round(estimate * 10) / 10 } : {}) };
      })
      .sort((a, b) => rank(a.vendor) - rank(b.vendor) || (a.estimate ?? Infinity) - (b.estimate ?? Infinity) || a.name.localeCompare(b.name));
    const light = settings.copilot.lightModel || (await agent.defaultModel?.('light').catch(() => undefined)) || null;
    const build = settings.copilot.buildModel || (await agent.defaultModel?.('build').catch(() => undefined)) || null;
    return { models, auto: { light, build }, credits };
  });

  /* ------------------------------------------------------------------ doctor and usage */
  app.get('/api/doctor', async () => ctx.doctor.last ?? null);
  app.post('/api/doctor', async () => {
    ctx.doctor.running ??= runDoctor(tandem, tandem.agent, { onCheck: (c) => ctx.bus.emit({ type: 'doctor.check', id: c.id, status: c.status, message: c.message }), ...doctorHosted(ctx) }).finally(() => {
      ctx.doctor.running = undefined;
    });
    ctx.doctor.last = await ctx.doctor.running;
    return ctx.doctor.last;
  });

  app.get('/api/usage', async () => {
    const budget = new Budget(store, tandem.deps.clock, tandem.settings);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const records = await store.usage.list({ since });
    return { ...(await budget.summary()), last30Days: { prompts: records.reduce((n, r) => n + r.prompts, 0), modelCalls: records.reduce((n, r) => n + r.modelCalls, 0), aiCredits: records.reduce((n, r) => n + r.nanoAiu, 0) / 1e9 } };
  });
}
