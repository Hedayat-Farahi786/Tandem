import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { ApiError, api } from "./lib/api";
import { useLiveInvalidation } from "./lib/events";
import { Link, RouterProvider, match, useRouter } from "./lib/router";
import type { Bootstrap } from "./lib/types";
import {
  Check,
  ChevronsUpDown,
  FolderGit2,
  ListTodo,
  Moon,
  Plus,
  Settings2,
  Stethoscope,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { ChatThread } from "@tandem/shared";
import type { TaskListItem } from "./lib/types";
import { NEEDS_YOU } from "./lib/tasks";
import { useTheme } from "./lib/theme";
import { CommandPalette } from "./ui/command";
import { ProjectAvatar } from "./ui/visual";
import { relativeTime } from "./lib/format";
import { useChatProject } from "./lib/project";
import {
  Avatar,
  ErrorState,
  IconButton,
  Loading,
  ToastProvider,
  cx,
} from "./ui/kit";
import { SetupScreen } from "./screens/Setup";
import { ChatScreen } from "./screens/Chat";
import { TasksScreen } from "./screens/Tasks";
import { TaskDetailScreen } from "./screens/TaskDetail";
import { ProjectsScreen } from "./screens/Projects";
import { SettingsScreen } from "./screens/Settings";
import { DoctorScreen } from "./screens/Doctor";

export function makeQueryClient() {
  // Retry once for a dropped connection or a server hiccup; a 4xx answer won't change on retry.
  const retry = (count: number, err: unknown) =>
    count < 1 &&
    !(err instanceof ApiError && err.status >= 400 && err.status < 500);
  return new QueryClient({
    defaultOptions: {
      queries: { retry, refetchOnWindowFocus: false, staleTime: 2_000 },
      mutations: { retry: 0 },
    },
  });
}

export function App({
  client,
  initialPath,
}: {
  client?: QueryClient;
  initialPath?: string;
}) {
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
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/projects", label: "Projects", icon: FolderGit2 },
];
const FOOTER_NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "/settings", label: "Settings", icon: Settings2 },
  { to: "/doctor", label: "Doctor", icon: Stethoscope },
];
const COMPACT_NAV = [{ to: "/chat", label: "Chat" }, ...NAV, ...FOOTER_NAV];

const navItem = (active: boolean) =>
  cx(
    "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors duration-150",
    active
      ? "bg-surface font-medium text-fg shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]"
      : "text-muted hover:bg-surface-3/60 hover:text-fg",
  );

