import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, CheckCircle2, Circle, CircleDashed, ExternalLink, FileDown, FileText, GitCommitHorizontal, GitPullRequest, ListChecks, MessageSquareText, SearchCheck, ShieldAlert, ShieldCheck, Sparkles, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import type { Trace } from '../lib/types';
import { CopyButton, ErrorState, LinkButton, Loading, cx } from '../ui/kit';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** One link in the chain: an icon on the rail, a title, a one-line status and the facts. */
function Stage({ icon: Icon, title, status, tone = 'neutral', children, last }: { icon: LucideIcon; title: string; status: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'idle'; children?: ReactNode; last?: boolean }) {
  const tones = { neutral: 'bg-surface text-fg shadow-[0_0_0_1px_var(--border-strong)]', ok: 'bg-ok-soft text-ok shadow-[0_0_0_1px_color-mix(in_srgb,var(--ok)_25%,transparent)]', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', idle: 'bg-surface-2 text-faint' };
  return (
    <li className="relative grid grid-cols-[36px_1fr] gap-x-4">
      {!last && <span aria-hidden className="absolute top-10 bottom-0 left-[17.5px] w-px bg-line" />}
      <span aria-hidden className={cx('relative z-[1] mt-0.5 grid size-9 place-items-center rounded-xl', tones[tone])}>
        <Icon className="size-[17px]" strokeWidth={1.9} />
      </span>
      <div className="min-w-0 pb-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-1.5">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h3>
          <p className="text-[12.5px] text-muted">{status}</p>
        </div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </li>
  );
}

const Box = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx('overflow-hidden rounded-xl bg-surface shadow-panel', className)}>{children}</div>;

const RESULT: Record<string, { icon: LucideIcon; cls: string; label: string }> = {
  pass: { icon: CheckCircle2, cls: 'text-ok', label: 'Passing' },
  fail: { icon: XCircle, cls: 'text-danger', label: 'Failing' },
  'not-run': { icon: CircleDashed, cls: 'text-faint', label: 'Not run yet' },
  'no-test': { icon: Circle, cls: 'text-faint', label: 'No test yet' },
};

