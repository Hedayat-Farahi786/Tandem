import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Copy, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import { renderMarkdown } from '../lib/markdown';
import { Link } from '../lib/router';
import type { Tone } from '../lib/format';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/* ================================================================== buttons */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.18),0_0_0_1px_var(--accent)] hover:bg-accent-hover active:scale-[0.98] disabled:shadow-none',
  secondary: 'bg-surface text-fg shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_rgb(0_0_0/0.05)] hover:bg-surface-2 active:scale-[0.98]',
  subtle: 'bg-surface-2 text-fg hover:bg-surface-3',
  ghost: 'bg-transparent text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-surface text-danger shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_rgb(0_0_0/0.05)] hover:bg-danger-soft active:scale-[0.98]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
  icon?: LucideIcon;
}

/** Button styling, also for links that look like buttons (never nest a button in a link). */
export function buttonClass(variant: Variant = 'secondary', size: 'sm' | 'md' | 'lg' = 'md', className?: string) {
  return cx(
    'inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-[9px] font-medium whitespace-nowrap transition-[background-color,box-shadow,color,transform] duration-150 ease-out disabled:pointer-events-none disabled:opacity-45',
    size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-11 px-5 text-[15px]' : 'h-9 px-3.5 text-[13.5px]',
    VARIANT[variant],
    className,
  );
}

/** A link styled as a button: in-app routes use the router, other URLs open in a new tab. */
export function LinkButton({ to, variant = 'secondary', size = 'md', icon: Icon, className, children, external, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: LucideIcon; external?: boolean }) {
  const content = (
    <>
      {Icon && <Icon aria-hidden className={size === 'sm' ? 'size-3.5' : 'size-4'} strokeWidth={2} />}
      {children}
    </>
  );
  if (external || /^[a-z]+:/i.test(to) || to.startsWith('/api/'))
    return (
      <a href={to} {...(external || /^[a-z]+:/i.test(to) ? { target: '_blank', rel: 'noreferrer noopener' } : {})} {...rest} className={buttonClass(variant, size, className)}>
        {content}
      </a>
    );
  return (
    <Link to={to} {...rest} className={buttonClass(variant, size, className)}>
      {content}
    </Link>
  );
}

export function Button({ variant = 'secondary', size = 'md', busy, icon: Icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} disabled={disabled || busy} aria-busy={busy || undefined} className={buttonClass(variant, size, className)}>
      {busy ? <Spinner /> : Icon ? <Icon aria-hidden className={size === 'sm' ? 'size-3.5' : 'size-4'} strokeWidth={2} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, size = 'md', variant = 'ghost', className, ...rest }: Omit<ButtonProps, 'icon' | 'children'> & { icon: LucideIcon; label: string }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        {...rest}
        className={cx('inline-flex items-center justify-center rounded-[10px] transition-colors disabled:pointer-events-none disabled:opacity-45', size === 'sm' ? 'size-8' : 'size-9', VARIANT[variant], className)}
      >
        <Icon aria-hidden className="size-4" strokeWidth={2} />
      </button>
    </Tooltip>
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return <span role={label ? 'status' : undefined} aria-label={label} className={cx('inline-block size-4 animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-70', className)} />;
}

/* ================================================================== tooltip */

export function Tooltip({ label, children, side = 'top' }: { label: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cx(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-[11px] font-medium text-bg opacity-0 shadow-md transition-opacity delay-300 duration-100 group-hover/tt:opacity-100 group-focus-within/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {label}
      </span>
    </span>
  );
}

/* ================================================================== fields */

export const controlBase =
  'w-full rounded-[9px] border border-line-strong bg-surface text-[13.5px] text-fg shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] duration-150 hover:border-faint/70 focus:border-fg/60 focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)] focus-visible:outline-none aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-2 disabled:text-muted disabled:shadow-none';

export function Field({ label, help, error, children, htmlFor, optional, hideLabel }: { label?: string; help?: ReactNode; error?: string | undefined; children: ReactNode; htmlFor: string; optional?: boolean; hideLabel?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className={cx('flex items-baseline justify-between gap-2', hideLabel && 'sr-only')}>
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
            {label}
          </label>
          {optional && <span className="text-[12px] text-faint">Optional</span>}
        </div>
      )}
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="flex items-center gap-1.5 text-[13px] text-danger">
          <XCircle aria-hidden className="size-3.5" />
          {error}
        </p>
      ) : help ? (
        <p id={`${htmlFor}-help`} className="text-[13px] leading-snug text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

type FieldProps = { label?: string; help?: ReactNode; error?: string | undefined; optional?: boolean };

export function Input({ id, label, help, error, optional, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} help={help} error={error} htmlFor={fid} optional={optional}>
      <input id={fid} aria-invalid={error ? true : undefined} aria-describedby={error ? `${fid}-error` : help ? `${fid}-help` : undefined} className={cx(controlBase, 'h-9 px-3', className)} {...rest} />
    </Field>
  );
}