function Recents({ projectId }: { projectId: string }) {
  const { path, search } = useRouter();
  const threads = useQuery({
    queryKey: ["threads", projectId],
    queryFn: () => api<ChatThread[]>(`/api/projects/${projectId}/threads`),
    enabled: Boolean(projectId),
  });
  const current = path.startsWith("/chat") ? search.get("thread") : null;
  return (
    <nav
      aria-label="Conversations"
      className="mt-6 flex min-h-0 flex-1 flex-col"
    >
      <p className="mb-1 flex h-6 items-center px-2.5 text-[11.5px] font-medium text-faint">
        Recents
      </p>
      <ul className="-mr-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pr-2 [scrollbar-width:thin]">
        {threads.isLoading && (
          <li className="px-2.5 py-1.5 text-[12.5px] text-faint">Loading…</li>
        )}
        {threads.data?.length === 0 && (
          <li className="px-2.5 py-1.5 text-[12.5px] leading-snug text-faint">
            Your requests and questions appear here.
          </li>
        )}
        {threads.data?.map((t) => {
          const active = t.id === current;
          return (
            <li key={t.id}>
              <Link
                to={`/chat?project=${projectId}&thread=${t.id}`}
                aria-current={active ? "page" : undefined}
                title={`${t.title} · ${t.createdTaskId ? "became a task" : t.mode === "request" ? "request" : "question"} · ${relativeTime(t.updatedAt)}`}
                className={cx(
                  "group flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors duration-150",
                  active
                    ? "bg-surface text-fg shadow-[0_0_0_1px_var(--border)]"
                    : "text-muted hover:bg-surface-3/60 hover:text-fg",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {t.createdTaskId && (
                  <ListTodo
                    aria-label="Became a task"
                    className="size-3.5 shrink-0 text-faint opacity-70"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ThemeToggle() {
  const [theme, toggle] = useTheme();
  return (
    <IconButton
      icon={theme === "dark" ? Sun : Moon}
      label={theme === "dark" ? "Light mode" : "Dark mode"}
      size="sm"
      onClick={toggle}
    />
  );
}

/** The project the sidebar's chats belong to: a workspace-style switcher. */
function ProjectSwitcher({
  boot,
  current,
}: {
  boot: Bootstrap;
  current: string;
}) {
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const project =
    boot.projects.find((p) => p.id === current) ?? boot.projects[0];
  const items = [
    ...boot.projects.map((p) => ({
      id: p.id,
      run: () => navigate(`/chat?project=${p.id}`),
    })),
    { id: "manage", run: () => navigate("/projects") },
  ];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) =>
      !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => {
    if (open)
      root.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.focus();
  }, [open, active]);
  if (!project) return null;
  const repos = project.repoIds.length;
  const pick = (i: number) => {
    setOpen(false);
    items[i]?.run();
  };
  return (
    <div ref={root} className="relative mb-3">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setActive(
            Math.max(
              0,
              boot.projects.findIndex((p) => p.id === project.id),
            ),
          );
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          "flex w-full items-center gap-2.5 rounded-xl p-1.5 pr-2 text-left transition-colors duration-150 hover:bg-surface-3/60",
          open && "bg-surface-3/60",
        )}
      >
        <span className="sr-only">Project: </span>
        <ProjectAvatar name={project.name} projectId={project.id} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] leading-tight font-semibold">
            {project.name}
          </span>
          <span className="block truncate text-[11.5px] leading-tight text-faint">
            {repos} {repos === 1 ? "repository" : "repositories"}
          </span>
        </span>
        <span className="sr-only">. Switch project</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-faint" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Switch project"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % items.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + items.length) % items.length);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              root.current?.querySelector<HTMLElement>("button")?.focus();
            } else if (e.key === "Tab") setOpen(false);
          }}
          className="absolute inset-x-0 top-full z-40 mt-1 animate-pop rounded-xl bg-surface p-1 shadow-lg ring-1 ring-line"
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-faint">
            Projects
          </p>
          {boot.projects.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === project.id}
              data-i={i}
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
              className={cx(
                "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] outline-none",
                active === i && "bg-surface-2",
              )}
            >
              <ProjectAvatar name={p.name} projectId={p.id} size={20} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === project.id && (
                <Check aria-hidden className="size-3.5 text-fg" />
              )}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            data-i={items.length - 1}
            tabIndex={-1}
            onMouseEnter={() => setActive(items.length - 1)}
            onClick={() => pick(items.length - 1)}
            className={cx(
              "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-muted outline-none",
              active === items.length - 1 && "bg-surface-2 text-fg",
            )}
          >
            <span className="grid size-5 place-items-center">
              <FolderGit2 aria-hidden className="size-3.5" />
            </span>
            Manage projects
          </button>
        </div>
      )}
    </div>
  );
}

