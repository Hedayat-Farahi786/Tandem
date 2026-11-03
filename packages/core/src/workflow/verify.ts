import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandKind, CommandResult, CriterionTest, Project, Repo, Task, VerifyRun } from '@tandem/shared';
import { redactor } from '../policies/redact.js';
import { worktreeOf, type WorkflowDeps } from './context.js';

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
export async function verifyAll(deps: WorkflowDeps, task: Task, project: Project, repos: readonly Repo[], attempt: number): Promise<{ run: VerifyRun; tests: CriterionTest[] }> {
  const settings = await deps.settings();
  const timeoutMs = settings.limits.commandTimeoutMin * 60_000;
  const logDir = join(deps.paths.taskDir(task.id), '.tandem', 'verify');
  await mkdir(logDir, { recursive: true });
  const results: CommandResult[] = [];
  const exec = async (repo: Repo | undefined, kind: CommandKind, command: string, cwd: string, env?: Record<string, string>): Promise<CommandResult> => {
    const r = await deps.process.runCommand(command, {
      cwd,
      timeoutMs,
      ...(env ? { env } : {}),
      onLine: (line) => deps.events?.emit({ type: 'verify.output', taskId: task.id, ...(repo ? { repoId: repo.id } : {}), kind, line: redactor.redact(line) }),
    });
    const output = redactor.redact(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`);
    const logPath = join(logDir, `${attempt}-${repo?.name ?? 'project'}-${kind}-${results.length}.log`);
    await writeFile(logPath, `$ ${command}\n${output}\n`);
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

  const ok = (r: CommandResult) => r.exitCode === 0 && !r.timedOut;
  const suitePassed = new Map<string, boolean>();
  for (const repo of repos) {
    const cwd = worktreeOf(deps, task, repo);
    let healthy = true;
    for (const [kind, key] of ORDER) {
      const cmd = repo.commands[key];
      if (!cmd) continue;
      const r = await exec(repo, kind, cmd, cwd);
      if (!ok(r) && kind === 'install') {
        healthy = false;
        break; // nothing else can run without dependencies
      }
      if (kind === 'test') suitePassed.set(repo.id, ok(r));
    }
    if (!healthy) suitePassed.set(repo.id, false);
  }

  const recorded = await deps.store.criterionTests.list(task.id);
  const tests: CriterionTest[] = [];
  for (const t of recorded) {
    const repo = repos.find((r) => r.id === t.repoId);
    const suite = suitePassed.get(t.repoId);
    if (repo?.commands.testSingle) {
      const r = await exec(repo, 'test-single', singleTestCommand(repo.commands.testSingle, t.file, t.name), worktreeOf(deps, task, repo));
      tests.push({ ...t, scope: 'single', result: ok(r) ? 'pass' : 'fail' });
    } else {
      tests.push({ ...t, scope: 'suite', result: suite === undefined ? 'not-run' : suite ? 'pass' : 'fail' });
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
  return run.results.filter((r) => r.exitCode !== 0 || r.timedOut);
}

export function failureNotes(run: VerifyRun, repoNames: Map<string, string>): string[] {
  return failuresOf(run).map((f) => `${f.repoId ? repoNames.get(f.repoId) ?? f.repoId : 'integration'}: ${f.kind} failed (\`${f.command}\`${f.timedOut ? ', timed out' : `, exit ${f.exitCode}`})`);
}
