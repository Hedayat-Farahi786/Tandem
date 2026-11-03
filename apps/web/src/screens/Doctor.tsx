import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, CheckCircle2, Cloud, FolderGit2, HardDrive, MinusCircle, RefreshCw, Stethoscope, Ticket, Wrench, XCircle, type LucideIcon } from 'lucide-react';
import { IconTile, Ring } from '../ui/visual';
import { api, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { DoctorCheck, DoctorReport } from '../lib/types';
import { Button, EmptyState, ErrorState, Loading, SettingsSection, cx } from '../ui/kit';

const ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, skipped: MinusCircle } as const;
const COLOR = { pass: 'text-ok', warn: 'text-warn', fail: 'text-danger', skipped: 'text-faint' } as const;
const WORD = { pass: 'Pass', warn: 'Warning', fail: 'Fail', skipped: 'Skipped' } as const;

const GROUP_TITLE = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);
const GROUP_ICON: Record<string, LucideIcon> = { tools: Wrench, machine: HardDrive, copilot: Bot, repositories: FolderGit2, aws: Cloud, jira: Ticket };
const worst = (r: DoctorReport, g: string) => {
  const st = r.checks.filter((c) => c.group === g).map((c) => c.status);
  return st.includes('fail') ? 'danger' : st.includes('warn') ? 'warn' : st.every((x) => x === 'skipped') ? 'neutral' : 'ok';
};
const groupLine = (r: DoctorReport, g: string) => {
  const cs = r.checks.filter((c) => c.group === g);
  const pass = cs.filter((c) => c.status === 'pass').length;
  const issues = cs.filter((c) => c.status === 'warn' || c.status === 'fail').length;
  return issues ? `${issues} to look at` : pass ? `${pass} of ${cs.length} pass` : 'Not set up';
};

export function DoctorList({ report }: { report: DoctorReport }) {
  const groups = [...new Set(report.checks.map((c) => c.group))];
  return (
    <div className="flex flex-col gap-9">
      {groups.map((g) => (
        <SettingsSection
          key={g}
          icon={<IconTile icon={GROUP_ICON[g.toLowerCase()] ?? Stethoscope} tone={worst(report, g)} />}
          title={GROUP_TITLE(g)}
          actions={<span className="text-[12.5px] text-muted tabular-nums">{groupLine(report, g)}</span>}
        >
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
    <div role="status" className="flex items-center gap-5 rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <Ring value={passed / Math.max(1, report.checks.length)} size={76} stroke={7} tone={fails ? 'danger' : warns ? 'warn' : 'ok'}>
        <span className="text-center leading-none">
          <span className="block font-serif text-[22px] font-medium tabular-nums">{passed}</span>
          <span className="text-[10.5px] text-muted">of {report.checks.length}</span>
        </span>
      </Ring>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <Icon aria-hidden className={cx('size-5', COLOR[tone])} />
          {title}
        </p>
        <p className="mt-1 text-[13px] text-muted">
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
