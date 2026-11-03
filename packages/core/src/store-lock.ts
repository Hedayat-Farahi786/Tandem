import type { Store } from './ports.js';

/** Async mutex. */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return release;
  }
}

export interface TxHooks {
  begin(): void | Promise<void>;
  commit(): void | Promise<void>;
  rollback(): void | Promise<void>;
}

export type RawRepos = Omit<Store, 'transaction'>;

export const REPO_KEYS = ['projects', 'repos', 'tasks', 'transitions', 'specs', 'approvals', 'runs', 'verifyRuns', 'criterionTests', 'findings', 'prs', 'threads', 'messages', 'rules', 'usage', 'jobs', 'settings', 'trackerComments', 'audit'] as const satisfies ReadonlyArray<keyof RawRepos>;

/**
 * Wraps raw repositories so every call outside a transaction waits for the lock, and the
 * transaction callback gets its own view that runs directly. This keeps callers that are not part
 * of a transaction from reading or writing inside it.
 */
export function lockedStore(raw: RawRepos, hooks: TxHooks): Store {
  const lock = new AsyncLock();
  const wrap = <R extends object>(repo: R): R =>
    Object.fromEntries(
      Object.entries(repo).map(([k, fn]) => [
        k,
        typeof fn === 'function'
          ? async (...args: unknown[]) => {
              const release = await lock.acquire();
              try {
                return await (fn as (...a: unknown[]) => unknown).apply(repo, args);
              } finally {
                release();
              }
            }
          : fn,
      ]),
    ) as R;

  const direct = Object.fromEntries(REPO_KEYS.map((k) => [k, raw[k]])) as unknown as RawRepos;
  const view: Store = { ...direct, transaction: (fn) => fn(view) };
  const outer = Object.fromEntries(REPO_KEYS.map((k) => [k, wrap(raw[k] as object)])) as unknown as RawRepos;
  return {
    ...outer,
    transaction: async (fn) => {
      const release = await lock.acquire();
      try {
        await hooks.begin();
        try {
          const result = await fn(view);
          await hooks.commit();
          return result;
        } catch (err) {
          await hooks.rollback();
          throw err;
        }
      } finally {
        release();
      }
    },
  };
}
