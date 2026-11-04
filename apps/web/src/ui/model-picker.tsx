import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, RotateCw } from 'lucide-react';
import { api } from '../lib/api';
import { useRouter } from '../lib/router';
import type { ModelCatalog, ModelChoice } from '../lib/types';
import { Spinner, controlBase, cx } from './kit';
import { BrandLogo, providerOf, type Brand } from './brands';

export function useModels(enabled = true) {
  return useQuery({ queryKey: ['models'], queryFn: () => api<ModelCatalog>('/api/copilot/models'), staleTime: 5 * 60_000, retry: false, enabled });
}

const trimNum = (n: number) => String(Math.round(n * 10) / 10);
export const formatTokens = (n: number) => (n >= 1_000_000 ? `${trimNum(n / 1_000_000)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));
export const formatCredits = (n: number) => (n > 0 && n < 0.1 ? '< 0.1' : n < 10 ? trimNum(n) : String(Math.round(n)));

/** The name to show for a model id ('' = Auto). */
export function modelLabel(catalog: ModelCatalog | undefined, id: string): string {
  if (!id) return 'Auto';
  return catalog?.models.find((m) => m.id === id)?.name ?? id;
}

type Item = { kind: 'auto' } | { kind: 'model'; m: ModelChoice };
const itemId = (i: Item) => (i.kind === 'auto' ? '' : i.m.id);

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-lg bg-surface px-2.5 py-1.5 ring-1 ring-line">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="text-[14px] font-medium tabular-nums">{value === undefined ? '–' : value}</p>
    </div>
  );
}

function Details({ item, catalog }: { item: Item; catalog: ModelCatalog }) {
  if (item.kind === 'auto') {
    const light = modelLabel(catalog, catalog.auto.light ?? '');
    const build = catalog.auto.build ? modelLabel(catalog, catalog.auto.build) : null;
    return (
      <div className="text-[13px] leading-relaxed text-muted">
        <p className="mb-1 text-[13px] font-medium text-fg">Auto</p>
        Tandem picks per step: <span className="text-fg">{catalog.auto.light ? light : 'the cheapest model'}</span> for chat, specs and reviews, and <span className="text-fg">{build ?? "Copilot's own choice"}</span> for writing code. Change these defaults in Settings.
      </div>
    );
  }
  const m = item.m;
  const over = m.estimate !== undefined && m.estimate > catalog.credits.perTask;
  const reasoning = m.reasoning.length ? (m.reasoning.length > 1 ? `${m.reasoning[0]}–${m.reasoning[m.reasoning.length - 1]}` : m.reasoning[0]) : null;
  const chips = [m.contextWindow ? `${formatTokens(m.contextWindow)} context` : null, m.maxOutput ? `${formatTokens(m.maxOutput)} output` : null, m.vision ? 'Images' : null, reasoning ? `Reasoning ${reasoning}` : null].filter((c): c is string => Boolean(c));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          {providerOf(m) && <BrandLogo brand={providerOf(m)!} size={15} />}
          <span className="truncate">{m.name}</span>
        </p>
        <p className="shrink-0 text-[12px] text-faint">{m.vendor}</p>
      </div>
      {m.price ? (
        <>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Stat label="Input" value={m.price.input} />
            <Stat label="Cached input" value={m.price.cachedInput} />
            <Stat label="Output" value={m.price.output} />
          </div>
          <p className="mt-1 text-[11px] text-faint">AI credits per million tokens</p>
        </>
      ) : m.multiplier !== undefined ? (
        <p className="mt-2 text-[13px] text-muted">{m.multiplier}× premium requests per prompt</p>
      ) : (
        <p className="mt-2 text-[13px] text-muted">Copilot publishes no price for this model.</p>
      )}
      {chips.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c} className="rounded-md bg-surface px-1.5 py-0.5 text-[12px] text-muted ring-1 ring-line">
              {c}
            </span>
          ))}
        </div>
      )}
      {m.estimate !== undefined && (
        <p className={cx('mt-2.5 flex items-start gap-1.5 text-[13px]', over ? 'text-warn' : 'text-muted')}>
          {over && <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
          <span>
            About <span className="font-medium tabular-nums">{formatCredits(m.estimate)}</span> credits for a typical task.
            {over && ` That is above the ${catalog.credits.perTask}-credit task limit, so a task may stop and wait for you.`}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Picks the Copilot model for a chat or task. A combobox with a listbox (APG select-only pattern):
 * models grouped by vendor with an estimate per task, and details of the highlighted model.
 */
export function ModelPicker({ value, onChange, disabled, busy, placement = 'top', align = 'end', variant = 'composer', className }: { value: string; onChange: (id: string) => void; disabled?: boolean; busy?: boolean; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; variant?: 'composer' | 'field'; className?: string }) {
  const uid = useId();
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  // Opens toward the side with room and fits to it. Details sit beside the list (stacked below on narrow
  // screens) in a fixed-size panel, so hovering models never resizes the popover.
  // Placed on the page itself (not inside the scrolling column), so the sidebar or the column's edge
  // never cuts it off: anchored to the button, kept inside the window.
  const [fit, setFit] = useState<{ side: 'top' | 'bottom'; list: number; pos?: { left: number; width: number; top?: number; bottom?: number } }>({ side: placement, list: 300 });
  const panel = useRef<HTMLDivElement>(null);
  const catalog = useModels(open || Boolean(value));
  const items = useMemo<Item[]>(() => [{ kind: 'auto' }, ...(catalog.data?.models ?? []).map((m): Item => ({ kind: 'model', m }))], [catalog.data]);
  const selectedIndex = Math.max(0, items.findIndex((i) => itemId(i) === value));
  const [active, setActive] = useState(selectedIndex);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const optId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node) && setOpen(false);
    // The page scrolling under it (not the list itself) or a resize would leave it floating: close.
    const away = (e: Event) => !panel.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const room = { top: r.top - 16, bottom: window.innerHeight - r.bottom - 16 };
    const other = placement === 'top' ? 'bottom' : 'top';
    const side = room[placement] >= 480 || room[placement] >= room[other] ? placement : other;
    const stacked = window.innerWidth < 640;
    // Narrow screens: a sheet along the bottom edge, so it never runs off the side.
    const width = Math.min(640, window.innerWidth - 16);
    const left = Math.min(Math.max(8, align === 'end' ? r.right - width : r.left), window.innerWidth - width - 8);
    setFit({
      side,
      list: stacked ? Math.max(160, Math.min(280, window.innerHeight - 420)) : Math.max(160, Math.min(400, room[side] - 90)),
      ...(stacked ? {} : { pos: { left, width, ...(side === 'top' ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 }) } }),
    });
  }, [open, placement, align]);
  useEffect(() => {
    if (open) setActive(selectedIndex);
    // Only when opening or when the list arrives.
  }, [open, items.length]);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView.
    if (open) void document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    setOpen(false);
    button.current?.focus();
    if (itemId(item) !== value) onChange(itemId(item));
  };
  const label = modelLabel(catalog.data, value);
  const groups = useMemo(() => {
    const out: Array<{ vendor: string; entries: Array<{ m: ModelChoice; index: number }> }> = [];
    items.forEach((item, index) => {
      if (item.kind !== 'model') return;
      const last = out[out.length - 1];
      if (last?.vendor === item.m.vendor) last.entries.push({ m: item.m, index });
      else out.push({ vendor: item.m.vendor, entries: [{ m: item.m, index }] });
    });
    return out;
  }, [items]);
  const perTask = catalog.data?.credits.perTask ?? Infinity;

  const option = (index: number, name: string, right: ReactNode, sub?: string, brand?: Brand) => {
    const selected = index === selectedIndex;
    return (
      <div
        key={index}
        id={optId(index)}
        role="option"
        aria-selected={selected}
        onMouseEnter={() => setActive(index)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => choose(index)}
        className={cx('flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-100', index === active && 'bg-surface-2')}
      >
        <span className="grid size-5 shrink-0 place-items-center">{brand ? <BrandLogo brand={brand} size={15} /> : <span className="size-1.5 rounded-full bg-line-strong" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{name}</span>
          {sub && <span className="block truncate text-[12px] text-faint">{sub}</span>}
        </span>
        {right}
        <Check aria-hidden className={cx('size-3.5 shrink-0 text-accent', !selected && 'invisible')} />
      </div>
    );
  };

  return (
    <div ref={root} className={cx('relative', variant === 'field' && 'w-full', className)}>
      <button
        ref={button}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-label={`Model: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${uid}-list`}
        aria-activedescendant={open && catalog.data ? optId(active) : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
            return;
          }
          if (!open) return;
          const n = items.length;
          const keys: Record<string, () => void> = {
            ArrowDown: () => setActive((a) => Math.min(n - 1, a + 1)),
            ArrowUp: () => setActive((a) => Math.max(0, a - 1)),
            Home: () => setActive(0),
            End: () => setActive(n - 1),
            PageDown: () => setActive((a) => Math.min(n - 1, a + 6)),
            PageUp: () => setActive((a) => Math.max(0, a - 6)),
            Enter: () => choose(active),
            ' ': () => choose(active),
          };
          const act = keys[e.key];
          if (act) {
            e.preventDefault();
            act();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === 'Tab') setOpen(false);
          else if (e.key.length === 1) {
            const now = Date.now();
            typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
            const i = items.findIndex((it) => (it.kind === 'auto' ? 'auto' : it.m.name.toLowerCase()).startsWith(typed.current.text));
            if (i >= 0) setActive(i);
          }
        }}
        className={cx(
          'flex items-center gap-1 transition-colors disabled:pointer-events-none disabled:opacity-50',
          variant === 'composer'
            ? 'h-8 max-w-[220px] rounded-lg px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg aria-expanded:bg-surface-2 aria-expanded:text-fg'
            : cx(controlBase, 'h-9 justify-between px-3 text-left'),
        )}
      >
        {(() => {
          const brand = !value ? 'copilot' : providerOf(catalog.data?.models.find((x) => x.id === value) ?? value);
          return brand ? <BrandLogo brand={brand} size={variant === 'composer' ? 13 : 15} className={cx('mr-1', variant === 'composer' && 'opacity-90')} /> : null;
        })()}
        <span className="truncate">{label}</span>
        {busy ? <Spinner className="size-3.5" /> : <ChevronDown aria-hidden className={cx('size-3.5 shrink-0 text-faint transition-transform', open && 'rotate-180')} />}
      </button>
      {open && createPortal(
        <div
          ref={panel}
          style={fit.pos ? { position: 'fixed', left: fit.pos.left, width: fit.pos.width, top: fit.pos.top, bottom: fit.pos.bottom } : undefined}
          className={cx(
            'z-[60] flex animate-pop flex-col overflow-hidden rounded-2xl border border-line bg-surface text-left text-fg shadow-lg',
            !fit.pos && 'fixed inset-x-3 bottom-3 origin-bottom',
            fit.pos && (fit.side === 'top' ? (align === 'end' ? 'origin-bottom-right' : 'origin-bottom-left') : align === 'end' ? 'origin-top-right' : 'origin-top-left'),
          )}
        >
          <div className="flex items-center justify-between px-3.5 pt-3 pb-1.5">
            <p id={`${uid}-title`} className="text-[13px] font-semibold">
              Copilot model
            </p>
            <p className="text-[12px] text-faint">≈ credits per task</p>
          </div>
          {catalog.isLoading ? (
            <p className="flex items-center gap-2 px-3.5 pt-1 pb-4 text-[13px] text-muted">
              <Spinner /> Loading models…
            </p>
          ) : catalog.isError || !catalog.data ? (
            <div className="px-3.5 pt-1 pb-4 text-[13px] text-muted">
              <p>{catalog.error instanceof Error ? catalog.error.message : 'Could not load the models.'}</p>
              <button type="button" onClick={() => void catalog.refetch()} className="mt-2 inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-accent-text hover:underline">
                <RotateCw aria-hidden className="size-3.5" /> Try again
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row">
              <div id={`${uid}-list`} role="listbox" aria-labelledby={`${uid}-title`} tabIndex={-1} style={{ maxHeight: fit.list }} className="overflow-y-auto overscroll-contain scroll-smooth px-1.5 pb-1.5 sm:w-[290px] sm:shrink-0">
                {option(0, 'Auto', null, 'Tandem picks per step', 'copilot')}
                {groups.map((g) => (
                    <div key={g.vendor} role="group" aria-labelledby={`${uid}-g-${g.vendor}`}>
                      <div id={`${uid}-g-${g.vendor}`} role="presentation" className="px-2.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                        {g.vendor}
                      </div>
                      {g.entries.map(({ m, index }) =>
                        option(
                          index,
                          m.name,
                          <span className={cx('shrink-0 text-[12px] tabular-nums', m.estimate !== undefined && m.estimate > perTask ? 'text-warn' : 'text-muted')}>{m.estimate !== undefined ? `≈ ${formatCredits(m.estimate)}` : m.multiplier !== undefined ? `${m.multiplier}×` : '–'}</span>,
                          undefined,
                          providerOf(m),
                        ),
                      )}
                    </div>
                ))}
              </div>
              <div className="min-h-[188px] border-t border-line bg-surface-2/60 px-4 py-3.5 sm:min-h-0 sm:flex-1 sm:border-t-0 sm:border-l">
                {items[active] && (
                  <div key={itemId(items[active])} className="animate-[fade-in_120ms_ease-out]">
                    <Details item={items[active]} catalog={catalog.data} />
                  </div>
                )}
              </div>
              </div>
              <div className="flex items-center justify-between border-t border-line px-3.5 py-2 text-[12px] text-faint">
                <span className="tabular-nums">
                  Today {formatCredits(catalog.data.credits.today)} of {catalog.data.credits.perDay} credits
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/settings');
                  }}
                  className="rounded-md font-medium text-accent-text hover:underline"
                >
                  Limits
                </button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
