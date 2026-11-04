import { DEFAULT_SETTINGS, type AgentStep, type AuditEntry, type Settings, type Task, type TaskTransition, type UsageRecord } from '@tandem/shared';
import { auditMatches, chainEntry } from '../audit.js';
import { redactor } from '../policies/redact.js';
import type { Collection, Job, Store, TaskScoped, TrackerComment } from '../ports.js';
import { lockedStore, type RawRepos } from '../store-lock.js';

const clone = <T>(v: T): T => structuredClone(v);

interface Data {
  maps: Record<string, Map<string, unknown>>;
  transitions: TaskTransition[];
  specs: Array<{ taskId: string; version: number } & Record<string, unknown>>;
  criterionTests: Map<string, unknown[]>;
  messages: Array<{ threadId: string } & Record<string, unknown>>;
  usage: UsageRecord[];
  jobs: Map<string, Job>;
  settings: Settings | undefined;
  trackerComments: TrackerComment[];
  audit: AuditEntry[];
  agentSteps: AgentStep[];
  nextTransitionId: number;
}

const MAPS = ['projects', 'repos', 'tasks', 'approvals', 'runs', 'verifyRuns', 'findings', 'prs', 'threads', 'rules'] as const;

/** Raw in-memory repositories; MemoryStore adds locking and transactions. */
class MemoryRepos implements RawRepos {
  private data: Data = {
    maps: Object.fromEntries(MAPS.map((m) => [m, new Map()])),
    transitions: [],
    specs: [],
    criterionTests: new Map(),
    messages: [],
    usage: [],
    jobs: new Map(),
    settings: undefined,
    trackerComments: [],
    audit: [],
    agentSteps: [],
    nextTransitionId: 1,
  };
  snapshot(): Data {
    return clone({ ...this.data, maps: Object.fromEntries(Object.entries(this.data.maps).map(([k, v]) => [k, new Map(v)])) }) as Data;
  }

  restore(d: Data): void {
    this.data = d;
  }

  private map<T>(name: (typeof MAPS)[number]): Map<string, T> {
    return this.data.maps[name] as Map<string, T>;
  }

  private collection<T extends { id: string }>(name: (typeof MAPS)[number]): Collection<T> {
    return {
      get: async (id) => clone(this.map<T>(name).get(id)),
      list: async () => [...this.map<T>(name).values()].map(clone),
      upsert: async (item) => void this.map<T>(name).set(item.id, clone(item)),
      delete: async (id) => void this.map<T>(name).delete(id),
    };
  }

  private scoped<T extends { id: string; taskId: string }>(name: (typeof MAPS)[number]): TaskScoped<T> {
    return {
      get: async (id) => clone(this.map<T>(name).get(id)),
      list: async (taskId) => [...this.map<T>(name).values()].filter((x) => x.taskId === taskId).map(clone),
      upsert: async (item) => void this.map<T>(name).set(item.id, clone(item)),
    };
  }

