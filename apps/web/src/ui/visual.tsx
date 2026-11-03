import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { TaskState } from '@tandem/shared';
import { cx } from './kit';

/**
 * Small visual pieces shared by the list and settings pages: status icons that read at a glance,
 * progress rings, project monograms, icon tiles and language dots. Colours come from the theme
 * tokens, so they work in light and dark.
 */

/** How far along a task is (0–1), for the status icon's fill. */
const PROGRESS: Partial<Record<TaskState, number>> = { READINESS: 0.15, SPEC_DRAFTING: 0.3, SPEC_REVIEW: 0.45, BUILDING: 0.6, VERIFYING: 0.72, SELF_REVIEW: 0.85 };

/** A Linear-style status icon: dashed for drafts, a filling pie while work goes on, a check when done. */
export function StatusIcon({ state, className }: { state: TaskState; className?: string }) {
  const base = cx('size-4 shrink-0', className);
  if (state === 'DRAFT')
    return (
      <svg viewBox="0 0 16 16" className={cx(base, 'text-faint')} aria-hidden>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2.2" />
      </svg>
    );
  if (state === 'DONE' || state === 'PR_OPEN')
    return (
      <svg viewBox="0 0 16 16" className={cx(base, 'text-ok')} aria-hidden>
        {state === 'DONE' ? (
          <>
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path d="M5 8.2 7 10.2 11 6" fill="none" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8" cy="8" r="3.25" fill="currentColor" />
          </>
        )}
      </svg>
    );
  if (state === 'CANCELLED')
    return (
      <svg viewBox="0 0 16 16" className={cx(base, 'text-faint')} aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.35" />
        <path d="M5.8 5.8 10.2 10.2M10.2 5.8 5.8 10.2" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  if (state === 'BLOCKED' || state === 'FAILED')
    return (
      <svg viewBox="0 0 16 16" className={cx(base, state === 'FAILED' ? 'text-danger' : 'text-warn')} aria-hidden>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 4.6v4.2" stroke="var(--surface)" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="8" cy="11.1" r="1" fill="var(--surface)" />
      </svg>
    );
  // In progress: a ring with a pie that fills as the task moves through its steps.
  const p = PROGRESS[state] ?? 0.5;
  const c = 2 * Math.PI * 2.5;
  return (
    <svg viewBox="0 0 16 16" className={cx(base, state === 'SPEC_REVIEW' ? 'text-warn' : 'text-fg')} aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" strokeWidth="5" strokeDasharray={`${p * c} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

/** A circular progress ring with content in the middle. */
export function Ring({ value, size = 64, stroke = 6, tone = 'fg', children, label }: { value: number; size?: number; stroke?: number; tone?: 'fg' | 'ok' | 'warn' | 'danger'; children?: ReactNode; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  const color = { fg: 'text-fg', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' }[tone];
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} {...(label ? { role: 'img', 'aria-label': label } : {})}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap={v > 0 ? 'round' : 'butt'} opacity={v > 0 ? 1 : 0} strokeDasharray={`${v * c} ${c}`} className={cx(color, 'transition-[stroke-dasharray] duration-700 ease-out')} />
      </svg>
      {children && <div className="absolute inset-0 grid place-items-center">{children}</div>}
    </div>
  );
}

/** A rounded tile with an icon, for section headings and summary tiles. */
export function IconTile({ icon: Icon, tone = 'neutral', size = 'md' }: { icon: LucideIcon; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; size?: 'sm' | 'md' | 'lg' }) {
  const tones = { neutral: 'bg-surface-3/70 text-fg', ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', danger: 'bg-danger-soft text-danger', accent: 'bg-accent text-accent-fg' };
  const sizes = { sm: 'size-7 rounded-lg [&_svg]:size-3.5', md: 'size-8 rounded-[10px] [&_svg]:size-4', lg: 'size-10 rounded-xl [&_svg]:size-5' };
  return (
    <span aria-hidden className={cx('grid shrink-0 place-items-center', tones[tone], sizes[size])}>
      <Icon strokeWidth={1.9} />
    </span>
  );
}

/** A monogram for a project: its initials on a soft gradient picked from its name. */
export function Monogram({ name, size = 40 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const initials =
    name
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-xl font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]"
      style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(140deg, hsl(${h} 42% 58%), hsl(${(h + 36) % 360} 46% 40%))` }}
    >
      {initials}
    </span>
  );
}

const LANG: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#e3c541',
  python: '#3572a5',
  go: '#00add8',
  java: '#b07219',
  kotlin: '#a97bff',
  'c#': '#178600',
  csharp: '#178600',
  rust: '#dea584',
  ruby: '#701516',
  php: '#4f5d95',
  swift: '#f05138',
};

/** A GitHub-style language dot. */
export function LangDot({ language }: { language?: string | undefined }) {
  const color = LANG[(language ?? '').toLowerCase()] ?? 'var(--text-faint)';
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}
