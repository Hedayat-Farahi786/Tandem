import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, ChevronRight, CircleDot, FileText, GitCommitHorizontal, GitPullRequest, History, ListPlus, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, SquareCheckBig, SquareX, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { Link } from '../lib/router';
import type { ActivityItem, ActivityKind, AuditVerification, Bootstrap } from '../lib/types';
import { CopyButton, EmptyState, ErrorState, LinkButton, Loading, Select, cx } from '../ui/kit';
import { BrandLogo } from '../ui/brands';

/** Filters people understand, mapped to the kinds the server records. */
const FILTERS: Array<{ id: string; label: string; kinds: ActivityKind[] }> = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'tasks', label: 'Tasks', kinds: ['task', 'state'] },
  { id: 'approvals', label: 'Specs and approvals', kinds: ['spec', 'approval'] },
  { id: 'code', label: 'Code', kinds: ['git', 'pr'] },
  { id: 'copilot', label: 'Copilot', kinds: ['agent'] },
  { id: 'checks', label: 'Checks', kinds: ['checks'] },
  { id: 'config', label: 'Settings', kinds: ['config'] },
];

const RANGES = [
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
] as const;

const KIND: Record<ActivityKind, { icon: LucideIcon; tone: string; label: string }> = {
  task: { icon: ListPlus, tone: 'bg-surface-2 text-fg', label: 'Task' },
  state: { icon: CircleDot, tone: 'bg-surface-2 text-muted', label: 'State' },
  spec: { icon: FileText, tone: 'bg-surface-2 text-fg', label: 'Spec' },
  approval: { icon: BadgeCheck, tone: 'bg-ok-soft text-ok', label: 'Approval' },
  git: { icon: GitCommitHorizontal, tone: 'bg-info-soft text-info', label: 'Commit' },
  pr: { icon: GitPullRequest, tone: 'bg-ok-soft text-ok', label: 'Pull request' },
  agent: { icon: Sparkles, tone: 'bg-info-soft text-info', label: 'Copilot' },
  checks: { icon: SquareCheckBig, tone: 'bg-ok-soft text-ok', label: 'Checks' },
  config: { icon: SlidersHorizontal, tone: 'bg-warn-soft text-warn', label: 'Settings' },
};

const who = (i: ActivityItem) => i.actorName ?? (i.actor === 'agent' ? 'Copilot' : i.actor === 'system' ? 'Tandem' : i.actor === 'pm' ? 'PM' : 'You');

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === '') return <span className="text-faint">—</span>;
  if (typeof v === 'string' && /^https?:\/\//.test(v))
    return (
      <a href={v} target="_blank" rel="noreferrer noopener" className="break-all text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">
        {v}
      </a>
    );
  if (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)) return <span className="font-mono text-[12px]">{v}</span>;
  if (typeof v === 'object') return <code className="block font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-muted">{JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ')}</code>;
  return <span className="break-words">{String(v)}</span>;
}