export function Textarea({ id, label, help, error, optional, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} help={help} error={error} htmlFor={fid} optional={optional}>
      <textarea id={fid} aria-invalid={error ? true : undefined} aria-describedby={error ? `${fid}-error` : help ? `${fid}-help` : undefined} className={cx(controlBase, 'min-h-24 resize-y px-3 py-2 leading-relaxed', className)} {...rest} />
    </Field>
  );
}

/* ------------------------------------------------------------------ select (custom listbox) */

export interface Option<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** A fully custom, keyboard-accessible select (listbox pattern). */
export function Select<T extends string>({ id, label, hideLabel, help, value, onChange, options, placeholder = 'Choose…', className, disabled }: FieldProps & { id?: string; hideLabel?: boolean; value: T; onChange: (v: T) => void; options: ReadonlyArray<Option<T>>; placeholder?: string; className?: string; disabled?: boolean }) {
  const auto = useId();
  const fid = id ?? auto;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    button.current?.focus();
  };
  const move = (delta: number) => {
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + delta + options.length) % options.length;
      if (!options[i]?.disabled) break;
    }
    setActive(i);
  };

  return (
    <Field label={label} help={help} htmlFor={fid} {...(hideLabel ? { hideLabel } : {})}>
      <div ref={root} className={cx('relative', className)}>
        <button
          ref={button}
          id={fid}
          type="button"
          role="combobox"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${fid}-list`}
          aria-activedescendant={open ? `${fid}-opt-${active}` : undefined}
          aria-describedby={help ? `${fid}-help` : undefined}
          onClick={() => {
            setActive(Math.max(0, options.findIndex((o) => o.value === value)));
            setOpen(!open);
          }}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              setOpen(true);
              return;
            }
            if (!open) return;
            const keys: Record<string, () => void> = {
              ArrowDown: () => move(1),
              ArrowUp: () => move(-1),
              Home: () => setActive(0),
              End: () => setActive(options.length - 1),
              Enter: () => choose(active),
              ' ': () => choose(active),
            };
            const act = keys[e.key];
            if (act) {
              e.preventDefault();
              act();
            } else if (e.key === 'Escape') {
              // Close the list only, not a dialog around it.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === 'Tab') setOpen(false);
            else if (e.key.length === 1) {
              const now = Date.now();
              typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
              const i = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
              if (i >= 0) setActive(i);
            }
          }}
          className={cx(controlBase, 'flex h-9 items-center justify-between gap-2 px-3 text-left disabled:opacity-50')}
        >
          <span className={cx('truncate', !current && 'text-faint')}>{current?.label ?? placeholder}</span>
          <ChevronDown aria-hidden className={cx('size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <ul
            id={`${fid}-list`}
            role="listbox"
            aria-label={label ?? placeholder}
            tabIndex={-1}
            className="absolute z-40 mt-1.5 max-h-72 w-full min-w-44 animate-pop overflow-auto rounded-xl border border-line bg-surface p-1 shadow-lg"
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${fid}-opt-${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={cx('flex cursor-default items-start gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px]', i === active && 'bg-surface-2', o.disabled && 'opacity-45')}
              >
                <Check aria-hidden className={cx('mt-0.5 size-4 shrink-0 text-accent', o.value !== value && 'invisible')} />
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.description && <span className="block text-[12px] leading-snug text-muted">{o.description}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------------ checkbox, switch, radio cards */

export function Checkbox({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('group flex cursor-pointer items-start gap-3 rounded-lg py-1', disabled && 'cursor-not-allowed opacity-50')}>
      <span className="relative mt-0.5 inline-flex">
        <input id={id} type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span
          aria-hidden
          className="grid size-[18px] place-items-center rounded-[5px] border border-line-strong bg-surface shadow-sm transition-colors group-hover:border-faint peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)]"
        >
          <Check className={cx('size-3 text-accent-fg transition-opacity', checked ? 'opacity-100' : 'opacity-0')} strokeWidth={3} />
        </span>
      </span>
      <span className="min-w-0 text-[13.5px]">
        <span className="text-fg">{label}</span>
        {description && <span className="block text-[13px] text-muted">{description}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label, description, hideLabel }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; hideLabel?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <span className={cx(hideLabel && 'sr-only')}>
        <label htmlFor={id} className="text-[13.5px] font-medium">
          {label}
        </label>
        {description && <span className="block text-[13px] text-muted">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={cx('inline-block size-[18px] rounded-full shadow-sm transition-transform duration-200 ease-out', checked ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-0.5 bg-white')} />
      </button>
    </div>
  );
}

export function RadioCards<T extends string>({ label, value, onChange, options, columns = 1 }: { label: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<Option<T>>; columns?: 1 | 2 | 3 }) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
      <div className={cx('grid gap-2', columns === 2 && 'md:grid-cols-2', columns === 3 && 'md:grid-cols-3')}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <label key={o.value} className={cx('relative flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors', selected ? 'border-accent bg-accent-soft/60' : 'border-line bg-surface hover:border-line-strong', o.disabled && 'cursor-not-allowed opacity-50')}>
              <input type="radio" name={name} value={o.value} checked={selected} disabled={o.disabled} onChange={() => onChange(o.value)} className="peer sr-only" />
              <span aria-hidden className={cx('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors peer-focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)]', selected ? 'border-accent' : 'border-line-strong')}>
                <span className={cx('size-2 rounded-full bg-accent transition-transform', selected ? 'scale-100' : 'scale-0')} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium">{o.label}</span>
                {o.description && <span className="block text-[13px] leading-snug text-muted">{o.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/* ================================================================== display */

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent-text',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
};
const DOT: Record<Tone, string> = { neutral: 'bg-faint', accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' };

export function Pill({ tone = 'neutral', children, className, dot, pulse }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean; pulse?: boolean }) {
  return (
    <span className={cx('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium', TONE[tone], className)}>
      {dot && <StatusDot tone={tone} pulse={pulse ?? false} />}
      {children}
    </span>
  );
}

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-1.5">
      {pulse && <span className={cx('absolute inline-flex size-full animate-ping rounded-full opacity-60', DOT[tone])} />}
      <span className={cx('relative inline-flex size-1.5 rounded-full', DOT[tone])} />
    </span>
  );
}

/**
 * Settings-style layout: a titled section of rows separated by hairlines, no boxes. Used by
 * Settings, Doctor and Projects.
 */
export function SettingsSection({ id: anchor, icon, title, description, actions, children, className }: { id?: string; icon?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section id={anchor} aria-labelledby={id} className={cx('scroll-mt-8', className)}>
      <div className="flex items-center justify-between gap-4 px-1 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          {icon}
          <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="divide-y divide-line rounded-2xl bg-surface px-5 shadow-panel">{children}</div>
    </section>
  );
}

/** One setting: its name and a short explanation on the left, the control on the right. */
export function Row({ label, htmlFor, description, children, wide }: { label: ReactNode; htmlFor?: string; description?: ReactNode; children?: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('grid gap-x-8 gap-y-2.5 py-4', children ? (wide ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]') : '')}>
      <div className="min-w-0 sm:self-center">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13.5px] font-medium">
            {label}
          </label>
        ) : (
          <p className="text-[13.5px] font-medium">{label}</p>
        )}
        {description && <p className="mt-0.5 text-[13px] leading-snug text-muted">{description}</p>}
      </div>
      {children && <div className="min-w-0 sm:justify-self-end sm:self-center sm:w-full">{children}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-2xl bg-surface shadow-panel', className)}>
      {(title || actions) && (
        <header className={cx('flex items-start justify-between gap-4 px-5 pt-4', padded ? 'pb-0' : 'pb-3')}>
          <div className="min-w-0">
            {typeof title === 'string' ? <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2> : title}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? (title || actions ? 'px-5 pt-3 pb-5' : 'p-5') : ''}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: { icon?: LucideIcon; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl bg-surface px-6 py-16 text-center shadow-panel">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(ellipse_at_top,var(--surface-3),transparent_70%)] opacity-70" />
      {Icon && (
        <span className="relative mb-2 grid size-12 place-items-center rounded-2xl bg-surface text-fg shadow-[0_0_0_1px_var(--border),0_6px_16px_-6px_rgb(0_0_0/0.18),inset_0_1px_0_var(--hairline-highlight)]">
          <Icon aria-hidden className="size-5" strokeWidth={1.8} />
        </span>
      )}
      <p className="relative font-display text-[17px]">{title}</p>
      {body && <p className="relative max-w-md text-[13px] text-muted">{body}</p>}
      {action && <div className="relative mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, retry }: { title?: string; error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3">
      <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[13.5px] font-semibold text-danger">{title}</p>
        <p className="text-[13px] break-words text-fg">{error instanceof Error ? error.message : String(error)}</p>
        {retry && (
          <div className="mt-1">
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Loading({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-xl bg-surface-2" style={{ width: `${100 - i * 14}%` }} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={cx('prose-tandem', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

const CALLOUT_ICON: Record<Tone, LucideIcon> = { neutral: Info, accent: Info, ok: CheckCircle2, warn: AlertTriangle, danger: XCircle };

export function Callout({ tone = 'neutral', title, children, actions }: { tone?: Tone; title?: string; children?: ReactNode; actions?: ReactNode }) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div className={cx('flex gap-3 rounded-xl px-4 py-3', TONE[tone].split(' ')[0])}>
      <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', TONE[tone].split(' ')[1])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <p className={cx('text-[13.5px] font-semibold', TONE[tone].split(' ')[1])}>{title}</p>}
        {children && <div className="text-[13px] leading-relaxed whitespace-pre-line text-fg">{children}</div>}
        {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line-strong bg-surface px-1 font-sans text-[11px] text-muted shadow-sm">{children}</kbd>;
}

export function Avatar({ name, tone = 'neutral' }: { name: string; tone?: Tone }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span aria-hidden className={cx('grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold', TONE[tone])}>
      {initials || '·'}
    </span>
  );
}

/* ================================================================== tabs */

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string; badge?: ReactNode }>; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={label} className="flex gap-6 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
            onChange(tabs[n]!.id);
            refs.current[n]?.focus();
          }}
          className={cx('relative flex h-10 shrink-0 items-center gap-2 text-[13.5px] transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:rounded-full after:transition-colors', value === t.id ? 'font-medium text-fg after:bg-fg' : 'text-muted after:bg-transparent hover:text-fg hover:after:bg-line-strong')}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0} className="animate-in pt-6 focus-visible:outline-none">
      {children}
    </div>
  );
}

/* ================================================================== dialog */

export function Dialog({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: string; description?: string; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      // Start on the first field; with none, on the first footer button (the safe choice, like "Keep working").
      const field = d.querySelector<HTMLElement>('[data-dialog-body] :is(input:not([type=hidden]), textarea, [role=combobox]):not([disabled])');
      (field ?? d.querySelector<HTMLElement>('footer button:not([disabled])'))?.focus();
    }
    if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === ref.current && onClose()}
      className={cx('m-auto max-h-[calc(100vh-48px)] animate-pop rounded-2xl border-0 bg-surface p-0 text-fg shadow-lg backdrop:bg-[rgb(10_10_12/0.4)] backdrop:backdrop-blur-[3px]', wide ? 'w-[min(880px,calc(100vw-32px))]' : 'w-[min(560px,calc(100vw-32px))]')}
    >
      {open && (
        <div className="flex max-h-[calc(100vh-48px)] flex-col">
          <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
            <div>
              <h2 id={titleId} className="font-display text-[17px]">
                {title}
              </h2>
              {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
            </div>
            <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
          </header>
          {children ? (
            <div data-dialog-body className="flex flex-col gap-4 overflow-y-auto px-6 pb-5">
              {children}
            </div>
          ) : (
            <div className="pb-2" />
          )}
          {footer && <footer className="flex justify-end gap-2 border-t border-line bg-surface-2/50 px-6 py-3.5">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/* ================================================================== toasts */

interface Toast {
  id: number;
  tone: Tone;
  text: string;
}
const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Tone = 'neutral') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'danger' || tone === 'warn' ? 7_000 : 3_500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-[min(380px,calc(100vw-40px))] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = CALLOUT_ICON[t.tone];
          return (
            <div key={t.id} role={t.tone === 'danger' ? 'alert' : 'status'} className="pointer-events-auto flex animate-pop items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[13px] shadow-lg">
              <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', TONE[t.tone].split(' ')[1])} />
              <span className="min-w-0 flex-1">{t.text}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-faint hover:text-fg">
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ================================================================== misc */

export function CopyButton({ text, label = 'Copy', copied = 'Copied', size = 'sm', variant = 'secondary' }: { text: string | (() => Promise<string>); label?: string; copied?: string; size?: 'sm' | 'md'; variant?: Variant }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <Button
      size={size}
      variant={variant}
      icon={done ? Check : Copy}
      onClick={async () => {
        try {
          const value = typeof text === 'string' ? text : await text();
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 2_000);
        } catch (err) {
          toast(`Could not copy: ${err instanceof Error ? err.message : String(err)}`, 'danger');
        }
      }}
    >
      {done ? copied : label}
    </Button>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 flex items-center gap-2 text-[13px] text-muted">{eyebrow}</div>}
        <h1 className="font-display text-[26px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-[14px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[13px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] text-faint">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
