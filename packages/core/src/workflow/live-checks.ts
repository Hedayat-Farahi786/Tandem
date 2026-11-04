/**
 * The checks running right now, so the owner skipping one can stop it at once instead of waiting
 * for it to finish or time out (a watch-mode test runner never finishes). One process, in memory.
 */
const live = new Map<string, Map<string, AbortController>>();

export const checkKey = (repoId: string | undefined, kind: string): string => `${repoId ?? 'project'}:${kind}`;

/** Registers a running check; call `done` when it ends. */
export function trackCheck(taskId: string, key: string): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const forTask = live.get(taskId) ?? new Map<string, AbortController>();
  forTask.set(key, controller);
  live.set(taskId, forTask);
  return {
    signal: controller.signal,
    done: () => {
      if (forTask.get(key) === controller) forTask.delete(key);
      if (!forTask.size) live.delete(taskId);
    },
  };
}

/** Stops a running check (and any single tests of the same repo, for a skipped test suite). */
export function stopCheck(taskId: string, key: string): boolean {
  const forTask = live.get(taskId);
  if (!forTask) return false;
  let stopped = false;
  for (const [k, c] of forTask) {
    if (k === key || (key.endsWith(':test') && k === key.replace(/:test$/, ':test-single'))) {
      c.abort();
      stopped = true;
    }
  }
  return stopped;
}
