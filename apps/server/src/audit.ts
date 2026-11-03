import { ownerOf, verifyAuditChain, type Store } from '@tandem/core';
import { STATE_LABELS, type AuditEntry, type AuditInput, type Settings, type Task } from '@tandem/shared';

/** Records an action the owner took through the app. */
export async function auditOwner(store: Store, input: Omit<AuditInput, 'at' | 'actor'> & { at?: string }): Promise<AuditEntry> {
  return store.audit.append({ at: new Date().toISOString(), actor: 'owner', ...ownerOf(await store.settings.get()), ...input });
}

/** Which settings changed, with old and new values (Settings never hold secrets). */
export function settingsDiff(before: Settings, after: Settings): Array<{ field: string; from: unknown; to: unknown }> {
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: path, from: a ?? null, to: b ?? null });
  };
  walk(before, after, '');
  return out;
}

/* ------------------------------------------------------------------ activity feed */

export type ActivityKind = 'task' | 'state' | 'spec' | 'approval' | 'git' | 'pr' | 'agent' | 'checks' | 'config';

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  action: string;
  actor: AuditEntry['actor'];
  actorName?: string;
  summary: string;
  taskId?: string;
  taskKey?: string;
  projectId?: string;
  repoId?: string;
  detail?: Record<string, unknown>;
  /** Set for entries from the hash-chained audit log. */
  seq?: number;
  hash?: string;
}

const kindOf = (action: string): ActivityKind =>
  action === 'spec.approved' ? 'approval' : action.startsWith('spec.') ? 'spec' : action === 'task.state' ? 'state' : action.startsWith('task.') ? 'task' : action.startsWith('git.') ? 'git' : action.startsWith('pr.') ? 'pr' : 'config';

const credits = (nano: number) => Math.round((nano / 1e9) * 100) / 100;

/**
 * Everything that happened, newest first: the audit log, plus Copilot usage and check runs (stored
 * in their own tables), plus state changes from before the audit log existed.
 */