  projects = this.collection<Store['projects'] extends Collection<infer P> ? P : never>('projects');
  repos = this.collection<Store['repos'] extends Collection<infer R> ? R : never>('repos');
  tasks: Store['tasks'] = {
    ...this.collection<Task>('tasks'),
    getByKey: async (key) => clone([...this.map<Task>('tasks').values()].find((t) => t.key === key)),
    listByState: async (states) => [...this.map<Task>('tasks').values()].filter((t) => states.includes(t.state)).map(clone),
    nextSeq: async (prefix) => {
      let max = 0;
      for (const t of this.map<Task>('tasks').values()) {
        const m = new RegExp(`^${prefix}-(\\d+)$`).exec(t.key);
        if (m) max = Math.max(max, Number(m[1]));
      }
      return max + 1;
    },
  };
  transitions: Store['transitions'] = {
    add: async (t) => {
      const full = { ...t, id: this.data.nextTransitionId++ };
      this.data.transitions.push(clone(full));
      return full;
    },
    list: async (taskId) => this.data.transitions.filter((t) => t.taskId === taskId).map(clone),
  };
  specs: Store['specs'] = {
    add: async (v) => {
      if (this.data.specs.some((s) => s.taskId === v.taskId && s.version === v.version)) throw new Error(`spec ${v.taskId} v${v.version} exists`);
      this.data.specs.push(clone(v));
    },
    list: async (taskId) => this.data.specs.filter((s) => s.taskId === taskId).sort((a, b) => a.version - b.version).map(clone) as never,
    latest: async (taskId) => clone(this.data.specs.filter((s) => s.taskId === taskId).sort((a, b) => b.version - a.version)[0]) as never,
  };
  approvals = this.scoped<Store['approvals'] extends TaskScoped<infer A> ? A : never>('approvals');
  runs: Store['runs'] = {
    ...this.collection('runs'),
    listFor: async (scope) => [...this.map<{ taskId?: string; threadId?: string }>('runs').values()].filter((r) => (!scope.taskId || r.taskId === scope.taskId) && (!scope.threadId || r.threadId === scope.threadId)).map(clone) as never,
  };
  verifyRuns = this.scoped<Store['verifyRuns'] extends TaskScoped<infer V> ? V : never>('verifyRuns');
  criterionTests: Store['criterionTests'] = {
    replace: async (taskId, items) => void this.data.criterionTests.set(taskId, clone(items)),
    list: async (taskId) => clone((this.data.criterionTests.get(taskId) ?? []) as never),
  };
  findings: Store['findings'] = {
    ...this.scoped('findings'),
    replace: async (taskId, items) => {
      const m = this.map<{ taskId: string }>('findings');
      for (const [id, f] of m) if (f.taskId === taskId) m.delete(id);
      for (const f of items) m.set(f.id, clone(f));
    },
  } as Store['findings'];
  prs: Store['prs'] = {
    ...this.scoped('prs'),
    listByStatus: async (statuses) => [...this.map<{ status: string }>('prs').values()].filter((p) => statuses.includes(p.status as never)).map(clone) as never,
  } as Store['prs'];
  threads: Store['threads'] = {
    ...this.collection('threads'),
    listFor: async (scope) =>
      [...this.map<{ projectId: string; taskId?: string }>('threads').values()].filter((t) => (!scope.projectId || t.projectId === scope.projectId) && (scope.taskId === undefined || t.taskId === scope.taskId)).map(clone) as never,
  } as Store['threads'];
  messages: Store['messages'] = {
    add: async (m) => void this.data.messages.push(clone(m)),
    list: async (threadId) => this.data.messages.filter((m) => m.threadId === threadId).map(clone) as never,
    deleteFor: async (threadId) => {
      const before = this.data.messages.length;
      this.data.messages = this.data.messages.filter((m) => m.threadId !== threadId);
      return before - this.data.messages.length;
    },
  };
  rules: Store['rules'] = {
    ...this.collection('rules'),
    listPending: async (repoId) => [...this.map<{ repoId: string; status: string }>('rules').values()].filter((r) => r.repoId === repoId && r.status === 'pending').map(clone) as never,
  } as Store['rules'];
  usage: Store['usage'] = {
    add: async (u) => void this.data.usage.push(clone(u)),
    prompts: async (scope) => this.filterUsage(scope).reduce((n, u) => n + u.prompts, 0),
    list: async (scope) => this.filterUsage(scope).map(clone),
  };
  jobs: Store['jobs'] = {
    get: async (taskId) => clone(this.data.jobs.get(taskId)),
    upsert: async (job) => void this.data.jobs.set(job.taskId, clone(job)),
    delete: async (taskId) => void this.data.jobs.delete(taskId),
    list: async () => [...this.data.jobs.values()].map(clone),
  };
  settings: Store['settings'] = {
    get: async () => clone(this.data.settings ?? DEFAULT_SETTINGS),
    set: async (s) => void (this.data.settings = clone(s)),
  };
  trackerComments: Store['trackerComments'] = {
    add: async (c) => void this.data.trackerComments.push(clone(c)),
    list: async (key) => this.data.trackerComments.filter((c) => c.key === key).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone),
  };

  agentSteps: Store['agentSteps'] = {
    add: async (step) => void this.data.agentSteps.push(clone(redactor.redactDeep(step))),
    list: async (scope) => this.data.agentSteps.filter((x) => (!scope.taskId || x.taskId === scope.taskId) && (!scope.runId || x.runId === scope.runId)).map(clone),
  };

  audit: Store['audit'] = {
    append: async (input) => {
      const e = chainEntry(this.data.audit.at(-1), redactor.redactDeep(input));
      this.data.audit.push(clone(e));
      return clone(e);
    },
    list: async (scope = {}) => {
      const hits = this.data.audit.filter((e) => auditMatches(e, scope));
      return (scope.limit ? hits.slice(-scope.limit) : hits).map(clone);
    },
  };

  private filterUsage(scope: { taskId?: string; since?: string }): UsageRecord[] {
    return this.data.usage.filter((u) => (!scope.taskId || u.taskId === scope.taskId) && (!scope.since || u.at >= scope.since));
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface MemoryStore extends Store {}
/** In-memory Store for unit tests. Same contract as the SQLite store (shared contract tests). */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class MemoryStore {
  constructor() {
    const raw = new MemoryRepos();
    let saved: Data | undefined;
    const store = lockedStore(raw, {
      begin: () => void (saved = raw.snapshot()),
      commit: () => void (saved = undefined),
      rollback: () => {
        if (saved) raw.restore(saved);
        saved = undefined;
      },
    });
    Object.assign(this, store);
  }
}
