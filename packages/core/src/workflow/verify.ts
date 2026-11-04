import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandKind, CommandResult, CriterionTest, Project, Repo, Task, VerifyRun } from '@tandem/shared';
import { redactor } from '../policies/redact.js';
import { worktreeOf, type WorkflowDeps } from './context.js';
import { checkKey, trackCheck } from './live-checks.js';
import { baselineFor, compactOutput, newFailures, summarizeFailures } from './baseline.js';
import { assertDiskSpace, detachDependencies, installKey, restoreDependencies, saveDependencies } from './deps.js';

const ORDER: ReadonlyArray<[CommandKind, keyof Repo['commands']]> = [
  ['install', 'install'],
  ['lint', 'lint'],
  ['typecheck', 'typecheck'],
  ['build', 'build'],
  ['test', 'test'],
];

const TAIL = 6_000;

/** Fills a testSingle pattern; values are quoted for the shell. */
export function singleTestCommand(pattern: string, file: string, name: string): string {
  const q = (s: string) => `"${s.replace(/["\\$`]/g, '\\$&')}"`;
  return pattern.replace(/\{file\}/g, q(file)).replace(/\{name\}/g, q(name));
}

/**
 * Deterministic verification, run by Tandem (never by the agent): each repo's install, lint,
 * type-check, build and test commands, each recorded criterion test on its own when the repo has a
 * single-test pattern, then the project's integration command.
 */
