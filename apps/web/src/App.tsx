import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './lib/api';
import { useLiveInvalidation } from './lib/events';
import { Link, RouterProvider, match, useRouter } from './lib/router';
import type { Bootstrap } from './lib/types';
import { FolderGit2, ListTodo, MessageSquare, Moon, Settings2, Stethoscope, Sun, type LucideIcon } from 'lucide-react';
import { ErrorState, IconButton, Loading, ToastProvider, cx } from './ui/kit';
import { SetupScreen } from './screens/Setup';
import { ChatScreen } from './screens/Chat';
import { TasksScreen } from './screens/Tasks';
import { TaskDetailScreen } from './screens/TaskDetail';
import { ProjectsScreen } from './screens/Projects';
import { SettingsScreen } from './screens/Settings';
import { DoctorScreen } from './screens/Doctor';

export function makeQueryClient() {
  // Retry once for a dropped connection or a server hiccup; a 4xx answer won't change on retry.
  const retry = (count: number, err: unknown) => count < 1 && !(err instanceof ApiError && err.status >= 400 && err.status < 500);
  return new QueryClient({ defaultOptions: { queries: { retry, refetchOnWindowFocus: false, staleTime: 2_000 }, mutations: { retry: 0 } } });
}

export function App({ client, initialPath }: { client?: QueryClient; initialPath?: string }) {
  const [qc] = useState(() => client ?? makeQueryClient());
  return (
    <QueryClientProvider client={qc}>
      <RouterProvider {...(initialPath ? { initial: initialPath } : {})}>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}

const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/doctor', label: 'Doctor', icon: Stethoscope },
];

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('tandem-theme', theme);
    } catch {
      // private mode
    }
  }, [theme]);
  return <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Light mode' : 'Dark mode'} size="sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />;
}

function Shell() {
  useLiveInvalidation();
  const { path, navigate } = useRouter();
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  useEffect(() => {
    if (boot.data && !boot.data.setupComplete && !path.startsWith('/setup') && !path.startsWith('/doctor') && !path.startsWith('/settings')) navigate('/setup', { replace: true });
    if (boot.data?.setupComplete && path === '/') navigate('/chat', { replace: true });
  }, [boot.data, path, navigate]);

  let screen: ReactNode;
  let m: Record<string, string> | null;
  if (path.startsWith('/setup')) screen = <SetupScreen />;
  else if ((m = match('/tasks/:id', path))) screen = <TaskDetailScreen id={m.id!} />;
  else if (path.startsWith('/tasks')) screen = <TasksScreen />;
  else if (path.startsWith('/chat')) screen = <ChatScreen />;
  else if (path.startsWith('/projects')) screen = <ProjectsScreen />;
  else if (path.startsWith('/settings')) screen = <SettingsScreen />;
  else if (path.startsWith('/doctor')) screen = <DoctorScreen />;
  else screen = <Loading />;

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md">
        Skip to content
      </a>
      <div className="hidden w-60 shrink-0 border-r border-line bg-sidebar md:block">
        <nav aria-label="Main" className="sticky top-0 flex h-screen flex-col px-3 py-5">
          <Link to="/chat" className="mb-7 flex items-center gap-2.5 px-2.5">
            <span aria-hidden className="grid size-7 place-items-center rounded-[9px] bg-accent text-accent-fg shadow-sm">
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3.5 4.5h9M8 4.5v8" />
              </svg>
            </span>
            <span className="font-serif text-[18px] font-medium tracking-tight">Tandem</span>
          </Link>
          <ul className="flex flex-col gap-0.5">
            {NAV.map((n) => {
              const active = path.startsWith(n.to);
              const Icon = n.icon;
              return (
                <li key={n.to}>
                  <Link to={n.to} aria-current={active ? 'page' : undefined} className={cx('flex h-9 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] transition-colors', active ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:bg-surface-2/70 hover:text-fg')}>
                    <Icon aria-hidden className={cx('size-4', active ? 'text-accent' : 'text-faint')} strokeWidth={2} />
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto flex items-center justify-between gap-2 px-1.5">
            {boot.data && boot.data.agent !== 'copilot' ? <span className="rounded-md bg-warn-soft px-2 py-1 text-[11.5px] font-medium text-warn">Test mode · {boot.data.agent} agent</span> : <span className="text-[11.5px] text-faint">Local · 127.0.0.1</span>}
            <ThemeToggle />
          </div>
        </nav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Main (compact)" className="flex gap-1 overflow-x-auto border-b border-line bg-sidebar px-3 py-2 md:hidden">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={cx('rounded-lg px-3 py-1.5 text-[13px]', path.startsWith(n.to) ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted')}>
              {n.label}
            </Link>
          ))}
        </nav>
        <main id="main" className="mx-auto w-full max-w-[1120px] flex-1 px-5 py-8 md:px-10 md:py-10">
          {boot.isError ? <ErrorState title="Tandem could not load" error={boot.error} retry={() => void boot.refetch()} /> : boot.isLoading ? <Loading /> : screen}
        </main>
      </div>
    </div>
  );
}
