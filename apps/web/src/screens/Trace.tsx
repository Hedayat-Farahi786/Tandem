import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BadgeCheck, Ban, CheckCircle2, ChevronRight, Circle, CircleDashed, ExternalLink, FileCode2, FileDown, FileText, Fingerprint, GitCommitHorizontal, GitPullRequest, History, ListChecks, MessageSquareText, MinusCircle, SearchCheck, ShieldAlert, ShieldCheck, SkipForward, Timer, UserCheck, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import type { Trace } from '../lib/types';
import { CopyButton, ErrorState, LinkButton, Loading, cx } from '../ui/kit';
import { CreditsInfo } from '../ui/credits-info';
import { BrandLogo, providerOf, type Brand } from '../ui/brands';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** One link in the chain: an icon on the rail, a title, a one-line status and the facts. */
function Stage({ icon: Icon, title, status, tone = 'neutral', children, last }: { icon: LucideIcon | Brand; title: string; status: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'idle'; children?: ReactNode; last?: boolean }) {
  const tones = { neutral: 'bg-surface text-fg shadow-[0_0_0_1px_var(--border-strong)]', ok: 'bg-ok-soft text-ok shadow-[0_0_0_1px_color-mix(in_srgb,var(--ok)_25%,transparent)]', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', idle: 'bg-surface-2 text-faint' };
  return (
    <li className="relative grid grid-cols-[36px_1fr] gap-x-4">
      {!last && <span aria-hidden className="absolute top-10 bottom-0 left-[17.5px] w-px bg-line" />}
      <span aria-hidden className={cx('relative z-[1] mt-0.5 grid size-9 place-items-center rounded-xl', tones[tone])}>
        {typeof Icon === 'string' ? <BrandLogo brand={Icon} size={17} /> : <Icon className="size-[17px]" strokeWidth={1.9} />}
      </span>
      <div className="min-w-0 pb-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-1.5">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h3>
          <p className="text-[13px] text-muted">{status}</p>
        </div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </li>
  );
}

const Box = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx('overflow-hidden rounded-xl bg-surface shadow-panel', className)}>{children}</div>;

