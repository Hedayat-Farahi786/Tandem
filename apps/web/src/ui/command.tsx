import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CornerDownLeft,
  FolderGit2,
  History,
  ListTodo,
  MessageSquarePlus,
  Moon,
  Search,
  Settings2,
  Stethoscope,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { useRouter } from "../lib/router";
import { useTheme } from "../lib/theme";
import type { Bootstrap, TaskListItem } from "../lib/types";
import { ProjectAvatar, StatusIcon } from "./visual";
import { cx } from "./kit";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

const icon = (I: LucideIcon) => (
  <I aria-hidden className="size-4" strokeWidth={1.9} />
);

/** ⌘K: jump to any page, task or project, or switch the theme, from the keyboard. */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { navigate } = useRouter();
  const [theme, toggleTheme] = useTheme();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const boot = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api<Bootstrap>("/api/bootstrap"),
    enabled: open,
  });
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api<TaskListItem[]>("/api/tasks"),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const pages: Item[] = [
      {
        id: "new-chat",
        group: "Go to",
        label: "New chat",
        icon: icon(MessageSquarePlus),
        keywords: "request ask start",
        run: go("/chat"),
      },
      {
        id: "tasks",
        group: "Go to",
        label: "Tasks",
        icon: icon(ListTodo),
        run: go("/tasks"),
      },
      {
        id: "projects",
        group: "Go to",
        label: "Projects",
        icon: icon(FolderGit2),
        keywords: "repositories rules",
        run: go("/projects"),
      },
      {
        id: "activity",
        group: "Go to",
        label: "Activity",
        icon: icon(History),
        keywords: "audit log trace history",
        run: go("/activity"),
      },
      {
        id: "settings",
        group: "Go to",
        label: "Settings",
        icon: icon(Settings2),
        keywords: "budget copilot aws jira github",
        run: go("/settings"),
      },
      {
        id: "doctor",
        group: "Go to",
        label: "Doctor",
        icon: icon(Stethoscope),
        keywords: "checks health",
        run: go("/doctor"),
      },
    ];
    const projects: Item[] = (boot.data?.projects ?? []).map((p) => ({
      id: `p-${p.id}`,
      group: "Chat in project",
      label: p.name,
      icon: <ProjectAvatar name={p.name} size={18} />,
      run: go(`/chat?project=${p.id}`),
    }));
    const recent: Item[] = [...(tasks.data ?? [])]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => ({
        id: `t-${t.id}`,
        group: "Tasks",
        label: t.title,
        hint: t.key,
        keywords: t.key,
        icon: <StatusIcon state={t.state} />,
        run: go(`/tasks/${t.id}`),
      }));
    const prefs: Item[] = [
      {
        id: "theme",
        group: "Preferences",
        label:
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        icon: icon(theme === "dark" ? Sun : Moon),
        keywords: "theme appearance",
        run: () => (toggleTheme(), onClose()),
      },
    ];
    return [...pages, ...projects, ...recent, ...prefs];
  }, [boot.data, tasks.data, theme, navigate, onClose, toggleTheme]);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = items.filter((i) =>
      words.every((w) =>
        `${i.label} ${i.hint ?? ""} ${i.keywords ?? ""} ${i.group}`
          .toLowerCase()
          .includes(w),
      ),
    );
    // Without a query, keep the list short: pages, projects, the five latest tasks, preferences.
    if (!words.length) {
      let n = 0;
      return hits.filter((i) => i.group !== "Tasks" || n++ < 5);
    }
    return hits.slice(0, 40);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    void document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  if (!open) return null;
  let lastGroup = "";
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        aria-hidden
        className="absolute inset-0 animate-in bg-[rgb(10_10_12/0.35)] backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Tandem"
        className="relative w-full max-w-[600px] animate-pop overflow-hidden rounded-2xl bg-surface shadow-lg"
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search aria-hidden className="size-4 shrink-0 text-faint" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              shown[active] ? `${listId}-${active}` : undefined
            }
            aria-label="Search pages, tasks and projects"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                shown[active]?.run();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Search pages, tasks and projects…"
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-faint">
            Esc
          </kbd>
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
        >
          {shown.length === 0 && (
            <li className="px-3 py-8 text-center text-[13px] text-muted">
              Nothing matches “{q}”.
            </li>
          )}
          {shown.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {header && (
                  <p className="px-3 pt-2.5 pb-1 text-[11.5px] font-medium text-faint">
                    {header}
                  </p>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => item.run()}
                  className={cx(
                    "flex h-10 cursor-default items-center gap-3 rounded-[10px] px-3 text-[13.5px]",
                    i === active ? "bg-surface-2 text-fg" : "text-muted",
                  )}
                >
                  <span className="grid size-5 shrink-0 place-items-center text-muted">
                    {item.icon}
                  </span>
                  <span
                    className={cx(
                      "min-w-0 flex-1 truncate",
                      i === active && "text-fg",
                    )}
                  >
                    {item.label}
                  </span>
                  {item.hint && (
                    <span className="font-mono text-[11.5px] text-faint">
                      {item.hint}
                    </span>
                  )}
                  {i === active &&
                    (item.group === "Tasks" || item.group === "Go to" ? (
                      <ArrowRight aria-hidden className="size-3.5 text-faint" />
                    ) : (
                      <CornerDownLeft
                        aria-hidden
                        className="size-3.5 text-faint"
                      />
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11.5px] text-faint">
          <span className="flex items-center gap-1.5">
            <kbd className="font-sans">↑↓</kbd> to move
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="font-sans">↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
