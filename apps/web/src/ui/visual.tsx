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

/**
 * Page layouts drawn inside a browser frame (24×24 grid, content area x 5–19, y 10–18). "s" is a
 * solid block, "f" a faint one, "l" a text line; they read as a site's silhouette, not a picture.
 */
type Part = ['s' | 'f' | 'l', number, number, number, number];
const LAYOUTS: ReadonlyArray<{ name: string; parts: Part[]; small: Part[] }> = [
  // hero with a call to action
  { name: 'hero', parts: [['s', 5, 10.2, 9, 2.1], ['l', 5, 13.6, 7, 1], ['f', 5, 16.1, 4.2, 1.9], ['f', 15.2, 10.2, 3.8, 7.8]], small: [['s', 5, 10.5, 9, 2.6], ['f', 5, 15, 5, 2.6]] },
  // three cards
  { name: 'cards', parts: [['l', 5, 10.2, 8, 1], ['f', 5, 12.6, 4.2, 5.4], ['f', 9.9, 12.6, 4.2, 5.4], ['s', 14.8, 12.6, 4.2, 5.4]], small: [['f', 5, 10.5, 4, 7.5], ['f', 10, 10.5, 4, 7.5], ['s', 15, 10.5, 4, 7.5]] },
  // sidebar and content
  { name: 'sidebar', parts: [['f', 5, 10.2, 3.6, 7.8], ['s', 10.2, 10.2, 6.5, 1.8], ['l', 10.2, 13.3, 8.8, 1], ['l', 10.2, 15.3, 7.2, 1], ['l', 10.2, 17, 5, 1]], small: [['f', 5, 10.5, 3.8, 7.5], ['s', 10.5, 10.5, 8.5, 2.6], ['f', 10.5, 15, 6, 2.6]] },
  // text beside an image
  { name: 'split', parts: [['s', 5, 10.6, 6, 1.8], ['l', 5, 13.6, 6.5, 1], ['l', 5, 15.5, 5, 1], ['f', 12.6, 10.2, 6.4, 7.8]], small: [['s', 5, 10.5, 6, 2.6], ['f', 12.5, 10.5, 6.5, 7.5]] },
  // gallery
  { name: 'grid', parts: [['s', 5, 10.2, 6.6, 3.6], ['f', 12.4, 10.2, 6.6, 3.6], ['f', 5, 14.4, 6.6, 3.6], ['f', 12.4, 14.4, 6.6, 3.6]], small: [['s', 5, 10.5, 6.5, 3.4], ['f', 12.5, 10.5, 6.5, 3.4], ['f', 5, 14.6, 6.5, 3.4], ['f', 12.5, 14.6, 6.5, 3.4]] },
  // article
  { name: 'article', parts: [['s', 7, 10.2, 10, 1.9], ['l', 6, 13.2, 12, 1], ['l', 6, 15, 12, 1], ['l', 6, 16.8, 8, 1]], small: [['s', 6.5, 10.5, 11, 2.6], ['f', 6.5, 15, 11, 2.6]] },
  // dashboard
  { name: 'dashboard', parts: [['f', 5, 10.2, 4.3, 2.6], ['f', 9.9, 10.2, 4.3, 2.6], ['s', 14.7, 10.2, 4.3, 2.6], ['f', 5, 13.6, 14, 4.4]], small: [['s', 5, 10.5, 6.5, 2.8], ['f', 12.5, 10.5, 6.5, 2.8], ['f', 5, 14.6, 14, 3.4]] },
  // store
  { name: 'store', parts: [['f', 5, 10.2, 4.2, 4.2], ['f', 9.9, 10.2, 4.2, 4.2], ['f', 14.8, 10.2, 4.2, 4.2], ['l', 5, 15.6, 3, 1], ['l', 9.9, 15.6, 3, 1], ['s', 14.8, 15.4, 4.2, 1.6]], small: [['f', 5, 10.5, 4, 4.4], ['f', 10, 10.5, 4, 4.4], ['s', 15, 10.5, 4, 4.4], ['f', 5, 16, 14, 2]] },
];

/** FNV-1a: a stable number from a name, so a project keeps its look everywhere. */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}

/**
 * A project's avatar: a small website silhouette (a browser frame around a page layout picked from
 * the name), in ink on a neutral tile, so it follows the theme and never competes with content.
 * Decorative: the name is always next to it.
 */
export function ProjectAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const layout = LAYOUTS[hashName(name) % LAYOUTS.length]!;
  const small = size < 26;
  const parts = small ? layout.small : layout.parts;
  // The tile is the browser window: chrome across the top, the page layout below it.
  return (
    <span
      aria-hidden
      data-layout={layout.name}
      className="relative block shrink-0 overflow-hidden bg-surface text-fg"
      style={{ width: size, height: size, borderRadius: Math.max(5, Math.round(size * 0.24)), boxShadow: '0 0 0 1px var(--border-strong), 0 1px 2px rgb(0 0 0 / 0.06), inset 0 1px 0 var(--hairline-highlight)' }}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} className="block">
        <rect x="0" y="0" width="24" height={small ? 6.2 : 6.6} fill="currentColor" fillOpacity="0.06" />
        <path d={small ? 'M0 6.2h24' : 'M0 6.6h24'} stroke="currentColor" strokeOpacity="0.16" strokeWidth={small ? 1 : 0.6} />
        {!small && (
          <g fill="currentColor" fillOpacity="0.45">
            <circle cx="3.6" cy="3.3" r="0.85" />
            <circle cx="6.1" cy="3.3" r="0.85" />
            <circle cx="8.6" cy="3.3" r="0.85" />
          </g>
        )}
        <g transform={small ? 'translate(4 8.6) scale(1.143 1.43) translate(-5 -10)' : 'translate(4 9.4) scale(1.143 1.3) translate(-5 -10)'}>
          {parts.map(([k, x, y, w, h], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} rx={k === 'l' ? h / 2 : Math.min(0.8, h / 2)} fill="currentColor" fillOpacity={k === 's' ? 0.82 : k === 'f' ? 0.16 : 0.32} />
          ))}
        </g>
      </svg>
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
