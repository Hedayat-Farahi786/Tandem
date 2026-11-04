import { useEffect, useRef, useState } from 'react';
import { cx } from './kit';

const reduced = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Types out what changed in `text` while the page is open, like a cursor writing it: the part that
 * stayed the same shows at once, the rest appears over up to ~1.2 s. Text present on first render
 * (a reload, say) shows at once. `typing` is true while it writes.
 */
export function useTyped(text: string): { shown: string; typing: boolean } {
  const [shown, setShown] = useState(text);
  const target = useRef(text);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (text === target.current) return;
    const from = shown;
    target.current = text;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    let common = 0;
    while (common < from.length && common < text.length && from[common] === text[common]) common++;
    const add = text.length - common;
    if (add <= 0 || reduced()) {
      setShown(text);
      return;
    }
    const ms = Math.min(1200, Math.max(220, add * 14));
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      setShown(text.slice(0, common + Math.round(add * p)));
      frame.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    setShown(text.slice(0, common));
    frame.current = requestAnimationFrame(step);
    // `shown` is read only as the starting point of a new animation, so it isn't a dependency.
  }, [text]);
  useEffect(() => () => (frame.current !== null ? cancelAnimationFrame(frame.current) : undefined), []);
  return { shown, typing: shown !== text };
}

/** A blinking text cursor. */
export function Caret({ className }: { className?: string }) {
  return <span aria-hidden className={cx('ml-px inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-[caret-blink_1s_step-end_infinite] rounded-full bg-accent align-baseline', className)} />;
}

/** Text that types out its changes, with the cursor while it writes. */
export function Typed({ text, className, caret }: { text: string; className?: string; caret?: boolean }) {
  const { shown, typing } = useTyped(text);
  return (
    <span className={className}>
      {shown}
      {(typing || caret) && <Caret />}
    </span>
  );
}
