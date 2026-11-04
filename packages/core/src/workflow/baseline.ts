import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Repo, Task } from '@tandem/shared';
import type { WorkflowDeps } from './context.js';
import { installKey, releaseDependencies, restoreDependencies } from './deps.js';

/**
 * Knowing where a repo starts: a check that fails on a task may fail on the base branch too (a
 * broken test setup, say). Tandem runs the same check once on the base branch, caches the result
 * per base commit, and only the failures the change added are the task's to fix.
 */

/** Failures a test runner reported: how many, and which (when the runner names them). */
export interface FailureSummary {
  failures?: number;
  names?: string[];
}

// eslint-disable-next-line no-control-regex -- terminal colour codes start with ESC
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROGRESS = /^\s*(?:[\w ]*Chrome[\w .()]*|Firefox[\w .()]*|HeadlessChrome[\w .()]*): Executed \d+ of \d+/;

/**
 * Check output as a person would read it: no colour codes, no progress lines repeated hundreds of
 * times (Karma reprints "Executed 12 of 68" for every test), no duplicate lines in a row. What is
 * left is the failures, so they fit in the excerpt Copilot and the pull request get.
 */
export function compactOutput(text: string): string {
  const lines = text.replace(ANSI, '').split(/\r?\n|\r/);
  const out: string[] = [];
  let lastProgress = '';
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (PROGRESS.test(line) && !/FAILED\s*$/.test(line.replace(/\(\d+ FAILED\)/, ''))) {
      lastProgress = line;
      continue;
    }
    if (line === out.at(-1)) continue;
    out.push(line);
  }
  if (lastProgress) out.push(lastProgress);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** How many tests failed, and their names, from the usual runners' summaries. */
export function summarizeFailures(output: string): FailureSummary {
  const text = output.replace(ANSI, '');
  const last = (re: RegExp) => {
    const all = [...text.matchAll(re)];
    return all.length ? Number(all[all.length - 1]![1]) : undefined;
  };
  const failures =
    last(/TOTAL: (\d+) FAILED/g) ?? // Karma
    last(/Executed \d+ of \d+ \((\d+) FAILED\)/g) ?? // Karma progress
    last(/Tests:\s+(\d+) failed/g) ?? // Jest
    last(/Tests\s+(\d+) failed/g) ?? // Vitest
    last(/(\d+) failing/g) ?? // Mocha
    last(/=+ (\d+) failed/g) ?? // pytest
    (/^--- FAIL: /m.test(text) ? text.match(/^--- FAIL: /gm)!.length : undefined); // go test
  const names = new Set<string>();
  // Karma: "Chrome Headless 1.0 (Linux): Suite does a thing FAILED"; Jest/Vitest: "✕ does a thing".
  for (const m of text.matchAll(/^[^\n]*?\)[ \t]*:?[ \t]*([^\n]+?) FAILED[ \t]*$/gm)) if (!/Executed \d+ of \d+/.test(m[0])) names.add(m[1]!.trim());
  for (const m of text.matchAll(/^\s*[✕×]\s+(.+?)(?:\s+\(\d+\s*ms\))?\s*$/gm)) names.add(m[1]!.trim());
  for (const m of text.matchAll(/^--- FAIL: (\S+)/gm)) names.add(m[1]!);
  return { ...(failures !== undefined ? { failures } : {}), ...(names.size ? { names: [...names] } : {}) };
}

export type Baseline = { failed: boolean; timedOut: boolean } & FailureSummary;

/** Whether a failure is the change's: compared with the same check on the base branch. */
export function newFailures(task: FailureSummary, base: Baseline): { isNew: boolean; names?: string[]; count?: number } {
  if (!base.failed) return { isNew: true };
  if (task.names?.length && base.names?.length) {
    const before = new Set(base.names);
    const added = task.names.filter((n) => !before.has(n));
    return { isNew: added.length > 0, names: added, count: added.length };
  }
  if (task.failures !== undefined && base.failures !== undefined) return { isNew: task.failures > base.failures, count: Math.max(0, task.failures - base.failures) };
  // Both fail and neither says how: it fails before the change too, so it isn't this change's to fix.
  return { isNew: false };
}

const cacheFile = (deps: WorkflowDeps) => join(deps.paths.home, 'baselines.json');

async function readCache(deps: WorkflowDeps): Promise<Record<string, Baseline>> {
  try {
    return existsSync(cacheFile(deps)) ? (JSON.parse(await readFile(cacheFile(deps), 'utf8')) as Record<string, Baseline>) : {};
  } catch {
    return {};
  }
}

/**
 * The check's result on the base branch (cached per base commit and command); undefined when Tandem
 * can't tell (no base commit known, or dependencies won't install there).
 */
export async function baselineFor(deps: WorkflowDeps, task: Task, repo: Repo, command: string, timeoutMs: number): Promise<Baseline | undefined> {
  const sha = await deps.git.remoteHead(repo, repo.defaultBranch).catch(() => undefined);
  if (!sha) return undefined;
  const key = `${repo.id}:${sha}:${command}`;
  const cache = await readCache(deps);
  if (cache[key]) return cache[key];
  const wt = join(deps.paths.taskDir(task.id), '.baseline', repo.name);
  try {
    await deps.hosts(repo).createWorktree(repo, { path: wt, branch: repo.defaultBranch, base: `origin/${repo.defaultBranch}`, detach: true });
    const install = repo.commands.install;
    if (install) {
      const k = await installKey(wt, install).catch(() => undefined);
      const restored = k ? await restoreDependencies(deps, repo, wt, k).catch(() => false) : false;
      if (!restored) {
        const r = await deps.process.runCommand(install, { cwd: wt, timeoutMs });
        if (r.exitCode !== 0 || r.timedOut) return undefined;
      }
    }
    const r = await deps.process.runCommand(command, { cwd: wt, timeoutMs });
    const base: Baseline = { failed: r.exitCode !== 0 || r.timedOut, timedOut: r.timedOut, ...summarizeFailures(`${r.stdout}\n${r.stderr}`) };
    await writeFile(cacheFile(deps), JSON.stringify({ ...(await readCache(deps)), [key]: base }, null, 1)).catch(() => undefined);
    return base;
  } catch (err) {
    deps.logger?.warn('could not check the base branch', { repo: repo.name, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  } finally {
    await releaseDependencies(wt).catch(() => undefined);
    await deps.git.removeWorktree(repo, wt).catch(() => undefined);
  }
}
