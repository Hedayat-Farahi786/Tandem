import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Braces, CheckCircle2, ChevronRight, FileCode2, FlaskConical, Hammer, Info, ListChecks, MinusCircle, Network, Package, ScanLine, SearchCheck, ShieldAlert, ShieldCheck, SkipForward, Terminal, TestTube, XCircle, type LucideIcon } from 'lucide-react';
import type { CommandResult, ReviewFinding } from '@tandem/shared';
import { post } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { TaskDetail } from '../lib/types';
import { Button, Pill, cx, useToast } from '../ui/kit';
import { CriterionText, FilePath } from '../ui/text';
import { SkipCheckButton } from './SkipCheck';

type Tone = 'ok' | 'danger' | 'warn' | 'neutral';
const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', danger: 'text-danger', warn: 'text-warn', neutral: 'text-muted' };
const TONE_TILE: Record<Tone, string> = { ok: 'bg-ok-soft text-ok', danger: 'bg-danger-soft text-danger', warn: 'bg-warn-soft text-warn', neutral: 'bg-surface-2 text-muted' };

/** What each check is, at a glance. */
const KIND: Record<string, { icon: LucideIcon; label: string }> = {
  install: { icon: Package, label: 'Install' },
  lint: { icon: ScanLine, label: 'Lint' },
  typecheck: { icon: Braces, label: 'Type check' },
  build: { icon: Hammer, label: 'Build' },
  test: { icon: FlaskConical, label: 'Tests' },
  'test-single': { icon: TestTube, label: 'One test' },
  integration: { icon: Network, label: 'Integration' },
};

const ok = (r: CommandResult) => r.skipped === true || r.preexisting !== undefined || (r.exitCode === 0 && !r.timedOut);