export function TraceTab({ taskId }: { taskId: string }) {
  const q = useQuery({ queryKey: ['trace', taskId], queryFn: () => api<Trace>(`/api/tasks/${taskId}/trace`), refetchInterval: 15_000 });
  if (q.isLoading) return <Loading rows={6} />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const t = q.data;
  const passing = t.criteria.filter((c) => c.status === 'pass').length;
  const approved = t.specs.find((s) => s.status === 'approved');
  const latestChecks = t.checks.at(-1);
  const openFindings = t.findings.filter((f) => f.status === 'open').length;

  return (
    <div className="mx-auto max-w-[860px]">
      <div className="mb-8 flex flex-wrap items-center gap-4 rounded-2xl bg-surface px-5 py-4 shadow-panel">
        <span aria-hidden className={cx('grid size-10 shrink-0 place-items-center rounded-xl', t.integrity.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>
          {t.integrity.ok ? <ShieldCheck className="size-5" strokeWidth={1.9} /> : <ShieldAlert className="size-5" strokeWidth={1.9} />}
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-[14px] font-semibold">Traceability</p>
          <p className="mt-0.5 text-[12.5px] text-muted">
            From the request to the pull requests, with who approved what and which tests prove each criterion.{' '}
            {t.integrity.ok ? `Audit log verified (${t.integrity.entries} entries).` : `Audit log failed verification: ${t.integrity.reason ?? ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton to={`/api/tasks/${taskId}/trace?format=md`} icon={FileDown} download>
            Download report
          </LinkButton>
          <LinkButton to={`/api/tasks/${taskId}/trace?format=json`} variant="ghost" download>
            JSON
          </LinkButton>
        </div>
      </div>

      <ol aria-label="Trace">
        <Stage icon={MessageSquareText} title="Request" status={`${t.task.source === 'chat' ? 'From chat' : t.task.source === 'jira' ? `From Jira${t.task.externalKey ? ` ${t.task.externalKey}` : ''}` : t.task.source === 'split' ? 'Split from a bigger task' : 'Created in Tandem'} · ${when(t.task.createdAt)}`}>
          <p className="text-[13.5px] leading-relaxed">{t.requirement.goal || <span className="text-faint">No goal yet.</span>}</p>
          {t.requirement.outOfScope && <p className="mt-1.5 text-[12.5px] text-muted">Out of scope: {t.requirement.outOfScope}</p>}
        </Stage>

        <Stage icon={ListChecks} title="Acceptance criteria and tests" tone={!t.criteria.length ? 'idle' : passing === t.criteria.length ? 'ok' : t.criteria.some((c) => c.status === 'fail') ? 'danger' : 'neutral'} status={t.criteria.length ? `${passing} of ${t.criteria.length} proven by a passing test` : 'None yet'}>
          {t.criteria.length > 0 && (
            <Box>
              <ul className="divide-y divide-line">
                {t.criteria.map((c) => {
                  const r = RESULT[c.status]!;
                  return (
                    <li key={c.n} className="flex gap-3 px-4 py-3">
                      <span className="w-4 shrink-0 pt-px font-mono text-[12px] text-faint">{c.n}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] leading-snug">
                          <span className="text-faint">Given</span> {c.given}, <span className="text-faint">when</span> {c.when}, <span className="text-faint">then</span> {c.then}
                        </p>
                        {c.tests.map((x, i) => (
                          <p key={i} className="mt-1.5 truncate font-mono text-[11.5px] text-muted" title={`${x.repo}: ${x.file} › ${x.name}`}>
                            {x.repo}: {x.file} › {x.name}
                          </p>
                        ))}
                      </div>
                      <span className={cx('flex shrink-0 items-center gap-1.5 text-[12px]', r.cls)}>
                        <r.icon aria-hidden className="size-3.5" />
                        {r.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon={FileText} title="Spec and approvals" tone={approved ? 'ok' : t.specs.length ? 'warn' : 'idle'} status={approved ? `Version ${approved.version} approved` : t.specs.length ? `Version ${t.specs.at(-1)!.version} waiting for approval` : 'Not drafted yet'}>
          {t.specs.length > 0 && (
            <Box>
              <ul className="divide-y divide-line">
                {[...t.specs].reverse().map((s) => (
                  <li key={s.version} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                    <div className="w-36 shrink-0">
                      <p className="text-[13px] font-medium">Version {s.version}</p>
                      <p className="text-[12px] text-faint">
                        {s.source === 'edit' ? 'Edited' : s.source === 'redraft' ? 'Redrafted' : 'Drafted'} {when(s.createdAt)}
                      </p>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                      {s.approvals.length ? (
                        s.approvals.map((a, i) => (
                          <span key={i} title={a.evidence} className="inline-flex h-6 items-center gap-1.5 rounded-full bg-ok-soft px-2.5 text-[12px] text-ok">
                            <BadgeCheck aria-hidden className="size-3.5" />
                            {a.name}
                            <span className="opacity-75">· {a.role === 'pm' ? 'PM' : 'owner'}{a.method === 'jira' ? ', Jira' : ''}</span>
                          </span>
                        ))
                      ) : (
                        <span className="text-[12.5px] text-faint">No approvals</span>
                      )}
                    </div>
                    <span className={cx('shrink-0 text-[12px]', s.status === 'approved' ? 'text-ok' : s.status === 'in-review' ? 'text-warn' : 'text-faint')}>{s.status === 'approved' ? 'Approved' : s.status === 'in-review' ? 'In review' : 'Superseded'}</span>
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon={Sparkles} title="Copilot" tone={t.agent.length ? 'neutral' : 'idle'} status={t.agent.length ? `${t.usage.prompts} prompts · ${t.usage.modelCalls} model calls · ${t.usage.aiCredits} AI credits` : 'No runs yet'}>
          {t.agent.length > 0 && (
            <Box>
              <table className="w-full text-left text-[12.5px]">
                <thead className="text-[11.5px] text-faint">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">Step</th>
                    <th className="px-2 py-2 font-medium">Model</th>
                    <th className="px-2 py-2 text-right font-medium">Runs</th>
                    <th className="px-2 py-2 text-right font-medium">Prompts</th>
                    <th className="px-4 py-2 text-right font-medium">Credits</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {t.agent.map((a) => (
                    <tr key={a.kind}>
                      <td className="px-4 py-2.5 font-medium capitalize">{a.kind}</td>
                      <td className="max-w-48 truncate px-2 py-2.5 text-muted">{a.models.join(', ') || '—'}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {a.runs}
                        {a.failed > 0 && <span className="text-warn"> ({a.failed} failed)</span>}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{a.prompts}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{a.aiCredits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
          )}
        </Stage>

        <Stage icon={SearchCheck} title="Checks and review" tone={!latestChecks ? 'idle' : latestChecks.passed && !openFindings ? 'ok' : latestChecks.passed ? 'warn' : 'danger'} status={latestChecks ? `${t.checks.length} run${t.checks.length === 1 ? '' : 's'}, the last ${latestChecks.passed ? 'passed' : 'failed'} · ${t.findings.length ? `${openFindings} of ${t.findings.length} findings open` : 'no review findings'}` : 'Not run yet'}>
          {latestChecks && (
            <div className="flex flex-wrap gap-1.5">
              {latestChecks.results.map((r, i) => {
                const ok = r.exitCode === 0 && !r.timedOut;
                return (
                  <span key={i} title={`${r.repo}: ${r.command} · ${(r.durationMs / 1000).toFixed(1)} s`} className={cx('inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px]', ok ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--border)]' : 'bg-danger-soft text-danger')}>
                    {ok ? <CheckCircle2 aria-hidden className="size-3.5 text-ok" /> : <XCircle aria-hidden className="size-3.5" />}
                    {r.kind}
                    <span className="text-faint tabular-nums">{(r.durationMs / 1000).toFixed(1)}s</span>
                  </span>
                );
              })}
            </div>
          )}
        </Stage>

        <Stage icon={GitPullRequest} title="Commits and pull requests" tone={t.pullRequests.some((p) => p.status === 'merged') ? 'ok' : t.pullRequests.length ? 'neutral' : 'idle'} status={t.pullRequests.length ? t.pullRequests.map((p) => `${p.repo}: ${p.status === 'manual-pending' ? 'to create by hand' : p.status}`).join(' · ') : t.commits.length ? 'Pushed, no pull request yet' : 'Nothing pushed yet'}>
          {(t.commits.length > 0 || t.pullRequests.length > 0) && (
            <Box>
              <ul className="divide-y divide-line">
                {t.commits.map((c, i) => (
                  <li key={`c${i}`} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                    <GitCommitHorizontal aria-hidden className="size-4 shrink-0 text-faint" />
                    <span className="font-mono text-[12px]" title={c.commit}>
                      {c.commit.slice(0, 10)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted">
                      {c.repo} · {c.branch}
                      {c.reason === 'base-merged' ? ' · merged the base branch in' : ''}
                    </span>
                    {c.at && <span className="shrink-0 text-faint">{when(c.at)}</span>}
                    <CopyButton text={c.commit} label="Copy" variant="ghost" />
                  </li>
                ))}
                {t.pullRequests.map((p, i) => (
                  <li key={`p${i}`} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                    <GitPullRequest aria-hidden className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">
                      {p.repo}
                      <span className="text-faint"> · {p.status === 'manual-pending' ? 'link to create by hand' : p.status}</span>
                    </span>
                    <a href={p.url} target="_blank" rel="noreferrer noopener" className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg">
                      Open <ExternalLink aria-hidden className="size-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon={ShieldCheck} title="Audit log" last tone={t.integrity.ok ? 'ok' : 'danger'} status={t.audit.length ? `${t.audit.length} entries for this task` : 'Created before the audit log existed'}>
          {t.audit.length > 0 && (
            <Box>
              <ol className="max-h-[360px] divide-y divide-line overflow-y-auto">
                {[...t.audit].reverse().map((e) => (
                  <li key={e.seq} className="grid grid-cols-[44px_1fr_auto] items-baseline gap-3 px-4 py-2.5 text-[12.5px]">
                    <span className="font-mono text-[11.5px] text-faint">#{e.seq}</span>
                    <span className="min-w-0">
                      <span className="break-words">{e.summary}</span>
                      <span className="mt-0.5 block text-[11.5px] text-faint">
                        {e.actorName ? `${e.actorName} (${e.actor})` : e.actor === 'system' ? 'Tandem' : e.actor} · {when(e.at)} ·{' '}
                        <span className="font-mono" title={e.hash}>
                          {e.hash.slice(0, 10)}
                        </span>
                      </span>
                    </span>
                    <span className="font-mono text-[11px] text-faint">{e.action}</span>
                  </li>
                ))}
              </ol>
            </Box>
          )}
        </Stage>
      </ol>
    </div>
  );
}
