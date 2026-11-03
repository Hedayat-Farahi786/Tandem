import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MinusCircle, RefreshCw, Stethoscope, XCircle } from 'lucide-react';
import { api, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { DoctorCheck, DoctorReport } from '../lib/types';
import { Button, Callout, EmptyState, ErrorState, Loading, PageHeader, cx } from '../ui/kit';

const ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, skipped: MinusCircle } as const;
const COLOR = { pass: 'text-ok', warn: 'text-warn', fail: 'text-danger', skipped: 'text-faint' } as const;
const WORD = { pass: 'Pass', warn: 'Warning', fail: 'Fail', skipped: 'Skipped' } as const;

export function DoctorList({ report }: { report: DoctorReport }) {
  const groups = [...new Set(report.checks.map((c) => c.group))];
  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g} aria-labelledby={`doctor-${g}`}>
          <h3 id={`doctor-${g}`} className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">
            {g}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {report.checks.filter((c) => c.group === g).map((c) => (
              <DoctorRow key={c.id} c={c} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DoctorRow({ c }: { c: DoctorCheck }) {
  const Icon = ICON[c.status];
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', COLOR[c.status])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{c.label}</span>
          <span className="sr-only"> — {WORD[c.status]}</span>
        </p>
        <p className="text-[13px] break-words text-muted">{c.message}</p>
        {c.fix && c.status !== 'pass' && <p className="mt-1 text-[13px] text-fg">→ {c.fix}</p>}
      </div>
    </li>
  );
}

/** One line on the whole run: failures, warnings, or all clear. */
export function DoctorSummary({ report }: { report: DoctorReport }) {
  const fails = report.checks.filter((c) => c.status === 'fail').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  const title = fails ? `${fails} check${fails > 1 ? 's' : ''} need${fails > 1 ? '' : 's'} attention` : warns ? `Everything required passes, with ${warns} warning${warns > 1 ? 's' : ''}` : 'Everything passes';
  return (
    <Callout tone={fails ? 'danger' : warns ? 'warn' : 'ok'} title={title}>
      Last run {relativeTime(report.at)}.
    </Callout>
  );
}

export function DoctorScreen() {
  const qc = useQueryClient();
  const last = useQuery({ queryKey: ['doctor'], queryFn: () => api<DoctorReport | null>('/api/doctor') });
  const run = useMutation({ mutationFn: () => post<DoctorReport>('/api/doctor'), onSuccess: (r) => qc.setQueryData(['doctor'], r) });
  const report = run.data ?? last.data;
  return (
    <div>
      <PageHeader
        title="Doctor"
        subtitle="Checks your tools, repositories, Copilot, AWS and Jira. It never sends a prompt to Copilot, so it doesn't use your budget."
        actions={
          <Button variant="primary" icon={RefreshCw} busy={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running checks…' : 'Run checks'}
          </Button>
        }
      />
      {run.isError && <ErrorState error={run.error} />}
      {last.isLoading ? (
        <Loading />
      ) : !report ? (
        <EmptyState icon={Stethoscope} title="No checks yet" body="Run doctor to see what works and what needs a fix." action={<Button variant="primary" onClick={() => run.mutate()}>Run checks</Button>} />
      ) : (
        <div className="flex flex-col gap-6">
          <DoctorSummary report={report} />
          <DoctorList report={report} />
        </div>
      )}
    </div>
  );
}