function Stat({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: Tone }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl bg-surface px-3.5 py-3 shadow-panel">
      <span aria-hidden className={cx('grid size-9 shrink-0 place-items-center rounded-[10px]', TONE_TILE[tone])}>
        <Icon className="size-[18px]" strokeWidth={2} />
      </span>
      <span className="min-w-0">
        <span className={cx('block text-[15px] leading-tight font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</span>
        <span className="block truncate text-[12px] text-muted">{label}</span>
      </span>
    </div>
  );
}

function Section({ icon: Icon, title, sub, action, children }: { icon: LucideIcon; title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-2xl bg-surface shadow-panel">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted shadow-[0_0_0_1px_var(--border)]">
          <Icon className="size-4" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] leading-snug font-semibold">{title}</span>
          {sub && <span className="mt-0.5 block text-[12.5px] text-muted">{sub}</span>}
        </span>
        {action}
      </header>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

type CriterionResult = 'pass' | 'fail' | 'none' | 'not-run' | 'skipped';

function ResultBadge({ result }: { result: CriterionResult }) {
  const look = {
    pass: { tone: 'ok' as const, icon: CheckCircle2, label: 'Pass' },
    fail: { tone: 'danger' as const, icon: XCircle, label: 'Fail' },
    none: { tone: 'warn' as const, icon: AlertTriangle, label: 'Missing' },
    'not-run': { tone: 'neutral' as const, icon: MinusCircle, label: 'Not run' },
    skipped: { tone: 'neutral' as const, icon: SkipForward, label: 'Skipped' },
  }[result];
  const Icon = look.icon;
  return (
    <Pill tone={look.tone}>
      <Icon aria-hidden className="size-3.5" strokeWidth={2.2} />
      {look.label}
    </Pill>
  );
}

/** One check: what it is, how it went, and its output when it failed. */
export function CommandRow({ r, taskId, repoName, canSkip }: { r: CommandResult; taskId: string; repoName?: string | undefined; canSkip: boolean }) {
  const passed = ok(r);
  const [open, setOpen] = useState(!passed);
  const kind = KIND[r.kind] ?? { icon: Terminal, label: r.kind };
  const KindIcon = kind.icon;
  const state = r.preexisting ? { icon: AlertTriangle, cls: 'text-warn', text: `fails on ${r.preexisting.base} too` } : r.skipped ? { icon: SkipForward, cls: 'text-faint', text: 'skipped by you' } : passed ? { icon: CheckCircle2, cls: 'text-ok', text: `${(r.durationMs / 1000).toFixed(1)} s` } : { icon: XCircle, cls: 'text-danger', text: r.timedOut ? 'timed out' : `exit ${r.exitCode ?? '?'}` };
  const StateIcon = state.icon;
  return (
    <li className="py-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="group flex w-full items-center gap-3 rounded-lg px-1.5 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-2">
        <span aria-hidden className={cx('grid size-7 shrink-0 place-items-center rounded-lg', passed ? 'bg-surface-2 text-muted' : 'bg-danger-soft text-danger')}>
          <KindIcon className="size-[15px]" strokeWidth={1.9} />
        </span>
        <span className="w-[86px] shrink-0 font-medium">{kind.label}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted" title={r.command}>
          {r.command}
        </code>
        <span className={cx('inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums', state.cls)}>
          <StateIcon aria-hidden className="size-3.5" strokeWidth={2.2} />
          {state.text}
        </span>
        {r.outputTail.trim() && <ChevronRight aria-hidden className={cx('size-3.5 shrink-0 text-faint transition-transform', open && 'rotate-90')} />}
      </button>
      {!passed && canSkip && (
        <div className="mt-1 flex justify-end">
          <SkipCheckButton taskId={taskId} repoId={r.repoId} repoName={repoName} kind={r.kind} />
        </div>
      )}
      {open && r.outputTail.trim() && <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{r.outputTail.trim()}</pre>}
    </li>
  );
}

const SEVERITY: Record<string, { tone: Tone; icon: LucideIcon; label: string }> = {
  high: { tone: 'danger', icon: ShieldAlert, label: 'High' },
  medium: { tone: 'warn', icon: AlertTriangle, label: 'Medium' },
  low: { tone: 'neutral', icon: Info, label: 'Low' },
};

/** Proof the change does what was asked: criteria with their tests, Tandem's checks, and the self-review. */
export function ChecksTab({ d }: { d: TaskDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const last = d.verifyRuns.at(-1);
  const verified = d.verifyRuns.length > 0;
  const repoName = (id?: string) => d.repos.find((r) => r.id === id)?.name ?? 'project';
  const toRule = useMutation({
    mutationFn: (f: ReviewFinding) => post('/api/rules', { repoId: f.repoId ?? d.repos[0]?.id, text: `${f.title}: ${f.detail.split('\n')[0]}`, source: `Self-review finding on ${d.task.key}` }),
    onSuccess: () => {
      toast('Saved as a rule for the next task branch.', 'ok');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });
  // Tests you skipped for this task read as skipped, not as waiting to run.
  const testsSkipped = (repoId?: string) => Boolean(last?.results.some((r) => (r.kind === 'test' || r.kind === 'integration') && r.skipped && (!repoId || !r.repoId || r.repoId === repoId)));
  const criteria = d.task.requirement.criteria.map((c, i) => {
    const tests = d.tests.filter((t) => t.criterion === i + 1);
    const result: CriterionResult = tests.length === 0 ? (verified ? 'none' : 'not-run') : tests.some((t) => t.result === 'fail') ? 'fail' : tests.every((t) => t.result === 'pass') ? 'pass' : tests.every((t) => t.result === 'pass' || testsSkipped(t.repoId)) ? 'skipped' : 'not-run';
    return { c, n: i + 1, tests, result };
  });
  const proven = criteria.filter((x) => x.result === 'pass').length;
  const allSkipped = criteria.length > 0 && criteria.every((x) => x.result === 'pass' || x.result === 'skipped') && proven < criteria.length;
  const cmds = last?.results ?? [];
  const passing = cmds.filter(ok).length;
  const openFindings = d.findings.filter((f) => f.status === 'open');
  const canSkip = d.task.state !== 'DONE' && d.task.state !== 'CANCELLED';
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
        <Stat icon={ListChecks} label={allSkipped ? 'Criteria tests' : 'Criteria proven'} value={!criteria.length ? 'None' : allSkipped && proven === 0 ? 'Skipped' : `${proven} of ${criteria.length}`} tone={!criteria.length ? 'neutral' : proven === criteria.length ? 'ok' : criteria.some((x) => x.result === 'fail') ? 'danger' : 'neutral'} />
        <Stat icon={ShieldCheck} label="Checks passing" value={last ? `${passing} of ${cmds.length}` : 'Not run yet'} tone={!last ? 'neutral' : last.passed ? 'ok' : 'danger'} />
        <Stat icon={SearchCheck} label="Review findings" value={openFindings.length ? `${openFindings.length} open` : d.findings.length ? 'All resolved' : d.task.progress.reviewed ? 'None' : 'Not yet'} tone={openFindings.some((f) => f.severity === 'high') ? 'danger' : openFindings.length ? 'warn' : d.task.progress.reviewed ? 'ok' : 'neutral'} />
      </div>

      <Section icon={ListChecks} title="Acceptance criteria and tests" sub="Each criterion is proven by a test Copilot recorded and Tandem ran.">
        {criteria.length === 0 ? (
          <p className="text-[13px] text-muted">No criteria.</p>
        ) : (
          <div role="table" aria-label="Acceptance criteria and tests" className="flex flex-col gap-2.5">
            {criteria.map(({ c, n, tests, result }) => (
              <div role="row" key={n} className={cx('grid grid-cols-[22px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-xl border px-3 py-3', result === 'fail' ? 'border-danger/40' : 'border-line')}>
                <span aria-hidden className="mt-px grid size-[22px] place-items-center rounded-md bg-surface-2 text-[11px] font-semibold text-muted tabular-nums">{n}</span>
                <div role="cell" className="min-w-0 text-[13.5px] leading-relaxed">
                  <CriterionText c={c} />
                </div>
                <div role="cell" className="row-span-2 self-start">
                  <ResultBadge result={result} />
                </div>
                <div role="cell" className="col-start-2 flex min-w-0 flex-col gap-1">
                  {tests.length ? (
                    tests.map((t) => (
                      <div key={`${t.repoId}${t.file}${t.name}`} className="flex min-w-0 items-start gap-2">
                        <FlaskConical aria-hidden className="mt-[3px] size-3.5 shrink-0 text-faint" strokeWidth={1.9} />
                        <div className="min-w-0">
                          <p className="text-[12.5px] leading-snug text-fg">{t.name}</p>
                          <FilePath path={t.file} {...(d.repos.length > 1 ? { prefix: `${repoName(t.repoId)} · ` } : {})} className="text-[11.5px] text-faint" />
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="flex items-center gap-1.5 text-[12.5px] text-faint">
                      <FlaskConical aria-hidden className="size-3.5" strokeWidth={1.9} />
                      {verified ? 'No test recorded' : 'Recorded during the build'}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        icon={Terminal}
        title="Checks"
        sub={last ? `Run ${d.verifyRuns.length} · ${relativeTime(last.createdAt)} · run by Tandem, not the agent` : 'Install, lint, type check, build and tests, run by Tandem after the build.'}
        action={
          last && (
            <Pill tone={last.passed ? 'ok' : 'danger'} dot>
              {last.passed ? 'All checks pass' : 'Failing'}
            </Pill>
          )
        }
      >
        {!last ? (
          <div className="flex flex-wrap gap-2">
            {['install', 'lint', 'typecheck', 'build', 'test'].map((k) => {
              const K = KIND[k]!;
              const Icon = K.icon;
              return (
                <span key={k} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1 text-[12.5px] text-muted">
                  <Icon aria-hidden className="size-3.5" strokeWidth={1.9} />
                  {K.label}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {[...new Set(last.results.map((r) => r.repoId ?? ''))].map((repoId) => (
              <div key={repoId}>
                {d.repos.length > 1 && <p className="mb-1 px-1.5 text-[11.5px] font-semibold tracking-wide text-faint uppercase">{repoName(repoId)}</p>}
                <ul className="-my-1.5">
                  {last.results
                    .filter((r) => (r.repoId ?? '') === repoId)
                    .map((r, i) => (
                      <CommandRow key={i} r={r} taskId={d.task.id} repoName={d.repos.length > 1 ? repoName(repoId) : undefined} canSkip={canSkip} />
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section icon={SearchCheck} title="Self-review" sub="A separate read-only review against the spec, the criteria, your repo rules and a security checklist.">
        {d.findings.length === 0 ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            {d.task.progress.reviewed ? <CheckCircle2 aria-hidden className="size-4 text-ok" /> : <MinusCircle aria-hidden className="size-4 text-faint" />}
            {d.task.progress.reviewed ? 'No findings.' : 'Runs after the checks pass.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {d.findings.map((f) => {
              const sev = SEVERITY[f.severity] ?? SEVERITY.low!;
              const SevIcon = sev.icon;
              return (
                <li key={f.id} className="rounded-xl border border-line px-3 py-3">
                  <div className="flex items-start gap-2.5">
                    <span aria-hidden className={cx('mt-px grid size-7 shrink-0 place-items-center rounded-lg', TONE_TILE[sev.tone])}>
                      <SevIcon className="size-4" strokeWidth={2} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] leading-snug font-medium">{f.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                        <span className={TONE_TEXT[sev.tone]}>{sev.label}</span>
                        <span aria-hidden>·</span>
                        <span>{f.category}</span>
                        {f.file && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                              <FileCode2 aria-hidden className="size-3.5 shrink-0" />
                              <span className="truncate">
                                {repoName(f.repoId)}/{f.file}
                                {f.line ? `:${f.line}` : ''}
                              </span>
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <Pill tone={f.status === 'fixed' ? 'ok' : f.status === 'dismissed' ? 'neutral' : 'accent'}>
                      {f.status === 'fixed' ? <CheckCircle2 aria-hidden className="size-3.5" /> : f.status === 'open' ? <AlertTriangle aria-hidden className="size-3.5" /> : <MinusCircle aria-hidden className="size-3.5" />}
                      {f.status === 'open' ? 'Open' : f.status === 'fixed' ? 'Fixed' : 'Dismissed'}
                    </Pill>
                  </div>
                  <p className="mt-2 pl-[38px] text-[13px] whitespace-pre-line text-muted">{f.detail}</p>
                  <div className="mt-1.5 pl-[30px]">
                    <Button size="sm" variant="ghost" icon={ShieldAlert} busy={toRule.isPending && toRule.variables?.id === f.id} onClick={() => toRule.mutate(f)}>
                      Turn into a rule
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