/** Each Copilot role in plain words. */
const ROLE: Record<string, string> = { extract: 'Read the request', size: 'Estimated the size', spec: 'Wrote the spec', build: 'Built the change', fix: 'Fixed failing checks', review: 'Reviewed its own work', conflict: 'Resolved conflicts', 'task-chat': 'Answered in the task chat', request: 'Shaped the request', ask: 'Answered a question' };
const secs = (ms?: number) => (ms === undefined ? '' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const short = (h?: string) => (h ? h.slice(0, 12) : '');
const STATE_WORD: Record<string, string> = { DRAFT: 'Draft', READINESS: 'Readiness check', SPEC_DRAFTING: 'Drafting spec', SPEC_REVIEW: 'Spec review', BUILDING: 'Building', VERIFYING: 'Verifying', SELF_REVIEW: 'Self-review', PR_OPEN: 'PR open', DONE: 'Done', BLOCKED: 'Blocked', FAILED: 'Failed', CANCELLED: 'Cancelled' };
const EXCEPTION: Record<string, { icon: LucideIcon; cls: string; label: string }> = {
  'failed-run': { icon: XCircle, cls: 'text-danger', label: 'Run failed' },
  'stopped-run': { icon: MinusCircle, cls: 'text-faint', label: 'Run stopped' },
  'blocked-action': { icon: Ban, cls: 'text-warn', label: 'Refused by a guardrail' },
  limit: { icon: Timer, cls: 'text-warn', label: 'Credit limit' },
  failure: { icon: XCircle, cls: 'text-danger', label: 'Task failed' },
  'skipped-check': { icon: SkipForward, cls: 'text-muted', label: 'Check skipped' },
  preexisting: { icon: AlertTriangle, cls: 'text-warn', label: 'Fails on the base branch too' },
  attention: { icon: AlertTriangle, cls: 'text-warn', label: 'Needs attention' },
};

/** Opens to show more, natively (keyboard and screen readers included). */
function More({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group/more">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open/more:rotate-90" />
        {summary}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

const Hash = ({ value, label }: { value?: string; label: string }) =>
  value ? (
    <span title={`${label}: ${value}`} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 font-mono text-[11px] text-muted">
      <Fingerprint aria-hidden className="size-3" />
      {short(value)}
    </span>
  ) : null;

const RESULT: Record<string, { icon: LucideIcon; cls: string; label: string }> = {
  pass: { icon: CheckCircle2, cls: 'text-ok', label: 'Passing' },
  fail: { icon: XCircle, cls: 'text-danger', label: 'Failing' },
  'not-run': { icon: CircleDashed, cls: 'text-faint', label: 'Not run yet' },
  'no-test': { icon: Circle, cls: 'text-faint', label: 'No test yet' },
  skipped: { icon: SkipForward, cls: 'text-faint', label: 'Tests skipped' },
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
    <div>
      <div className="mb-8 flex flex-wrap items-center gap-4 rounded-2xl bg-surface px-5 py-4 shadow-panel">
        <span aria-hidden className={cx('grid size-10 shrink-0 place-items-center rounded-xl', t.integrity.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>
          {t.integrity.ok ? <ShieldCheck className="size-5" strokeWidth={1.9} /> : <ShieldAlert className="size-5" strokeWidth={1.9} />}
        </span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-[14px] font-semibold">Traceability</p>
          <p className="mt-0.5 text-[13px] text-muted">
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
        <ul aria-label="Summary" className="flex w-full flex-wrap gap-1.5 border-t border-line pt-3">
          {[
            { icon: UserCheck, text: t.request.by ? `Requested by ${t.request.by}` : 'Request recorded' },
            { icon: BadgeCheck, text: approved ? `Spec v${approved.version} approved` : 'Spec not approved yet' },
            { icon: History, text: `${t.runs.length} Copilot run${t.runs.length === 1 ? '' : 's'} · ${t.usage.aiCredits} credits`, info: true },
            { icon: GitCommitHorizontal, text: `${t.changes.length} commit${t.changes.length === 1 ? '' : 's'}` },
            { icon: UserCheck, text: `${t.decisions.length} decision${t.decisions.length === 1 ? '' : 's'} by people` },
            { icon: t.exceptions.length ? AlertTriangle : CheckCircle2, text: t.exceptions.length ? `${t.exceptions.length} exception${t.exceptions.length === 1 ? '' : 's'}` : 'No exceptions' },
          ].map((x, i) => (
            <li key={i} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[12px] text-muted">
              <x.icon aria-hidden className="size-3.5" />
              {x.text}
              {'info' in x && x.info && <CreditsInfo className="-mr-1" />}
            </li>
          ))}
        </ul>
      </div>

      <ol aria-label="Trace">
        <Stage icon={MessageSquareText} title="Request" status={`${t.task.source === 'chat' ? 'From chat' : t.task.source === 'jira' ? `From Jira${t.task.externalKey ? ` ${t.task.externalKey}` : ''}` : t.task.source === 'split' ? 'Split from a bigger task' : 'Created in Tandem'} · ${when(t.task.createdAt)}`}>
          <Box className="px-4 py-3">
            <p className="text-[12px] text-faint">{t.request.by ? `${t.request.by} asked` : 'The request'}</p>
            <blockquote className="mt-1 line-clamp-4 border-l-2 border-line-strong pl-3 text-[13.5px] leading-relaxed whitespace-pre-line" title={t.request.text}>
              {t.request.text || <span className="text-faint">No text.</span>}
            </blockquote>
            <p className="mt-3 text-[13px]">
              <span className="text-faint">Goal · </span>
              {t.requirement.goal || <span className="text-faint">none yet</span>}
            </p>
            {t.requirement.outOfScope && (
              <p className="mt-1 text-[13px]">
                <span className="text-faint">Out of scope · </span>
                {t.requirement.outOfScope}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
              <span className={cx('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5', t.request.ready ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn')}>
                {t.request.ready ? <CheckCircle2 aria-hidden className="size-3.5" /> : <AlertTriangle aria-hidden className="size-3.5" />}
                {t.request.ready ? 'Definition of Ready met' : `Not ready: ${t.request.missing.join('; ')}`}
              </span>
              {t.request.size && (
                <span title={t.request.size.rationale} className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-muted">
                  About {t.request.size.lines} lines
                </span>
              )}
            </div>
          </Box>
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
                          <div key={i} className="mt-1.5 min-w-0">
                            <p className="text-[12.5px] leading-snug text-muted">{x.name}</p>
                            <p className="truncate font-mono text-[11.5px] text-faint" title={`${x.repo}: ${x.file}`}>
                              {x.repo}: {x.file}
                            </p>
                          </div>
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
                        {s.source === 'edit' ? 'Edited' : s.source === 'redraft' ? 'Redrafted' : s.source === 'chat' ? 'Written in the request chat' : 'Drafted'} {when(s.createdAt)}
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
                        <span className="text-[12px] text-faint">No approvals</span>
                      )}
                    </div>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className={cx('text-[12px]', s.status === 'approved' ? 'text-ok' : s.status === 'in-review' ? 'text-warn' : 'text-faint')}>{s.status === 'approved' ? 'Approved' : s.status === 'in-review' ? 'In review' : 'Superseded'}</span>
                      <Hash value={s.sha256} label="SHA-256 of this version's text" />
                    </span>
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon="copilot" title="Copilot runs" tone={t.runs.length ? (t.runs.some((r) => r.status === 'failed') ? 'warn' : 'neutral') : 'idle'} status={t.runs.length ? `${t.runs.length} run${t.runs.length === 1 ? '' : 's'} · ${t.usage.prompts} prompts · ${t.usage.modelCalls} model calls · ${t.usage.aiCredits} AI credits` : 'No runs yet'}>
          {t.runs.length > 0 && (
            <Box>
              <ol className="divide-y divide-line">
                {t.runs.map((r) => {
                  const brand = r.model ? providerOf(r.model) : undefined;
                  return (
                    <li key={r.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        {r.status === 'succeeded' ? <CheckCircle2 aria-label="succeeded" className="size-4 shrink-0 text-ok" /> : r.status === 'failed' ? <XCircle aria-label="failed" className="size-4 shrink-0 text-danger" /> : r.status === 'running' ? <CircleDashed aria-label="running" className="size-4 shrink-0 text-accent" /> : <MinusCircle aria-label="stopped" className="size-4 shrink-0 text-faint" />}
                        <span className="text-[13.5px] font-medium">{ROLE[r.kind] ?? r.kind}</span>
                        <span className={cx('rounded-md px-1.5 text-[11px] font-medium', r.mode === 'build' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>{r.mode === 'build' ? 'writes code' : 'read-only'}</span>
                        <span className="ml-auto text-[12px] text-faint tabular-nums">{when(r.startedAt)}</span>
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[26px] text-[12px] text-muted tabular-nums">
                        {r.model && (
                          <span className="inline-flex items-center gap-1">
                            {brand && <BrandLogo brand={brand} size={12} />}
                            {r.model}
                          </span>
                        )}
                        {r.durationMs !== undefined && <span>{secs(r.durationMs)}</span>}
                        <span>{r.actions} action{r.actions === 1 ? '' : 's'}</span>
                        {r.filesChanged.length > 0 && <span>{r.filesChanged.length} file{r.filesChanged.length === 1 ? '' : 's'} changed</span>}
                        {r.blocked.length > 0 && <span className="text-warn">{r.blocked.length} refused</span>}
                        <span>{r.aiCredits} credits</span>
                        <Hash value={r.instructionsSha} label="SHA-256 of Tandem's instructions for this run" />
                        {r.withGuidance && <span className="rounded-md bg-accent-soft px-1.5 text-[11px] text-accent-text">with your guidance</span>}
                      </p>
                      {r.error && <p className="mt-1 pl-[26px] text-[12px] break-words text-danger">{r.error.split('\n')[0]}</p>}
                      {(r.filesChanged.length > 0 || r.blocked.length > 0) && (
                        <div className="mt-1.5 pl-[26px]">
                          <More summary="Files and refused actions">
                            <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-muted">
                              {r.filesChanged.map((f) => (
                                <li key={f} className="flex items-center gap-1.5 break-all">
                                  <FileCode2 aria-hidden className="size-3 shrink-0" />
                                  {f}
                                </li>
                              ))}
                              {r.blocked.map((x, i) => (
                                <li key={`b${i}`} className="flex items-start gap-1.5 break-all text-warn">
                                  <Ban aria-hidden className="mt-0.5 size-3 shrink-0" />
                                  {x.tool} {x.what}
                                  {x.reason ? ` · ${x.reason}` : ''}
                                </li>
                              ))}
                            </ul>
                          </More>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </Box>
          )}
        </Stage>

        <Stage icon={GitCommitHorizontal} title="Code changes" tone={t.changes.length ? 'neutral' : 'idle'} status={t.changes.length ? `${t.changes.length} commit${t.changes.length === 1 ? '' : 's'} by Tandem on the task branch` : 'No commits recorded'}>
          {t.changes.length > 0 && (
            <Box>
              <ul className="divide-y divide-line">
                {t.changes.map((c, i) => (
                  <li key={i} className="px-4 py-2.5">
                    <p className="flex items-center gap-2 text-[13px]">
                      <span className="font-mono text-[12px] text-muted" title={c.commit}>
                        {c.commit.slice(0, 8)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{c.message}</span>
                      <span className="shrink-0 text-[12px] text-faint">{when(c.at)}</span>
                    </p>
                    {c.files.length > 0 && (
                      <div className="mt-1">
                        <More summary={`${c.files.length} file${c.files.length === 1 ? '' : 's'} in ${c.repo}`}>
                          <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-muted">
                            {c.files.map((f) => (
                              <li key={f} className="flex items-center gap-1.5 break-all">
                                <FileCode2 aria-hidden className="size-3 shrink-0" />
                                {f}
                              </li>
                            ))}
                          </ul>
                        </More>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon={SearchCheck} title="Checks and review" tone={!latestChecks ? 'idle' : latestChecks.passed && !openFindings ? 'ok' : latestChecks.passed ? 'warn' : 'danger'} status={latestChecks ? `${t.checks.length} run${t.checks.length === 1 ? '' : 's'}, the last ${latestChecks.passed ? 'passed' : 'failed'} · ${t.findings.length ? `${openFindings} of ${t.findings.length} findings open` : 'no review findings'}` : 'Not run yet'}>
          {latestChecks && (
            <div className="flex flex-wrap gap-1.5">
              {latestChecks.results.map((r, i) => {
                const x = r as typeof r & { skipped?: boolean; preexisting?: { base: string } };
                const ok = x.skipped || x.preexisting || (r.exitCode === 0 && !r.timedOut);
                return (
                  <span key={i} title={`${r.repo}: ${r.command} · ${x.skipped ? 'skipped by you' : x.preexisting ? `fails on ${x.preexisting.base} too` : `${(r.durationMs / 1000).toFixed(1)} s`}`} className={cx('inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px]', ok ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--border)]' : 'bg-danger-soft text-danger')}>
                    {x.skipped ? <SkipForward aria-hidden className="size-3.5 text-faint" /> : x.preexisting ? <AlertTriangle aria-hidden className="size-3.5 text-warn" /> : ok ? <CheckCircle2 aria-hidden className="size-3.5 text-ok" /> : <XCircle aria-hidden className="size-3.5" />}
                    {r.kind}
                    <span className="text-faint tabular-nums">{(r.durationMs / 1000).toFixed(1)}s</span>
                  </span>
                );
              })}
            </div>
          )}
        </Stage>

        <Stage icon={UserCheck} title="Decisions by people" tone={t.decisions.length ? 'neutral' : 'idle'} status={t.decisions.length ? `${t.decisions.length} recorded` : 'None recorded'}>
          {t.decisions.length > 0 && (
            <Box>
              <ul className="divide-y divide-line">
                {t.decisions.map((x, i) => (
                  <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5 text-[13px]">
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{x.who}</span>
                      <span className="text-muted"> · {x.summary.replace(/^[A-Z0-9]+-\d+: /, '')}</span>
                    </span>
                    <span className="text-[12px] text-faint">{when(x.at)}</span>
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon={AlertTriangle} title="Exceptions" tone={t.exceptions.length ? 'warn' : 'ok'} status={t.exceptions.length ? `${t.exceptions.length} to know about` : 'None: everything went to plan'}>
          {t.exceptions.length > 0 && (
            <Box>
              <ul className="divide-y divide-line">
                {t.exceptions.map((x, i) => {
                  const e = EXCEPTION[x.kind]!;
                  return (
                    <li key={i} className="flex gap-3 px-4 py-2.5 text-[13px]">
                      <e.icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', e.cls)} />
                      <span className="min-w-0 flex-1 break-words">
                        <span className={cx('font-medium', e.cls)}>{e.label}</span>
                        <span className="text-muted"> · {x.text}</span>
                      </span>
                      {x.at && <span className="shrink-0 text-[12px] text-faint">{when(x.at)}</span>}
                    </li>
                  );
                })}
              </ul>
            </Box>
          )}
        </Stage>

        <Stage icon={GitPullRequest} title="Pushes and pull requests" tone={t.pullRequests.some((p) => p.status === 'merged') ? 'ok' : t.pullRequests.length ? 'neutral' : 'idle'} status={t.pullRequests.length ? t.pullRequests.map((p) => `${p.repo}: ${p.status === 'manual-pending' ? 'to create by hand' : p.status}`).join(' · ') : t.commits.length ? 'Pushed, no pull request yet' : 'Nothing pushed yet'}>
          {(t.commits.length > 0 || t.pullRequests.length > 0) && (
            <Box>
              <ul className="divide-y divide-line">
                {t.commits.map((c, i) => (
                  <li key={`c${i}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
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
                  <li key={`p${i}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
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

        <Stage icon={History} title="Lifecycle" tone={t.lifecycle.length ? 'neutral' : 'idle'} status={`${t.lifecycle.length} state change${t.lifecycle.length === 1 ? '' : 's'}`}>
          {t.lifecycle.length > 0 && (
            <Box>
              <More summary="Every state change, who made it and why">
                <ol className="divide-y divide-line">
                  {t.lifecycle.map((x, i) => (
                    <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2 text-[12.5px]">
                      <span className="min-w-0 break-words">
                        <span className="font-medium">{x.from === x.to ? STATE_WORD[x.to] ?? x.to : `${STATE_WORD[x.from] ?? x.from} → ${STATE_WORD[x.to] ?? x.to}`}</span>
                        <span className="text-muted"> · {x.actor === 'system' ? 'Tandem' : x.actor === 'agent' ? 'Copilot' : x.actor === 'pm' ? 'PM' : 'You'} · {x.reason}</span>
                      </span>
                      <span className="text-faint">{when(x.at)}</span>
                    </li>
                  ))}
                </ol>
              </More>
            </Box>
          )}
        </Stage>

        <Stage icon={ShieldCheck} title="Audit log" last tone={t.integrity.ok ? 'ok' : 'danger'} status={t.audit.length ? `${t.audit.length} entries for this task` : 'Created before the audit log existed'}>
          {t.audit.length > 0 && (
            <Box>
              <ol tabIndex={0} aria-label="Audit entries for this task" className="max-h-[360px] divide-y divide-line overflow-y-auto focus-visible:outline-offset-[-2px]">
                {[...t.audit].reverse().map((e) => (
                  <li key={e.seq} className="grid grid-cols-[44px_1fr_auto] items-baseline gap-3 px-4 py-2.5 text-[13px]">
                    <span className="font-mono text-[12px] text-faint">#{e.seq}</span>
                    <span className="min-w-0">
                      <span className="break-words">{e.summary}</span>
                      <span className="mt-0.5 block text-[12px] text-faint">
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
