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

/** Curated, muted pairs (light → deep): calm next to the neutral UI, distinct from each other. */
const AVATAR_PALETTES: ReadonlyArray<readonly [string, string]> = [
  ['#7d95d6', '#34509c'], // ink
  ['#8fb49b', '#3f6b53'], // sage
  ['#dd9f80', '#a4533a'], // clay
  ['#b394c6', '#68427c'], // plum
  ['#dbb671', '#956624'], // ochre
  ['#79b8b9', '#276c70'], // teal
  ['#9a9ca5', '#3d3f46'], // graphite
  ['#d993a6', '#96445d'], // rose
];

/** Simple geometric marks on a 24×24 grid, drawn in white. */
const AVATAR_GLYPHS: ReadonlyArray<ReactNode> = [
  // orbit
  <>
    <circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none" />
    <ellipse cx="12" cy="12" rx="9" ry="4.4" transform="rotate(-28 12 12)" />
  </>,
  // layers
  <>
    <path d="M12 4.2 20 8.6l-8 4.4-8-4.4Z" fill="currentColor" stroke="none" />
    <path d="m4 12.6 8 4.4 8-4.4M4 16.4l8 4.4 8-4.4" />
  </>,
  // stack
  <path d="M6 7h12M6 12h8.5M6 17h4.5" />,
  // diamond
  <>
    <path d="M12 3.8 20.2 12 12 20.2 3.8 12Z" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none" />
  </>,
  // grid
  <>
    <rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1.8" fill="currentColor" />
    <rect x="13" y="4.5" width="6.5" height="6.5" rx="1.8" />
    <rect x="4.5" y="13" width="6.5" height="6.5" rx="1.8" />
    <rect x="13" y="13" width="6.5" height="6.5" rx="1.8" />
  </>,
  // waves
  <path d="M3.5 9.5c2.8-3.4 5.7 3.4 8.5 0s5.7 3.4 8.5 0M3.5 15.5c2.8-3.4 5.7 3.4 8.5 0s5.7 3.4 8.5 0" />,
  // spark
  <path d="M12 3.5c.7 4.6 3.4 7.8 8.5 8.5-5.1.7-7.8 3.9-8.5 8.5-.7-4.6-3.4-7.8-8.5-8.5 5.1-.7 7.8-3.9 8.5-8.5Z" fill="currentColor" stroke="none" />,
  // overlap
  <>
    <circle cx="9.2" cy="12" r="5.4" />
    <circle cx="14.8" cy="12" r="5.4" />
  </>,
  // hexagon
  <>
    <path d="M12 3.6 19.3 7.8v8.4L12 20.4l-7.3-4.2V7.8Z" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </>,
  // peaks
  <path d="M3.5 18 9 9.5l3.6 5.4 2.6-3.6 5.3 6.7Z" />,
];

/** FNV-1a: a stable number from a name, so a project keeps its look everywhere. */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}

/**
 * A project's avatar: a softly lit gradient tile with a geometric mark, both picked from the name
 * (like Linear's and Vercel's generated avatars). Decorative: the name is always next to it.
 */
export function ProjectAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const h = hashName(name);
  const [light, deep] = AVATAR_PALETTES[h % AVATAR_PALETTES.length]!;
  const glyph = AVATAR_GLYPHS[(h >>> 8) % AVATAR_GLYPHS.length];
  const small = size < 26;
  return (
    <span
      aria-hidden
      className="relative grid shrink-0 place-items-center overflow-hidden text-white"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * (small ? 0.3 : 0.28)),
        background: `radial-gradient(120% 90% at 18% 8%, rgb(255 255 255 / 0.22), transparent 55%), linear-gradient(155deg, ${light}, ${deep})`,
        boxShadow: small ? 'inset 0 0 0 0.5px rgb(255 255 255 / 0.18), 0 0 0 0.5px rgb(0 0 0 / 0.12)' : 'inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 -1px 0 rgb(0 0 0 / 0.12), 0 0 0 0.5px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.12)',
      }}
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * (small ? 0.66 : 0.56))} height={Math.round(size * (small ? 0.66 : 0.56))} fill="none" stroke="currentColor" strokeWidth={small ? 2.6 : size < 36 ? 2.1 : 1.8} strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-[0_1px_1px_rgb(0_0_0/0.18)]">
        {glyph}
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
