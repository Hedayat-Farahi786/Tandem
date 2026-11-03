import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './lib/api';
import { useLiveInvalidation } from './lib/events';
import { Link, RouterProvider, match, useRouter } from './lib/router';
import type { Bootstrap } from './lib/types';
import { FolderGit2, ListTodo, Moon, Plus, Settings2, Stethoscope, Sun, type LucideIcon } from 'lucide-react';
import type { ChatThread } from '@tandem/shared';
import { relativeTime } from './lib/format';
import { useChatProject } from './lib/project';
import { ErrorState, IconButton, Loading, Select, ToastProvider, cx } from './ui/kit';
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
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
];
const FOOTER_NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/doctor', label: 'Doctor', icon: Stethoscope },
];
const COMPACT_NAV = [{ to: '/chat', label: 'Chat' }, ...NAV, ...FOOTER_NAV];

const navItem = (active: boolean) => cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors', active ? 'bg-surface-3/80 font-medium text-fg' : 'text-muted hover:bg-surface-3/50 hover:text-fg');

function Recents({ boot, projectId }: { boot: Bootstrap; projectId: string }) {
  const { path, search, navigate } = useRouter();
  const threads = useQuery({ queryKey: ['threads', projectId], queryFn: () => api<ChatThread[]>(`/api/projects/${projectId}/threads`), enabled: Boolean(projectId) });
  const current = path.startsWith('/chat') ? search.get('thread') : null;
  return (
    <nav aria-label="Conversations" className="mt-6 flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex h-7 items-center justify-between gap-2 px-2.5">
        <p className="text-[12px] font-medium text-faint">Recents</p>
      </div>
      {boot.projects.length > 1 && (
        <div className="mb-2 px-1">
          <Select label="Project" hideLabel value={projectId} onChange={(p) => navigate(`/chat?project=${p}`)} options={boot.projects.map((p) => ({ value: p.id, label: p.name }))} className="[&_button]:h-8 [&_button]:text-[13px]" />
        </div>
      )}
      <ul className="-mr-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pr-2 [scrollbar-width:thin]">
        {threads.isLoading && <li className="px-2.5 py-1.5 text-[12.5px] text-faint">Loading…</li>}
        {threads.data?.length === 0 && <li className="px-2.5 py-1.5 text-[12.5px] leading-snug text-faint">Your requests and questions appear here.</li>}
        {threads.data?.map((t) => {
          const active = t.id === current;
          return (
            <li key={t.id}>
              <Link
                to={`/chat?project=${projectId}&thread=${t.id}`}
                aria-current={active ? 'page' : undefined}
                title={`${t.title} · ${t.createdTaskId ? 'became a task' : t.mode === 'request' ? 'request' : 'question'} · ${relativeTime(t.updatedAt)}`}
                className={cx('group flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors', active ? 'bg-surface-3/80 text-fg' : 'text-muted hover:bg-surface-3/50 hover:text-fg')}
              >
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {t.createdTaskId && <ListTodo aria-label="Became a task" className="size-3.5 shrink-0 text-faint" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

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
  const { path, search, navigate } = useRouter();
  const boot = useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('/api/bootstrap') });
  const chatProject = useChatProject(boot.data, search);
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
      <div className="hidden w-[260px] shrink-0 border-r border-line bg-sidebar md:block">
        <div className="sticky top-0 flex h-screen flex-col px-3 pt-4 pb-3">
          <Link to="/chat" className="mb-5 flex h-9 items-center gap-2.5 rounded-lg px-2.5">
            <span aria-hidden className="grid size-6 place-items-center rounded-[7px] bg-accent text-accent-fg">
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M3.5 4.5h9M8 4.5v8" />
              </svg>
            </span>
            <span className="font-serif text-[18px] font-medium tracking-tight">Tandem</span>
          </Link>
          <nav aria-label="Main" className="flex flex-col gap-px">
            <Link to={chatProject ? `/chat?project=${chatProject}` : '/chat'} aria-current={path.startsWith('/chat') && !search.get('thread') ? 'page' : undefined} className={cx(navItem(path.startsWith('/chat') && !search.get('thread')), 'text-fg')}>
              <span aria-hidden className="-ml-0.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
                <Plus className="size-3.5" strokeWidth={2.5} />
              </span>
              New chat
            </Link>
            {NAV.map((n) => {
              const active = path.startsWith(n.to);
              const Icon = n.icon;
              return (
                <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined} className={navItem(active)}>
                  <Icon aria-hidden className={cx('size-4', active ? 'text-fg' : 'text-faint')} strokeWidth={1.9} />
                  {n.label}
                </Link>
              );
            })}
          </nav>
          {boot.data?.projects.length ? <Recents boot={boot.data} projectId={chatProject} /> : <div className="flex-1" />}
          <div className="mt-3 border-t border-line pt-3">
            <nav aria-label="Tandem" className="flex flex-col gap-px">
              {FOOTER_NAV.map((n) => {
                const active = path.startsWith(n.to);
                const Icon = n.icon;
                return (
                  <Link key={n.to} to={n.to} aria-current={active ? 'page' : undefined} className={navItem(active)}>
                    <Icon aria-hidden className={cx('size-4', active ? 'text-fg' : 'text-faint')} strokeWidth={1.9} />
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-2 flex items-center justify-between gap-2 pl-2.5">
              {boot.data && (boot.data.agent !== 'copilot' || boot.data.localRepoCopies) ? (
                <span className="truncate rounded-md bg-warn-soft px-2 py-1 text-[11.5px] font-medium text-warn" title={boot.data.localRepoCopies ? 'Repositories come from local copies, so pull requests are links to fill in by hand.' : undefined}>
                  Test mode · {boot.data.agent !== 'copilot' ? `${boot.data.agent} agent` : 'local repos'}
                </span>
              ) : (
                <span className="text-[11.5px] text-faint">Local · 127.0.0.1</span>
              )}
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Main (compact)" className="flex gap-1 overflow-x-auto border-b border-line bg-sidebar px-3 py-2 md:hidden">
          {COMPACT_NAV.map((n) => (
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
