import { useCallback, useSyncExternalStore } from 'react';

/** The colour theme, kept on <html data-theme> and in localStorage; every user of the hook stays in sync. */
type Theme = 'light' | 'dark';
const EVENT = 'tandem-theme';
const read = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('tandem-theme', theme);
  } catch {
    // private mode
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, read, () => 'light' as Theme);
  const toggle = useCallback(() => setTheme(read() === 'dark' ? 'light' : 'dark'), []);
  return [theme, toggle];
}
