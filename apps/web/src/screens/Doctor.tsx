import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MinusCircle, RefreshCw, Stethoscope, XCircle } from 'lucide-react';
import { api, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { DoctorCheck, DoctorReport } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, SettingsSection, cx } from '../ui/kit';

const ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, skipped: MinusCircle } as const;
const COLOR = { pass: 'text-ok', warn: 'text-warn', fail: 'text-danger', skipped: 'text-faint' } as const;
const WORD = { pass: 'Pass', warn: 'Warning', fail: 'Fail', skipped: 'Skipped' } as const;

const GROUP_TITLE = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);

export function DoctorList({ report }: { report: DoctorReport }) {
  const groups = [...new Set(report.checks.map((c) => c.group))];
  return (
    <div className="flex flex-col gap-9">
      {groups.map((g) => (
        <SettingsSection key={g} title={GROUP_TITLE(g)}>
          {report.checks
            .filter((c) => c.group === g)
            .map((c) => (
              <DoctorRow key={c.id} c={c} />
            ))}
        </SettingsSection>
      ))}
    </div>
  );
}

function DoctorRow({ c }: { c: DoctorCheck }) {
  const Icon = ICON[c.status];
  return (
    <div className="flex gap-3 py-3.5">
      <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', COLOR[c.status])} />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">
          {c.label}
          <span className="sr-only"> — {WORD[c.status]}</span>
        </p>
        <p className="text-[13px] break-words text-muted">{c.message}</p>
        {c.fix && c.status !== 'pass' && <p className="mt-1.5 text-[13px] text-fg">{c.fix}</p>}
      </div>
    </div>
  );
}

/** One line on the whole run: failures, warnings, or all clear. */
export function DoctorSummary({ report }: { report: DoctorReport }) {
  const fails = report.checks.filter((c) => c.status === 'fail').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  const passed = report.checks.filter((c) => c.status === 'pass').length;
  const title = fails ? `${fails} check${fails > 1 ? 's' : ''} need${fails > 1 ? '' : 's'} attention` : warns ? `Everything required passes, with ${warns} warning${warns > 1 ? 's' : ''}` : 'Everything passes';
  const tone = fails ? 'fail' : warns ? 'warn' : 'pass';
  const Icon = ICON[tone];
  return (
    <div role="status" className="flex items-center gap-3.5">
      <span className={cx('grid size-10 shrink-0 place-items-center rounded-full', fails ? 'bg-danger-soft' : warns ? 'bg-warn-soft' : 'bg-ok-soft')}>
        <Icon aria-hidden className={cx('size-5', COLOR[tone])} />
      </span>
      <div>
        <p className="text-[16px] font-semibold tracking-tight">{title}</p>
        <p className="text-[13px] text-muted">
          {passed} of {report.checks.length} checks pass · last run {relativeTime(report.at)}
        </p>
      </div>
    </div>
  );
}

export function DoctorScreen() {
  const qc = useQueryClient();
  const last = useQuery({ queryKey: ['doctor'], queryFn: () => api<DoctorReport | null>('/api/doctor') });
  const run = useMutation({ mutationFn: () => post<DoctorReport>('/api/doctor'), onSuccess: (r) => qc.setQueryData(['doctor'], r) });
  const report = run.data ?? last.data;
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[30px] leading-tight font-medium tracking-tight">Doctor</h1>
          <p className="mt-1 text-[13.5px] text-muted">Checks your tools, repositories, Copilot, AWS and Jira. It never sends a prompt, so it uses none of your budget.</p>
        </div>
        <Button icon={RefreshCw} busy={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Running checks…' : 'Run checks'}
        </Button>
      </div>
      {run.isError && <ErrorState error={run.error} />}
      {last.isLoading ? (
        <Loading />
      ) : !report ? (
        <EmptyState icon={Stethoscope} title="No checks yet" body="Run doctor to see what works and what needs a fix." action={<Button variant="primary" onClick={() => run.mutate()}>Run checks</Button>} />
      ) : (
        <div className={cx('flex flex-col gap-10 transition-opacity duration-200', run.isPending && 'opacity-60')}>
          <DoctorSummary report={report} />
          <DoctorList report={report} />
        </div>
      )}
    </div>
  );
}