function Row({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const failed = item.action === 'checks.failed';
  const k = KIND[item.kind];
  const Icon = failed ? SquareX : k.icon;
  const detail = Object.entries(item.detail ?? {});
  return (
    <li className="group relative pl-12">
      <span aria-hidden className={cx('absolute top-2.5 left-0 grid size-8 place-items-center rounded-[10px] ring-4 ring-bg', failed ? 'bg-danger-soft text-danger' : item.kind === 'agent' ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--border)]' : k.tone)}>
        {item.kind === 'agent' ? <BrandLogo brand="copilot" size={16} /> : <Icon className="size-4" strokeWidth={1.9} />}
      </span>
      <div className="rounded-xl px-3 py-2.5 transition-colors group-hover:bg-surface-2/70">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] leading-snug break-words">{item.summary}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-faint">
              <span className="font-medium text-muted">{who(item)}</span>
              <span aria-hidden>·</span>
              <span>{failed ? 'Checks' : k.label}</span>
              {item.taskKey && item.taskId && (
                <>
                  <span aria-hidden>·</span>
                  <Link to={`/tasks/${item.taskId}`} className="font-mono text-[11.5px] text-muted hover:text-fg hover:underline">
                    {item.taskKey}
                  </Link>
                </>
              )}
              {item.seq && (
                <>
                  <span aria-hidden>·</span>
                  <span title={`Audit entry ${item.seq}, hash ${item.hash}`} className="inline-flex items-center gap-1">
                    <ShieldCheck aria-hidden className="size-3" />#{item.seq}
                  </span>
                </>
              )}
            </p>
          </div>
          <time dateTime={item.at} title={new Date(item.at).toLocaleString()} className="shrink-0 pt-px text-[12px] text-faint tabular-nums">
            {time(item.at)}
          </time>
          {detail.length > 0 && (
            <button type="button" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} onClick={() => setOpen(!open)} className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-fg">
              <ChevronRight aria-hidden className={cx('size-3.5 transition-transform duration-200', open && 'rotate-90')} />
            </button>
          )}
        </div>
        {open && (
          <dl className="mt-3 grid animate-in gap-x-6 gap-y-2 rounded-lg bg-surface px-3.5 py-3 text-[12.5px] shadow-[0_0_0_1px_var(--border)] sm:grid-cols-[140px_1fr]">
            {detail.map(([key, v]) => (
              <div key={key} className="contents">
                <dt className="text-faint">{key}</dt>
                <dd className="min-w-0">
                  <Value v={v} />
                </dd>
              </div>
            ))}
            {item.hash && (
              <div className="contents">
                <dt className="text-faint">audit hash</dt>
                <dd className="min-w-0 font-mono text-[11.5px] break-all text-muted">{item.hash}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </li>
  );
}

function Integrity({ v }: { v: AuditVerification }) {
  return (
    <div className={cx('mb-6 flex flex-wrap items-center gap-4 rounded-2xl px-5 py-4 shadow-panel', v.ok ? 'bg-surface' : 'bg-danger-soft')}>
      <span aria-hidden className={cx('grid size-10 shrink-0 place-items-center rounded-xl', v.ok ? 'bg-ok-soft text-ok' : 'bg-danger text-white')}>
        {v.ok ? <ShieldCheck className="size-5" strokeWidth={1.9} /> : <ShieldAlert className="size-5" strokeWidth={1.9} />}
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <p className={cx('text-[14px] font-semibold', !v.ok && 'text-danger')}>{!v.ok ? 'Audit log failed verification' : v.count ? 'Audit log verified' : 'Audit log ready'}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">
          {v.ok && v.count === 0 ? (
            'No entries yet. Changes to settings, approvals, commits and pull requests are sealed here as they happen.'
          ) : v.ok ? (
            <>
              {v.count} {v.count === 1 ? 'entry' : 'entries'}, each sealed with the hash of the one before. Head{' '}
              <span className="font-mono text-[11.5px] text-fg" title={v.head}>
                {v.head.slice(0, 12)}…{v.head.slice(-6)}
              </span>
            </>
          ) : (
            v.reason
          )}
        </p>
      </div>
      {v.ok && v.count > 0 && <CopyButton text={v.head} label="Copy head hash" variant="ghost" />}
    </div>
  );
}

export function ActivityScreen() {
  const [filter, setFilter] = useState('all');
  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('30');
  const [projectId, setProjectId] = useState('');
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const kinds = FILTERS.find((f) => f.id === filter)!.kinds;
  // Rounded to the hour so the query key (and cache) stays stable while the page is open.
  const since = range === 'all' ? '' : new Date(Math.floor((Date.now() - Number(range) * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
  const params = new URLSearchParams({ ...(since ? { since } : {}), ...(kinds.length ? { kinds: kinds.join(',') } : {}), ...(projectId ? { projectId } : {}) });
  const feed = useQuery({ queryKey: ['activity', params.toString()], queryFn: () => api<{ items: ActivityItem[]; more: boolean }>(`/api/activity?${params}`), refetchInterval: 20_000, placeholderData: (p) => p });
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => api<AuditVerification>('/api/audit/verify'), refetchInterval: 60_000 });
  const days = useMemo(() => {
    const out: Array<{ label: string; items: ActivityItem[] }> = [];
    for (const i of feed.data?.items ?? []) {
      const label = dayLabel(i.at);
      if (out.at(-1)?.label === label) out.at(-1)!.items.push(i);
      else out.push({ label, items: [i] });
    }
    return out;
  }, [feed.data]);

  return (
    <div className="mx-auto w-full max-w-[820px]">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] leading-tight">Activity</h1>
          <p className="mt-1 max-w-xl text-[13.5px] text-muted">Every action by people, Copilot and Tandem, newest first. Settings, approvals, commits and pull requests are sealed in a tamper-evident audit log.</p>
        </div>
        <div className="flex items-center gap-2">
          <LinkButton to={`/api/activity?${params}&format=csv`} icon={History} download>
            Export CSV
          </LinkButton>
          <LinkButton to={`/api/activity?${params}&format=json`} variant="ghost" download>
            JSON
          </LinkButton>
        </div>
      </div>
      {verify.data && <Integrity v={verify.data} />}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cx('h-7 rounded-lg px-2.5 text-[12.5px] whitespace-nowrap transition-[background-color,color,box-shadow] duration-150', filter === f.id ? 'bg-surface font-medium text-fg shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.06)]' : 'text-muted hover:text-fg')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {(boot.data?.projects.length ?? 0) > 1 && (
            <div className="w-40">
              <Select label="Project" hideLabel value={projectId} onChange={setProjectId} options={[{ value: '', label: 'All projects' }, ...(boot.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
            </div>
          )}
          <div className="w-40">
            <Select label="Time range" hideLabel value={range} onChange={setRange} options={RANGES} />
          </div>
        </div>
      </div>
      {feed.isLoading ? (
        <Loading rows={6} />
      ) : feed.isError ? (
        <ErrorState error={feed.error} retry={() => void feed.refetch()} />
      ) : days.length === 0 ? (
        <EmptyState icon={History} title="Nothing in this range" body="Try a longer time range or another filter. New activity appears here as it happens." />
      ) : (
        <div className="flex flex-col gap-7">
          {days.map((d) => (
            <section key={d.label} aria-label={d.label}>
              <h2 className="sticky top-0 z-10 -mx-1 mb-2 bg-bg/90 px-1 py-1.5 text-[12.5px] font-semibold text-muted backdrop-blur-sm">{d.label}</h2>
              <ol className="relative flex flex-col gap-0.5 before:absolute before:top-4 before:bottom-4 before:left-[15.5px] before:w-px before:bg-line">
                {d.items.map((i) => (
                  <Row key={i.id} item={i} />
                ))}
              </ol>
            </section>
          ))}
          {feed.data?.more && <p className="text-center text-[12.5px] text-faint">Showing the latest {feed.data.items.length}. Narrow the range or export to see everything.</p>}
        </div>
      )}
    </div>
  );
}
