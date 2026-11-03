import { approvalState, verifyAuditChain, type Store } from '@tandem/core';
import type { AgentRunKind, AuditEntry, Task } from '@tandem/shared';

/**
 * A task's trace, from the request to the pull requests: each acceptance criterion with its tests,
 * each spec version with who approved it, every agent run with its model and cost, every check
 * run, the review findings, the commits pushed and the pull requests, and the audit entries, with
 * the audit chain's verification.
 */
export interface Trace {
  generatedAt: string;
  task: { id: string; key: string; title: string; state: string; source: string; externalKey?: string; branch: string; createdAt: string; updatedAt: string; project: string };
  requirement: { goal: string; userStory: string; exampleData: string; affectedAreas: string; outOfScope: string };
  criteria: Array<{ n: number; given: string; when: string; then: string; status: 'pass' | 'fail' | 'not-run' | 'no-test'; tests: Array<{ repo: string; file: string; name: string; result: string; scope: string }> }>;
  specs: Array<{ version: number; source: string; createdAt: string; feedback?: string; status: 'approved' | 'in-review' | 'superseded'; approvals: Array<{ role: string; name: string; date: string; method: string; evidence: string }> }>;
  agent: Array<{ kind: AgentRunKind; runs: number; succeeded: number; failed: number; models: string[]; prompts: number; modelCalls: number; aiCredits: number; firstAt?: string; lastAt?: string }>;
  checks: Array<{ attempt: number; passed: boolean; at: string; results: Array<{ repo: string; kind: string; command: string; exitCode: number | null; durationMs: number; timedOut: boolean }> }>;
  findings: Array<{ severity: string; category: string; title: string; file?: string; line?: number; status: string }>;
  commits: Array<{ repo: string; branch: string; commit: string; at?: string; reason?: string }>;
  pullRequests: Array<{ repo: string; url: string; status: string; manual: boolean; createdAt?: string; sync?: string }>;
  usage: { prompts: number; modelCalls: number; aiCredits: number };
  audit: Array<Pick<AuditEntry, 'seq' | 'at' | 'actor' | 'actorName' | 'action' | 'summary' | 'hash'>>;
  integrity: { ok: boolean; entries: number; head: string; reason?: string };
}

const credits = (nano: number) => Math.round((nano / 1e9) * 100) / 100;