export async function activity(store: Store, q: { since?: string; until?: string; taskId?: string; projectId?: string; kinds?: ActivityKind[]; limit?: number }): Promise<{ items: ActivityItem[]; more: boolean }> {
  const tasks = q.taskId ? [await store.tasks.get(q.taskId)].filter((t): t is Task => Boolean(t)) : await store.tasks.list();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const inTask = (taskId?: string) => !q.taskId || taskId === q.taskId;
  const inProject = (taskId?: string, projectId?: string) => !q.projectId || projectId === q.projectId || (taskId !== undefined && byId.get(taskId)?.projectId === q.projectId);
  const inTime = (at: string) => (!q.since || at >= q.since) && (!q.until || at < q.until);
  const items: ActivityItem[] = [];

  const audit = await store.audit.list({ ...(q.taskId ? { taskId: q.taskId } : {}), ...(q.since ? { since: q.since } : {}), ...(q.until ? { until: q.until } : {}) });
  for (const e of audit) {
    if (!inProject(e.taskId, e.projectId)) continue;
    items.push({ id: `a${e.seq}`, at: e.at, kind: kindOf(e.action), action: e.action, actor: e.actor, ...(e.actorName ? { actorName: e.actorName } : {}), summary: e.summary, ...(e.taskId ? { taskId: e.taskId } : {}), ...(e.projectId ? { projectId: e.projectId } : {}), ...(e.repoId ? { repoId: e.repoId } : {}), detail: e.detail, seq: e.seq, hash: e.hash });
  }

  // State changes recorded before the audit log existed (tasks created by an older Tandem).
  const audited = new Set(audit.filter((e) => e.action === 'task.state' || e.action === 'task.created').map((e) => e.taskId));
  for (const t of tasks) {
    if (audited.has(t.id) || !inProject(t.id)) continue;
    for (const tr of await store.transitions.list(t.id)) {
      if (!inTime(tr.at)) continue;
      const created = tr.from === tr.to && /^Created from/.test(tr.reason);
      items.push({ id: `t${tr.id}`, at: tr.at, kind: created ? 'task' : tr.from === tr.to ? 'spec' : 'state', action: created ? 'task.created' : 'task.state', actor: tr.actor, summary: `${t.key}: ${tr.from === tr.to ? tr.reason : `${STATE_LABELS[tr.from]} → ${STATE_LABELS[tr.to]}. ${tr.reason}`}`, taskId: t.id, projectId: t.projectId, detail: { from: tr.from, to: tr.to, ...(tr.step ? { step: tr.step } : {}) } });
    }
  }

  for (const u of await store.usage.list({ ...(q.taskId ? { taskId: q.taskId } : {}), ...(q.since ? { since: q.since } : {}) })) {
    if (!inTime(u.at) || !inTask(u.taskId) || !inProject(u.taskId)) continue;
    const t = u.taskId ? byId.get(u.taskId) : undefined;
    items.push({ id: `u${u.id}`, at: u.at, kind: 'agent', action: `agent.${u.runKind}`, actor: 'agent', summary: `${t ? `${t.key}: ` : ''}Copilot ${u.runKind} run on ${u.model || 'the default model'}: ${u.prompts} prompt${u.prompts === 1 ? '' : 's'}, ${u.modelCalls} model call${u.modelCalls === 1 ? '' : 's'}, ${credits(u.nanoAiu)} AI credits.`, ...(u.taskId ? { taskId: u.taskId } : {}), ...(t ? { projectId: t.projectId } : {}), detail: { model: u.model, runKind: u.runKind, prompts: u.prompts, modelCalls: u.modelCalls, aiCredits: credits(u.nanoAiu), ...(u.threadId ? { threadId: u.threadId } : {}) } });
  }

  for (const t of tasks) {
    if (!inProject(t.id)) continue;
    for (const v of await store.verifyRuns.list(t.id)) {
      if (!inTime(v.createdAt)) continue;
      const failed = v.results.filter((r) => r.exitCode !== 0);
      items.push({
        id: `v${v.id}`,
        at: v.createdAt,
        kind: 'checks',
        action: v.passed ? 'checks.passed' : 'checks.failed',
        actor: 'system',
        summary: `${t.key}: ${v.passed ? 'every check passed' : `${failed.length} of ${v.results.length} checks failed (${failed.map((r) => r.kind).join(', ')})`}${v.attempt >= 300 ? ' after merging the base branch in' : v.attempt ? ` on attempt ${v.attempt + 1}` : ''}.`,
        taskId: t.id,
        projectId: t.projectId,
        detail: { attempt: v.attempt, commands: v.results.map((r) => ({ kind: r.kind, command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, ...(r.repoId ? { repoId: r.repoId } : {}) })) },
      });
    }
  }

  const filtered = items.filter((i) => !q.kinds?.length || q.kinds.includes(i.kind)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (b.seq ?? 0) - (a.seq ?? 0)));
  for (const i of filtered) {
    const key = i.taskId ? (byId.get(i.taskId)?.key ?? (await store.tasks.get(i.taskId))?.key) : undefined;
    if (key) i.taskKey = key;
  }
  const limit = q.limit ?? 300;
  return { items: filtered.slice(0, limit), more: filtered.length > limit };
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** CSV for spreadsheets; cells that start like a formula are quoted with a leading apostrophe. */
export function activityCsv(items: ActivityItem[]): string {
  const head = ['time', 'kind', 'action', 'actor', 'actor_name', 'task', 'summary', 'audit_seq', 'audit_hash', 'detail'];
  return [head.join(','), ...items.map((i) => [i.at, i.kind, i.action, i.actor, i.actorName, i.taskKey, i.summary, i.seq, i.hash, i.detail].map(csvCell).join(','))].join('\r\n') + '\r\n';
}

export async function verifyAudit(store: Store) {
  return verifyAuditChain(await store.audit.list());
}
