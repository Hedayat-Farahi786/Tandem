import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

/** A small history router: enough for Tandem's handful of screens, no dependency. */
interface RouterValue {
  path: string;
  search: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}
const Ctx = createContext<RouterValue>({ path: '/', search: new URLSearchParams(), navigate: () => undefined });

export function RouterProvider({ children, initial }: { children: ReactNode; initial?: string }) {
  const [loc, setLoc] = useState(() => initial ?? `${window.location.pathname}${window.location.search}`);
  useEffect(() => {
    const on = () => setLoc(`${window.location.pathname}${window.location.search}`);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setLoc(to);
    window.scrollTo?.(0, 0);
  }, []);
  const value = useMemo(() => {
    const [p, q] = loc.split('?');
    return { path: p || '/', search: new URLSearchParams(q ?? ''), navigate };
  }, [loc, navigate]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useRouter = () => useContext(Ctx);

/** Matches "/tasks/:id" style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length && !pattern.endsWith('*')) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg === '*') return params;
    if (seg.startsWith(':')) {
      if (b[i] === undefined) return null;
      params[seg.slice(1)] = decodeURIComponent(b[i]!);
    } else if (seg !== b[i]) return null;
  }
  return params;
}

export function Link({ to, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