export async function buildTrace(store: Store, task: Task): Promise<Trace> {
  const project = await store.projects.get(task.projectId);
  const repos = new Map((await store.repos.list()).map((r) => [r.id, r.name]));
  const repoName = (id?: string) => (id ? (repos.get(id) ?? id) : '');
  const [specs, approvals, runs, usage, verify, tests, findings, prs, auditAll] = await Promise.all([
    store.specs.list(task.id),
    store.approvals.list(task.id),
    store.runs.listFor({ taskId: task.id }),
    store.usage.list({ taskId: task.id }),
    store.verifyRuns.list(task.id),
    store.criterionTests.list(task.id),
    store.findings.list(task.id),
    store.prs.list(task.id),
    store.audit.list(),
  ]);
  const audit = auditAll.filter((e) => e.taskId === task.id);
  const chain = verifyAuditChain(auditAll);
  const latest = specs.at(-1)?.version;

  const criteria = task.requirement.criteria.map((c, i) => {
    const mine = tests.filter((t) => t.criterion === i + 1);
    const status = !mine.length ? 'no-test' : mine.some((t) => t.result === 'fail') ? 'fail' : mine.every((t) => t.result === 'pass') ? 'pass' : 'not-run';
    return { n: i + 1, given: c.given, when: c.when, then: c.then, status: status as Trace['criteria'][number]['status'], tests: mine.map((t) => ({ repo: repoName(t.repoId), file: t.file, name: t.name, result: t.result, scope: t.scope })) };
  });

  const kinds = [...new Set([...runs.map((r) => r.kind), ...usage.map((u) => u.runKind)])];
  const agent = kinds.map((kind) => {
    const rs = runs.filter((r) => r.kind === kind);
    const us = usage.filter((u) => u.runKind === kind);
    const times = [...rs.map((r) => r.startedAt), ...us.map((u) => u.at)].sort();
    return {
      kind,
      runs: rs.length,
      succeeded: rs.filter((r) => r.status === 'succeeded').length,
      failed: rs.filter((r) => r.status === 'failed' || r.status === 'aborted').length,
      models: [...new Set(us.map((u) => u.model).filter(Boolean))],
      prompts: us.reduce((n, u) => n + u.prompts, 0),
      modelCalls: us.reduce((n, u) => n + u.modelCalls, 0),
      aiCredits: credits(us.reduce((n, u) => n + u.nanoAiu, 0)),
      ...(times[0] ? { firstAt: times[0] } : {}),
      ...(times.at(-1) ? { lastAt: times.at(-1)! } : {}),
    };
  });

  const pushedNow = (task.progress.pushed ?? {}) as Record<string, string>;
  const pushes = audit.filter((e) => e.action === 'git.pushed');
  const commits: Trace['commits'] = pushes.map((e) => ({ repo: repoName(e.repoId), branch: String(e.detail.branch ?? task.branch), commit: String(e.detail.commit ?? ''), at: e.at, ...(e.detail.reason ? { reason: String(e.detail.reason) } : {}) }));
  for (const [repoId, sha] of Object.entries(pushedNow)) if (!commits.some((c) => c.commit === sha)) commits.push({ repo: repoName(repoId), branch: task.branch, commit: sha });

  return {
    generatedAt: new Date().toISOString(),
    task: { id: task.id, key: task.key, title: task.title, state: task.state, source: task.source, ...(task.externalKey ? { externalKey: task.externalKey } : {}), branch: task.branch, createdAt: task.createdAt, updatedAt: task.updatedAt, project: project?.name ?? '' },
    requirement: { goal: task.requirement.goal, userStory: task.requirement.userStory, exampleData: task.requirement.exampleData, affectedAreas: task.requirement.affectedAreas, outOfScope: task.requirement.outOfScope },
    criteria,
    specs: specs.map((s) => ({
      version: s.version,
      source: s.source,
      createdAt: s.createdAt,
      ...(s.feedback ? { feedback: s.feedback } : {}),
      status: project && approvalState(project, s.version, approvals).complete ? 'approved' : s.version === latest ? 'in-review' : 'superseded',
      approvals: approvals.filter((a) => a.specVersion === s.version).map((a) => ({ role: a.role, name: a.name, date: a.date, method: a.method, evidence: a.evidence })),
    })),
    agent,
    checks: verify.map((v) => ({ attempt: v.attempt, passed: v.passed, at: v.createdAt, results: v.results.map((r) => ({ repo: repoName(r.repoId), kind: r.kind, command: r.command, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut })) })),
    findings: findings.map((f) => ({ severity: f.severity, category: f.category, title: f.title, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), status: f.status })),
    commits,
    pullRequests: prs.map((p) => ({ repo: repoName(p.repoId), url: p.url, status: p.status, manual: p.manual, ...(p.createdAt ? { createdAt: p.createdAt } : {}), ...(p.sync ? { sync: p.sync.state } : {}) })),
    usage: { prompts: usage.reduce((n, u) => n + u.prompts, 0), modelCalls: usage.reduce((n, u) => n + u.modelCalls, 0), aiCredits: credits(usage.reduce((n, u) => n + u.nanoAiu, 0)) },
    audit: audit.map((e) => ({ seq: e.seq, at: e.at, actor: e.actor, ...(e.actorName ? { actorName: e.actorName } : {}), action: e.action, summary: e.summary, hash: e.hash })),
    integrity: { ok: chain.ok, entries: chain.count, head: chain.head, ...(chain.reason ? { reason: chain.reason } : {}) },
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const day = (iso?: string) => (iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : '');

/** The trace as a Markdown report, for attaching to a change record or an audit. */
export function traceMarkdown(t: Trace): string {
  const L: string[] = [];
  L.push(`# Traceability report: ${t.task.key} ${t.task.title}`, '');
  L.push(`Generated ${day(t.generatedAt)} by Tandem. Project ${t.task.project}; state ${t.task.state}; source ${t.task.source}${t.task.externalKey ? ` (${t.task.externalKey})` : ''}; branch \`${t.task.branch}\`.`, '');
  L.push(`Audit log: ${t.integrity.ok ? `verified, ${t.integrity.entries} entries, head \`${t.integrity.head}\`` : `**verification failed**: ${t.integrity.reason ?? ''}`}.`, '');
  L.push('## Requirement', '', `**Goal.** ${t.requirement.goal}`, '');
  if (t.requirement.userStory) L.push(`**User story.** ${t.requirement.userStory}`, '');
  L.push(`**Example data.** ${t.requirement.exampleData || '—'}`, '', `**Affected areas.** ${t.requirement.affectedAreas || '—'}`, '', `**Out of scope.** ${t.requirement.outOfScope || '—'}`, '');
  L.push('## Acceptance criteria and tests', '', '| # | Criterion | Tests | Result |', '| --- | --- | --- | --- |');
  for (const c of t.criteria) L.push(`| ${c.n} | Given ${cell(c.given)}, when ${cell(c.when)}, then ${cell(c.then)} | ${c.tests.map((x) => `${cell(x.repo)}: \`${cell(x.file)}\` ${cell(x.name)}`).join('<br>') || '—'} | ${c.status} |`);
  L.push('', '## Spec versions and approvals', '', '| Version | Created | Status | Approvals |', '| --- | --- | --- | --- |');
  for (const s of t.specs) L.push(`| ${s.version} (${s.source}) | ${day(s.createdAt)} | ${s.status} | ${s.approvals.map((a) => `${a.role === 'pm' ? 'PM' : 'Owner'} ${cell(a.name)}, ${day(a.date)}, ${a.method}${a.evidence ? `: ${cell(a.evidence)}` : ''}`).join('<br>') || '—'} |`);
  L.push('', '## Copilot runs', '', '| Step | Runs | Models | Prompts | Model calls | AI credits |', '| --- | --- | --- | --- | --- | --- |');
  for (const a of t.agent) L.push(`| ${a.kind} | ${a.runs} (${a.succeeded} ok, ${a.failed} failed) | ${a.models.join(', ') || '—'} | ${a.prompts} | ${a.modelCalls} | ${a.aiCredits} |`);
  L.push(`| **Total** | | | ${t.usage.prompts} | ${t.usage.modelCalls} | ${t.usage.aiCredits} |`);
  L.push('', '## Checks', '');
  for (const v of t.checks) {
    L.push(`**${v.attempt >= 300 ? 'After merging the base branch' : `Attempt ${v.attempt + 1}`}** (${day(v.at)}): ${v.passed ? 'passed' : 'failed'}`, '', '| Repository | Kind | Command | Exit | Duration |', '| --- | --- | --- | --- | --- |');
    for (const r of v.results) L.push(`| ${cell(r.repo)} | ${r.kind} | \`${cell(r.command)}\` | ${r.timedOut ? 'timed out' : (r.exitCode ?? '—')} | ${(r.durationMs / 1000).toFixed(1)} s |`);
    L.push('');
  }
  if (!t.checks.length) L.push('No check runs yet.', '');
  L.push('## Self-review findings', '');
  L.push(...(t.findings.length ? ['| Severity | Category | Finding | Location | Status |', '| --- | --- | --- | --- | --- |', ...t.findings.map((f) => `| ${f.severity} | ${f.category} | ${cell(f.title)} | ${f.file ? `\`${cell(f.file)}${f.line ? `:${f.line}` : ''}\`` : '—'} | ${f.status} |`)] : ['No findings.']), '');
  L.push('## Commits and pull requests', '');
  for (const c of t.commits) L.push(`- ${c.repo}: \`${c.commit}\` on \`${c.branch}\`${c.at ? `, pushed ${day(c.at)}` : ''}${c.reason === 'base-merged' ? ' (merged the base branch in)' : ''}`);
  if (!t.commits.length) L.push('- Nothing pushed yet.');
  for (const p of t.pullRequests) L.push(`- ${p.repo}: ${p.url} (${p.status}${p.manual ? ', created by hand' : ''}${p.sync ? `, ${p.sync}` : ''})`);
  L.push('', '## Audit log', '', '| # | Time | Who | Action | What | Hash |', '| --- | --- | --- | --- | --- | --- |');
  for (const e of t.audit) L.push(`| ${e.seq} | ${day(e.at)} | ${e.actorName ? `${cell(e.actorName)} (${e.actor})` : e.actor} | ${e.action} | ${cell(e.summary)} | \`${e.hash.slice(0, 12)}\` |`);
  if (!t.audit.length) L.push('| | | | | Created before the audit log existed. | |');
  return `${L.join('\n')}\n`;
}
