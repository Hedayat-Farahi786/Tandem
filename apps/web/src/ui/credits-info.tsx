import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Coins, Info, X } from 'lucide-react';
import { api } from '../lib/api';
import { useRouter } from '../lib/router';
import { cx } from './kit';

interface UsageSummary {
  credits: { today: number; perDay: number; perTask: number };
}

/** One AI credit is one US cent (GitHub's price for Copilot usage). */
export const CREDIT_USD = 0.01;
/** Credits in money: one credit is one US cent. */
export const creditsToUsd = (credits: number) => (credits >= 100 ? `$${(credits * CREDIT_USD).toFixed(2)}` : `${fmt(credits)}¢`);
const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$|(\.\d*?)0+$/, '$1');

/**
 * A small "i" next to anything measured in AI credits. It opens a short, visual explanation: what a
 * credit is, what it costs, what uses credits and what doesn't, and your limits (with a way to change them).
 */
export function CreditsInfo({ className, label = 'What are AI credits?' }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { path, navigate } = useRouter();
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<UsageSummary>('/api/usage'), enabled: open, staleTime: 10_000 });

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const place = () => {
      const r = trigger.current!.getBoundingClientRect();
      const w = panel.current?.offsetWidth ?? 340;
      const h = panel.current?.offsetHeight ?? 420;
      const below = r.bottom + 8 + h <= window.innerHeight - 8;
      setPos({ top: below ? r.bottom + 8 : Math.max(8, r.top - 8 - h), left: Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8) });
    };
    place();
    const raf = requestAnimationFrame(place);
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', close);
    };
  }, [open, usage.data]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const c = usage.data?.credits;
  const share = c ? Math.min(1, c.today / Math.max(c.perDay, 1e-9)) : 0;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPos(null);
          setOpen(!open);
        }}
        className={cx('inline-grid size-[18px] shrink-0 place-items-center rounded-full align-[-3px] text-faint transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent', open && 'bg-surface-2 text-fg', className)}
      >
        <Info aria-hidden className="size-3.5" strokeWidth={2} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-labelledby={titleId}
            tabIndex={-1}
            style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className="z-50 w-[min(340px,calc(100vw-16px))] animate-pop overflow-hidden rounded-2xl bg-surface text-left text-fg shadow-lg ring-1 ring-line outline-none"
          >
            <header className="flex items-start gap-3 px-4 pt-4 pb-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
                <Coins aria-hidden className="size-[18px]" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-[14.5px] font-semibold">
                  AI credits
                </h2>
                <p className="text-[12.5px] leading-snug text-muted">How GitHub Copilot measures and bills its use.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="-mt-1 -mr-1 grid size-7 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-fg">
                <X aria-hidden className="size-4" />
              </button>
            </header>

            {/* The price, as an equation. */}
            <div className="mx-4 flex items-center justify-center gap-2.5 rounded-xl bg-surface-2 px-3 py-3">
              <span className="rounded-lg bg-surface px-2.5 py-1.5 text-center shadow-[0_0_0_1px_var(--border)]">
                <span className="block text-[15px] font-semibold tabular-nums">1</span>
                <span className="block text-[11px] text-muted">AI credit</span>
              </span>
              <span aria-hidden className="text-[15px] text-faint">=</span>
              <span className="rounded-lg bg-surface px-2.5 py-1.5 text-center shadow-[0_0_0_1px_var(--border)]">
                <span className="block text-[15px] font-semibold tabular-nums">$0.01</span>
                <span className="block text-[11px] text-muted">US dollars</span>
              </span>
              <span aria-hidden className="text-[13px] text-faint">·</span>
              <span className="text-center text-[12px] leading-tight text-muted">
                <span className="block font-medium text-fg tabular-nums">100 credits</span>= $1
              </span>
            </div>

            <p className="px-4 pt-3 text-[13px] leading-relaxed text-muted">
              Each time Copilot calls a model it costs credits: more for larger models and for more text read and written. Copilot reports the exact cost of every call, and Tandem adds them up.
            </p>

            {/* What costs credits, and what doesn't. */}
            <div className="grid grid-cols-2 gap-2 px-4 pt-3">
              <div className="rounded-xl border border-line p-2.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                  <Coins aria-hidden className="size-3" /> Uses credits
                </p>
                <ul className="flex flex-col gap-1 text-[12.5px] leading-snug">
                  <li>Specs and builds</li>
                  <li>Fixes and reviews</li>
                  <li>Chat answers</li>
                </ul>
              </div>
              <div className="rounded-xl border border-line p-2.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wide text-ok uppercase">
                  <Check aria-hidden className="size-3" strokeWidth={2.6} /> Free
                </p>
                <ul className="flex flex-col gap-1 text-[12.5px] leading-snug">
                  <li>Lint, tests, builds</li>
                  <li>Git and pushes</li>
                  <li>Pull requests</li>
                </ul>
              </div>
            </div>

            {/* Your limits, live. */}
            <div className="px-4 pt-3.5 pb-4">
              <p className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
                <span className="font-medium">Used today</span>
                <span className="text-muted tabular-nums">{c ? `${fmt(c.today)} of ${fmt(c.perDay)} · ${creditsToUsd(c.today)}` : '…'}</span>
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="AI credits used today" aria-valuemin={0} aria-valuemax={c?.perDay ?? 0} aria-valuenow={c?.today ?? 0}>
                <div className={cx('h-full rounded-full transition-[width] duration-500', share >= 0.9 ? 'bg-warn' : 'bg-accent')} style={{ width: `${share * 100}%` }} />
              </div>
              <p className="mt-2 text-[12px] leading-snug text-muted">
                {c ? (
                  <>
                    A task may use up to <span className="font-medium text-fg tabular-nums">{fmt(c.perTask)}</span> ({creditsToUsd(c.perTask)}), all of Tandem <span className="font-medium text-fg tabular-nums">{fmt(c.perDay)}</span> a day ({creditsToUsd(c.perDay)}). At a limit, Copilot stops and the task waits for you.
                  </>
                ) : (
                  'Loading your limits…'
                )}
              </p>
              {path !== '/settings' && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate('/settings');
                    setTimeout(() => document.getElementById('budget')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
                  }}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-accent-text hover:underline"
                >
                  Change the limits in Settings
                  <ArrowRight aria-hidden className="size-3.5" />
                </button>
              )}
            </div>
            <p className="border-t border-line bg-surface-2/50 px-4 py-2 text-[11.5px] text-faint">Price set by GitHub for Copilot. Model prices are in the model menu.</p>
          </div>,
          document.body,
        )}
    </>
  );
}