export async function verifyAll(deps: WorkflowDeps, taskAtStart: Task, project: Project, reposAtStart: readonly Repo[], attempt: number): Promise<{ run: VerifyRun; tests: CriterionTest[] }> {
  // Read the task and repos again: a long step can outlive a change to a repo's commands, and the
  // owner may have skipped a check since the step began.
  const task = (await deps.store.tasks.get(taskAtStart.id)) ?? taskAtStart;
  const repos = await Promise.all(reposAtStart.map(async (r) => (await deps.store.repos.get(r.id)) ?? r));
  const settings = await deps.settings();
  const skippedNow = async () => (await deps.store.tasks.get(task.id))?.skippedChecks ?? [];
  const isSkipped = (list: Task['skippedChecks'], repoId: string | undefined, kind: CommandKind) => (list ?? []).some((c) => c.kind === (kind === 'test-single' ? 'test' : kind) && (c.repoId ?? undefined) === repoId);
  const timeoutMs = settings.limits.commandTimeoutMin * 60_000;
  const logDir = join(deps.paths.taskDir(task.id), '.tandem', 'verify');
  await mkdir(logDir, { recursive: true });
  const results: CommandResult[] = [];
  const skippedResult = (repo: Repo | undefined, kind: CommandKind, command: string, durationMs = 0): CommandResult => {
    const why = (task.skippedChecks ?? []).find((c) => c.kind === (kind === 'test-single' ? 'test' : kind))?.reason;
    const res: CommandResult = { ...(repo ? { repoId: repo.id } : {}), kind, command, exitCode: null, timedOut: false, durationMs, outputTail: `Skipped by the owner${why ? `: ${why}` : '.'}`, skipped: true };
    results.push(res);
    return res;
  };
  const exec = async (repo: Repo | undefined, kind: CommandKind, command: string, cwd: string, env?: Record<string, string>): Promise<CommandResult> => {
    if (isSkipped(task.skippedChecks, repo?.id, kind)) return skippedResult(repo, kind, command);
    const live = trackCheck(task.id, checkKey(repo?.id, kind));
    const r = await deps.process
      .runCommand(command, {
        cwd,
        timeoutMs,
        signal: live.signal,
        ...(env ? { env } : {}),
        onLine: (line) => deps.events?.emit({ type: 'verify.output', taskId: task.id, ...(repo ? { repoId: repo.id } : {}), kind, line: redactor.redact(line) }),
      })
      .finally(live.done);
    // Stopped because the owner skipped it while it ran.
    if (live.signal.aborted && isSkipped(await skippedNow(), repo?.id, kind)) {
      task.skippedChecks = await skippedNow();
      return skippedResult(repo, kind, command, r.durationMs);
    }
    const raw = redactor.redact(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`);
    const logPath = join(logDir, `${attempt}-${repo?.name ?? 'project'}-${kind}-${results.length}.log`);
    await writeFile(logPath, `$ ${command}\n${raw}\n`);
    // What people and Copilot read: the failures, without colour codes and progress lines.
    const output = compactOutput(raw);
    const res: CommandResult = {
      ...(repo ? { repoId: repo.id } : {}),
      kind,
      command,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      outputTail: output.length > TAIL ? output.slice(-TAIL) : output,
      logPath,
    };
    results.push(res);
    return res;
  };

  const ok = (r: CommandResult) => r.skipped === true || r.preexisting !== undefined || (r.exitCode === 0 && !r.timedOut);
  const failingNames = new Map<string, string[]>();
  /** Install from the dependency cache when the lockfile matches; else install for real and cache it. */
  const install = async (repo: Repo, cmd: string, cwd: string): Promise<CommandResult> => {
    const key = await installKey(cwd, cmd).catch(() => undefined);
    const started = deps.clock.now();
    if (key && (await restoreDependencies(deps, repo, cwd, key).catch(() => false))) {
      const note = `Reused the dependencies installed for an identical lockfile (shared hard links: no download, no extra disk space). Same result as \`${cmd}\`.`;
      const logPath = join(logDir, `${attempt}-${repo.name}-install-${results.length}.log`);
      await writeFile(logPath, `$ ${cmd}\n${note}\n`);
      deps.events?.emit({ type: 'verify.output', taskId: task.id, repoId: repo.id, kind: 'install', line: note });
      const res: CommandResult = { repoId: repo.id, kind: 'install', command: cmd, exitCode: 0, timedOut: false, durationMs: Math.max(0, deps.clock.now() - started), outputTail: note, logPath };
      results.push(res);
      return res;
    }
    await assertDiskSpace(deps);
    await detachDependencies(cwd);
    const r = await exec(repo, 'install', cmd, cwd);
    if (ok(r) && key) await saveDependencies(deps, repo, cwd, key, cmd);
    return r;
  };
  const suitePassed = new Map<string, boolean>();
  for (const repo of repos) {
    const cwd = worktreeOf(deps, task, repo);
    let healthy = true;
    for (const [kind, key] of ORDER) {
      const cmd = repo.commands[key];
      if (!cmd) continue;
      const r = kind === 'install' ? await install(repo, cmd, cwd) : await exec(repo, kind, cmd, cwd);
      if (!ok(r) && kind === 'install') {
        healthy = false;
        break; // nothing else can run without dependencies
      }
      if (kind === 'test' && !r.skipped) suitePassed.set(repo.id, ok(r));
    }
    if (!healthy) suitePassed.set(repo.id, false);
    // A failing check may fail on the base branch too: then only what this change adds is the task's.
    if (healthy) {
      for (const r of results.filter((x) => x.repoId === repo.id && x.kind !== 'install' && !ok(x))) {
        deps.events?.emit({ type: 'verify.output', taskId: task.id, repoId: repo.id, kind: r.kind, line: `Checking whether this already fails on ${repo.defaultBranch}…` });
        const base = await baselineFor(deps, task, repo, r.command, timeoutMs);
        if (!base) continue;
        const mine = summarizeFailures(r.outputTail);
        const cmp = newFailures(mine, base);
        if (!cmp.isNew) {
          r.preexisting = { base: repo.defaultBranch, ...(base.failures !== undefined ? { failures: base.failures } : {}) };
          r.outputTail = `Also fails on ${repo.defaultBranch} before this change${base.failures !== undefined ? ` (${base.failures} failing there)` : ''}; this change adds no failures.\n\n${r.outputTail}`;
          if (r.kind === 'test') {
            suitePassed.delete(repo.id);
            if (mine.names?.length) failingNames.set(repo.id, mine.names);
          }
        } else if (base.failed) {
          const what = cmp.names?.length ? `New failures (they pass on ${repo.defaultBranch}): ${cmp.names.join('; ')}` : `${cmp.count ?? 'Some'} more failing than on ${repo.defaultBranch}`;
          r.outputTail = `${what}. ${base.failures ?? 'Other'} failures also happen on ${repo.defaultBranch} and are not this change's: leave them.\n\n${r.outputTail}`;
        }
      }
    }
    // A repo's own checks may change files (lint --fix, a formatter): keep that like a developer
    // would, or the uncommitted changes block the next rebase.
    const kept = await deps.git.commitTracked(cwd, `style(${task.key}): keep what ${repo.name}'s checks changed`).catch(() => undefined);
    if (kept) {
      deps.events?.emit({ type: 'verify.output', taskId: task.id, repoId: repo.id, kind: 'lint', line: `Kept the changes ${repo.name}'s checks made to its files.` });
      await deps.store.audit.append({ at: deps.clock.iso(), actor: 'system', action: 'git.committed', summary: `${task.key}: committed the changes ${repo.name}'s own checks made (lint --fix, a formatter).`, taskId: task.id, projectId: task.projectId, repoId: repo.id, detail: { commit: kept, message: `style(${task.key}): keep what ${repo.name}'s checks changed`, branch: task.branch, files: [] } });
    }
  }

  const recorded = await deps.store.criterionTests.list(task.id);
  const tests: CriterionTest[] = [];
  for (const t of recorded) {
    const repo = repos.find((r) => r.id === t.repoId);
    const suite = suitePassed.get(t.repoId);
    if (repo?.commands.testSingle) {
      const r = await exec(repo, 'test-single', singleTestCommand(repo.commands.testSingle, t.file, t.name), worktreeOf(deps, task, repo));
      tests.push({ ...t, scope: 'single', result: r.skipped ? 'not-run' : ok(r) ? 'pass' : 'fail' });
    } else {
      // A suite that fails on the base branch too: a test passes unless it is among the failures.
      const failing = failingNames.get(t.repoId);
      tests.push({ ...t, scope: 'suite', result: suite !== undefined ? (suite ? 'pass' : 'fail') : failing ? (failing.some((n) => n.includes(t.name)) ? 'fail' : 'pass') : 'not-run' });
    }
  }
  await deps.store.criterionTests.replace(task.id, tests);

  if (project.integrationCommand) {
    const env: Record<string, string> = { TANDEM_TASK_DIR: deps.paths.taskDir(task.id) };
    for (const r of repos) env[`TANDEM_REPO_${r.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = worktreeOf(deps, task, r);
    await exec(undefined, 'integration', project.integrationCommand, deps.paths.taskDir(task.id), env);
  }

  const run: VerifyRun = { id: deps.ids(), taskId: task.id, attempt, passed: results.every(ok), results, createdAt: deps.clock.iso() };
  await deps.store.verifyRuns.upsert(run);
  return { run, tests };
}

export function failuresOf(run: VerifyRun): CommandResult[] {
  return run.results.filter((r) => !r.skipped && !r.preexisting && (r.exitCode !== 0 || r.timedOut));
}

/** Checks the owner skipped in this run, for the pull request and the task's history. */
export function skippedOf(run: VerifyRun): CommandResult[] {
  return run.results.filter((r) => r.skipped);
}

export function failureNotes(run: VerifyRun, repoNames: Map<string, string>): string[] {
  return failuresOf(run).map((f) => `${f.repoId ? repoNames.get(f.repoId) ?? f.repoId : 'integration'}: ${f.kind} failed (\`${f.command}\`${f.timedOut ? ', timed out' : `, exit ${f.exitCode}`})`);
}