function Shell() {
  useLiveInvalidation();
  const { path, search, navigate } = useRouter();
  const boot = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api<Bootstrap>("/api/bootstrap"),
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api<TaskListItem[]>("/api/tasks"),
    enabled: Boolean(boot.data?.setupComplete),
  });
  const needsYou =
    tasks.data?.filter((t) => NEEDS_YOU.has(t.state)).length ?? 0;
  const chatProject = useChatProject(boot.data, search);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    if (
      boot.data &&
      !boot.data.setupComplete &&
      !path.startsWith("/setup") &&
      !path.startsWith("/doctor") &&
      !path.startsWith("/settings")
    )
      navigate("/setup", { replace: true });
    if (boot.data?.setupComplete && path === "/")
      navigate("/chat", { replace: true });
  }, [boot.data, path, navigate]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  let screen: ReactNode;
  let m: Record<string, string> | null;
  if (path.startsWith("/setup")) screen = <SetupScreen />;
  else if ((m = match("/tasks/:id", path)))
    screen = <TaskDetailScreen id={m.id!} />;
  else if (path.startsWith("/tasks")) screen = <TasksScreen />;
  else if (path.startsWith("/chat")) screen = <ChatScreen />;
  else if (path.startsWith("/projects")) screen = <ProjectsScreen />;
  else if (path.startsWith("/settings")) screen = <SettingsScreen />;
  else if (path.startsWith("/doctor")) screen = <DoctorScreen />;
  else screen = <Loading />;

  const testMode =
    boot.data && (boot.data.agent !== "copilot" || boot.data.localRepoCopies);
  const owner = boot.data?.settings.ownerName?.trim();

  return (
    <div className="flex min-h-screen bg-sidebar">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md"
      >
        Skip to content
      </a>
      <div className="hidden w-[256px] shrink-0 md:block">
        <div className="sticky top-0 flex h-screen flex-col px-3 pt-3 pb-3">
          <div className="mb-3 flex h-9 items-center justify-between gap-2 pl-2">
            <Link to="/chat" className="flex items-center gap-2 rounded-lg">
              <span
                aria-hidden
                className="grid size-[22px] place-items-center rounded-[7px] bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="size-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                >
                  <path d="M3.5 4.5h9M8 4.5v8" />
                </svg>
              </span>
              <span className="font-display text-[16px]">Tandem</span>
            </Link>
            <ThemeToggle />
          </div>
          {boot.data?.projects.length ? (
            <ProjectSwitcher boot={boot.data} current={chatProject} />
          ) : null}
          <nav aria-label="Main" className="flex flex-col gap-px">
            <Link
              to={chatProject ? `/chat?project=${chatProject}` : "/chat"}
              aria-current={
                path.startsWith("/chat") && !search.get("thread")
                  ? "page"
                  : undefined
              }
              className={cx(
                navItem(path.startsWith("/chat") && !search.get("thread")),
                "text-fg",
              )}
            >
              <span
                aria-hidden
                className="-ml-0.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg"
              >
                <Plus className="size-3.5" strokeWidth={2.5} />
              </span>
              New chat
            </Link>
            {NAV.map((n) => {
              const active = path.startsWith(n.to);
              const Icon = n.icon;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  aria-current={active ? "page" : undefined}
                  className={navItem(active)}
                >
                  <Icon
                    aria-hidden
                    className={cx(
                      "size-4",
                      active ? "text-fg" : "text-faint group-hover:text-fg",
                    )}
                    strokeWidth={1.9}
                  />
                  <span className="flex-1">{n.label}</span>
                  {n.to === "/tasks" && needsYou > 0 && (
                    <span
                      title={`${needsYou} need${needsYou === 1 ? "s" : ""} you`}
                      className="min-w-5 rounded-full bg-warn-soft px-1.5 text-center text-[11px] leading-[18px] font-semibold text-warn tabular-nums"
                    >
                      {needsYou}
                      <span className="sr-only"> need you</span>
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          {boot.data?.projects.length ? (
            <Recents projectId={chatProject} />
          ) : (
            <div className="flex-1" />
          )}
          <div className="mt-3 flex flex-col gap-2 pt-1">
            <nav aria-label="Tandem" className="flex flex-col gap-px">
              {FOOTER_NAV.map((n) => {
                const active = path.startsWith(n.to);
                const Icon = n.icon;
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    aria-current={active ? "page" : undefined}
                    className={navItem(active)}
                  >
                    <Icon
                      aria-hidden
                      className={cx(
                        "size-4",
                        active ? "text-fg" : "text-faint group-hover:text-fg",
                      )}
                      strokeWidth={1.9}
                    />
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
              <Avatar name={owner || "You"} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13px] font-medium">
                  {owner || "You"}
                </p>
                {testMode ? (
                  <p
                    className="truncate text-[11.5px] text-warn"
                    title={
                      boot.data?.localRepoCopies
                        ? "Repositories come from local copies, so pull requests are links to fill in by hand."
                        : undefined
                    }
                  >
                    Test mode ·{" "}
                    {boot.data!.agent !== "copilot"
                      ? `${boot.data!.agent} agent`
                      : "local repos"}
                  </p>
                ) : (
                  <p className="truncate text-[11.5px] text-faint">
                    Local · 127.0.0.1
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <nav
          aria-label="Main (compact)"
          className="flex gap-1 overflow-x-auto bg-sidebar px-3 py-2 md:hidden"
        >
          {COMPACT_NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={cx(
                "rounded-lg px-3 py-1.5 text-[13px] whitespace-nowrap",
                path.startsWith(n.to)
                  ? "bg-surface font-medium text-fg shadow-sm"
                  : "text-muted",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-1 flex-col bg-bg md:min-h-[calc(100vh-16px)] md:rounded-[14px] md:shadow-panel">
          <main
            id="main"
            className={cx("mx-auto w-full max-w-[1120px] flex-1", path.startsWith("/chat") ? "px-4 pb-4 md:px-8" : "px-5 py-8 md:px-10 md:py-10")}
          >
            {boot.isError ? (
              <ErrorState
                title="Tandem could not load"
                error={boot.error}
                retry={() => void boot.refetch()}
              />
            ) : boot.isLoading ? (
              <Loading />
            ) : (
              screen
            )}
          </main>
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
