import { useState } from 'react';
import { cx } from './kit';

/** A person: their GitHub picture when there is one (and it loads), their initials otherwise. */
export function PersonAvatar({ name, src, size = 28, className }: { name: string; src?: string | undefined; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initials =
    name
      .split(/[\s_-]+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '·';
  const box = { width: size, height: size };
  if (src && !failed)
    return <img src={src} alt="" aria-hidden width={size} height={size} style={box} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cx('shrink-0 rounded-full bg-surface-3 object-cover shadow-[0_0_0_1px_var(--border)]', className)} />;
  return (
    <span aria-hidden style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.38)) }} className={cx('grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent-text', className)}>
      {initials}
    </span>
  );
}
