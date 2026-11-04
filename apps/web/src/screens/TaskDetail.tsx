import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  FileCheck2,
  GitMerge,
  MessageSquareText,
  GitPullRequest,
  Pencil,
  RotateCcw,
  Scissors,
  ShieldAlert,
  Sparkles,
  LayoutList,
  MessagesSquare,
  ThumbsUp,
  Undo2,
  XCircle,
} from "lucide-react";
import type {
  CommandResult,
  PullRequest,
  ReviewFinding,
  Task,
} from "@tandem/shared";
import { api, fetchText, patch, post, put } from "../lib/api";
import { ModelPicker } from "../ui/model-picker";
import { CriterionText, InlineText } from "../ui/text";
import {
  STATE_LABEL,
  STATE_TONE,
  relativeTime,
  stepLabel,
} from "../lib/format";
import { Link } from "../lib/router";
import type { RepoDiff, TaskDetail } from "../lib/types";
import { DiffView } from "../ui/diff";
import {
  Button,
  Callout,
  LinkButton,
  Card,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Markdown,
  PageHeader,
  Pill,
  Section,
  Select,
  TabPanel,
  Tabs,
  Textarea,
  cx,
  useToast,
} from "../ui/kit";
import { ThreadPanel } from "./Chat";
import { CriteriaEditor, ReadinessChecklist } from "./Tasks";
import { TraceTab } from "./Trace";
import { TaskActivity } from "./TaskActivity";
import { TaskChatView, type PanelTab } from "./TaskChat";
import { StatusIcon } from "../ui/visual";
import { BrandLogo, hostBrand } from "../ui/brands";

type Tab = "overview" | "activity" | "spec" | "changes" | "checks" | "prs" | "trace" | "chat";
const RUNNING = new Set([
  "READINESS",
  "SPEC_DRAFTING",
  "BUILDING",
  "VERIFYING",
  "SELF_REVIEW",
]);
const FLOW = [
  "READINESS",
  "SPEC_DRAFTING",
  "SPEC_REVIEW",
  "BUILDING",
  "VERIFYING",
  "SELF_REVIEW",
  "PR_OPEN",
  "DONE",
] as const;

function useAct(taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      path,
      body,
      method,
    }: {
      path: string;
      body?: unknown;
      method?: "POST" | "PUT" | "PATCH";
      done?: string;
    }) =>
      method === "PUT"
        ? put(path, body)
        : method === "PATCH"
          ? patch(path, body)
          : post(path, body ?? {}),
    onSuccess: (_r, v) => {
      if (v.done) toast(v.done, "ok");
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : String(err), "danger"),
  });
}

/* ------------------------------------------------------------------ progress rail */

function ProgressRail({ task }: { task: Task }) {
  const resumeState = task.resumeTo?.state ?? task.state;
  const at = FLOW.indexOf(
    (task.state === "BLOCKED" || task.state === "FAILED"
      ? resumeState
      : task.state) as (typeof FLOW)[number],
  );
  const cancelled = task.state === "CANCELLED";
  return (
    <ol
      aria-label="Workflow progress"
      className="mb-8 grid grid-cols-8 rounded-2xl bg-surface px-3 pt-4 pb-3 shadow-panel"
    >
      {FLOW.map((s, i) => {
        const done = at > i || task.state === "DONE";
        const current = at === i && task.state !== "DONE";
        const stuck =
          current && (task.state === "BLOCKED" || task.state === "FAILED");
        const failed = stuck && task.state === "FAILED";
        return (
          <li
            key={s}
            className="relative flex flex-col items-center gap-2 text-center"
            aria-current={current ? "step" : undefined}
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cx(
                  "absolute top-[11px] right-1/2 left-[-50%] h-[2px] rounded-full",
                  done || current ? "bg-ok/70" : "bg-surface-3",
                )}
              />
            )}
            <span
              aria-hidden
              className={cx(
                "relative z-[1] grid size-6 place-items-center rounded-full transition-colors",
                done
                  ? "bg-ok text-white"
                  : failed
                    ? "bg-danger text-white"
                    : stuck
                      ? "bg-warn text-white"
                      : current
                        ? "bg-surface shadow-[0_0_0_2px_var(--accent)]"
                        : cancelled
                          ? "bg-surface-2 shadow-[0_0_0_1px_var(--border-strong)]"
                          : "bg-surface shadow-[0_0_0_1.5px_var(--border-strong)]",
              )}
            >
              {done ? (
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 8.4 6.8 11 12 5.5" />
                </svg>
              ) : stuck ? (
                <span className="text-[12px] leading-none font-bold">!</span>
              ) : current ? (
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-40" />
                  <span className="relative inline-flex size-2 rounded-full bg-accent" />
                </span>
              ) : (
                <span className="text-[11px] font-medium text-faint tabular-nums">{i + 1}</span>
              )}
            </span>
            <span
              className={cx(
                "hidden px-1 text-[12px] leading-tight sm:block",
                current
                  ? "font-semibold text-fg"
                  : done
                    ? "text-muted"
                    : "text-faint",
              )}
            >
              {STATE_LABEL[s]}
            </span>
            {current && <span className="text-[12px] font-semibold sm:hidden">{STATE_LABEL[s]}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ overview */

function Timeline({ d }: { d: TaskDetail }) {
  const items = useMemo(
    () =>
      [
        ...d.transitions.map((t) => ({
          at: t.at,
          kind: "transition" as const,
          state: t.to as string,
          title:
            t.from === t.to
              ? STATE_LABEL[t.to]
              : `${STATE_LABEL[t.from]} → ${STATE_LABEL[t.to]}`,
          body: t.reason,
          actor: t.actor === "system" ? "Tandem" : t.actor === "agent" ? "Copilot" : t.actor === "pm" ? "PM" : "You",
        })),
        ...d.comments.map((c) => ({
          at: c.createdAt,
          kind: "comment" as const,
          state: "",
          title: c.authorName,
          body: c.body,
          actor: c.authorName,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at)),
    [d],
  );
  return (
    <ol className="relative flex flex-col gap-1 before:absolute before:top-3 before:bottom-3 before:left-[13.5px] before:w-px before:bg-line">
      {items.map((it, i) => {
        const tone =
          it.kind === "comment"
            ? "bg-accent text-accent-fg"
            : "bg-surface shadow-[0_0_0_1px_var(--border)]";
        return (
          <li key={i} className="relative grid grid-cols-[28px_1fr] gap-x-3 py-1.5">
            <span aria-hidden className={cx("relative z-[1] mt-px grid size-7 place-items-center rounded-lg ring-4 ring-surface", tone)}>
              {it.kind === "comment" ? <MessageSquareText className="size-3.5" strokeWidth={2} /> : <StatusIcon state={it.state as Task["state"]} className="size-3.5" />}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="font-medium">{it.title}</span>
                <span className="text-[12px] text-faint">
                  {it.kind === "transition" ? `${it.actor} · ` : ""}
                  <time dateTime={it.at} title={new Date(it.at).toLocaleString()}>{relativeTime(it.at)}</time>
                </span>
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed break-words whitespace-pre-line text-muted">
                {it.body}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function RequirementDialog({
  d,
  onClose,
}: {
  d: TaskDetail;
  onClose: () => void;
}) {
  const act = useAct(d.task.id);
  const [req, setReq] = useState(d.task.requirement);
  const [questions, setQuestions] = useState(
    d.task.requirement.openQuestions.join("\n"),
  );
  const save = async (resume: boolean) => {
    await act.mutateAsync({
      path: `/api/tasks/${d.task.id}`,
      method: "PATCH",
      body: {
        requirement: {
          ...req,
          criteria: req.criteria.filter((c) => c.given || c.when || c.then),
          openQuestions: questions
            .split("\n")
            .map((q) => q.trim())
            .filter(Boolean),
        },
      },
    });
    if (resume)
      await act.mutateAsync({
        path: `/api/tasks/${d.task.id}/${d.task.state === "DRAFT" ? "submit" : "resume"}`,
        done: "Checking readiness again.",
      });
    onClose();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Edit the requirement"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button busy={act.isPending} onClick={() => void save(false)}>
            Save
          </Button>
          <Button
            variant="primary"
            busy={act.isPending}
            onClick={() => void save(true)}
          >
            Save and check readiness
          </Button>
        </>
      }
    >
      <Textarea
        label="Goal"
        value={req.goal}
        onChange={(e) => setReq({ ...req, goal: e.target.value })}
      />
      <Input
        label="User story"
        optional
        value={req.userStory}
        onChange={(e) => setReq({ ...req, userStory: e.target.value })}
      />
      <CriteriaEditor
        value={req.criteria}
        onChange={(criteria) => setReq({ ...req, criteria })}
      />
      <Textarea
        label="Example data"
        value={req.exampleData}
        onChange={(e) => setReq({ ...req, exampleData: e.target.value })}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Textarea
          label="Affected areas"
          value={req.affectedAreas}
          onChange={(e) => setReq({ ...req, affectedAreas: e.target.value })}
        />
        <Textarea
          label="Out of scope"
          value={req.outOfScope}
          onChange={(e) => setReq({ ...req, outOfScope: e.target.value })}
        />
      </div>
      <Textarea
        label="Open questions"
        optional
        value={questions}
        onChange={(e) => setQuestions(e.target.value)}
        help="One per line."
      />
    </Dialog>
  );
}

function CopilotCard({ d }: { d: TaskDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const setModel = useMutation({
    mutationFn: (model: string) => put(`/api/tasks/${d.task.id}/model`, { model }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["task", d.task.id] });
      void qc.invalidateQueries({ queryKey: ["thread"] });
    },
    onError: (err) =>
      toast(err instanceof Error ? err.message : String(err), "danger"),
  });
  const credits = d.usage.aiCredits;
  const limit = d.usage.budget.credits.perTask;
  const share = Math.min(100, (credits / limit) * 100);
  const closed = d.task.state === "DONE" || d.task.state === "CANCELLED";
  return (
    <Card title="Copilot">
      <div className="flex flex-col gap-4 text-[13px]">
        <div>
          <p className="mb-1.5 text-[12px] text-muted">Model</p>
          <ModelPicker
            variant="field"
            placement="bottom"
            align="end"
            value={setModel.isPending ? (setModel.variables ?? "") : (d.task.model ?? "")}
            onChange={(m) => setModel.mutate(m)}
            busy={setModel.isPending}
            disabled={closed}
          />
          {!closed && (
            <p className="mt-1.5 text-[12px] text-faint">
              Applies from the next step.
            </p>
          )}
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-[12px] text-muted">AI credits</p>
            <p className="tabular-nums">
              <span className="text-[15px] font-medium">
                {credits < 10 ? credits.toFixed(2) : credits.toFixed(1)}
              </span>{" "}
              <span className="text-[12px] text-faint">of {limit}</span>
            </p>
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="meter"
            aria-label="AI credits used by this task"
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.round(credits * 100) / 100}
          >
            <div
              className={cx(
                "h-full rounded-full transition-[width]",
                share >= 90 ? "bg-warn" : "bg-accent",
              )}
              style={{ width: `${share}%` }}
            />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-[12px] text-muted">Prompts</dt>
            <dd className="text-[15px] font-medium tabular-nums">
              {d.usage.prompts}{" "}
              <span className="text-[12px] font-normal text-faint">
                of {d.usage.budget.perTask}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[12px] text-muted">Model calls</dt>
            <dd className="text-[15px] font-medium tabular-nums">
              {d.usage.modelCalls}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

function Overview({ d }: { d: TaskDetail }) {
  const [editing, setEditing] = useState(false);
  const r = d.task.requirement;
  const canEdit =
    d.task.state === "DRAFT" ||
    (d.task.state === "BLOCKED" &&
      (d.task.blockedReason === "readiness-missing" ||
        d.task.blockedReason === "split-proposed"));
  return (
    <div className="grid gap-6 @3xl:grid-cols-[1fr_300px]">
      <div className="flex flex-col gap-6">
        <Card
          title="Requirement"
          actions={
            canEdit && (
              <Button size="sm" icon={Pencil} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )
          }
        >
          <div className="flex flex-col gap-4 text-[14px]">
            <dl className="flex flex-col gap-4">
              <div>
                <dt className="text-[12px] font-medium text-muted">Goal</dt>
                <dd className="mt-0.5 break-words">
                  {r.goal ? (
                    <InlineText text={r.goal} />
                  ) : (
                    <span className="text-faint">Not set</span>
                  )}
                </dd>
              </div>
              {r.userStory && (
                <div>
                  <dt className="text-[12px] font-medium text-muted">
                    User story
                  </dt>
                  <dd className="mt-0.5 break-words">
                    <InlineText text={r.userStory} />
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[12px] font-medium text-muted">
                  Acceptance criteria
                </dt>
                <dd className="mt-1">
                  {r.criteria.length ? (
                    <ol className="flex flex-col gap-2">
                      {r.criteria.map((c, i) => (
                        <li
                          key={i}
                          className="flex gap-3 rounded-xl bg-surface-2/70 px-3 py-2"
                        >
                          <span className="font-mono text-[12px] text-faint">
                            {i + 1}
                          </span>
                          <span className="min-w-0 break-words">
                            <CriterionText c={c} />
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <span className="text-faint">None yet</span>
                  )}
                </dd>
              </div>
            </dl>
            <dl className="grid gap-4 @xl:grid-cols-3">
              {(
                [
                  ["Example data", r.exampleData],
                  ["Affected areas", r.affectedAreas],
                  ["Out of scope", r.outOfScope],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[12px] font-medium text-muted">{k}</dt>
                  <dd className="mt-0.5 break-words whitespace-pre-line">
                    {v ? (
                      <InlineText text={v} />
                    ) : (
                      <span className="text-faint">Not set</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>
        <Card title="Timeline">
          <Timeline d={d} />
        </Card>
      </div>
      <div className="flex flex-col gap-6">
        <Card title="Definition of Ready">
          <ReadinessChecklist readiness={d.readiness} />
        </Card>
        <CopilotCard d={d} />
        <Card
          title="Branch"
          actions={
            <CopyButton label="Copy" variant="ghost" text={d.task.branch} />
          }
        >
          <p className="truncate font-mono text-[12px]" title={d.task.branch}>
            {d.task.branch}
          </p>
          <p className="mt-2 text-[13px] text-muted">
            {d.repos.map((r) => r.name).join(" · ")}
          </p>
        </Card>
      </div>
      {editing && <RequirementDialog d={d} onClose={() => setEditing(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ spec */

function SpecTab({ d }: { d: TaskDetail }) {
  const act = useAct(d.task.id);
  const [version, setVersion] = useState(String(d.spec?.version ?? ""));
  useEffect(() => {
    setVersion(String(d.spec?.version ?? ""));
  }, [d.spec?.version]);
  const latest = d.spec?.version;
  const shown = useQuery({
    queryKey: ["spec", d.task.id, version],
    queryFn: () =>
      fetchText(`/api/tasks/${d.task.id}/spec/${version}?format=md`),
    enabled: Boolean(version),
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [dialog, setDialog] = useState<"changes" | "pm" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [pm, setPm] = useState({
    name: d.project.pmNames[0] ?? "",
    date: new Date().toISOString().slice(0, 10),
    evidence: "",
  });
  const inReview = d.task.state === "SPEC_REVIEW";
  const editable =
    inReview ||
    (d.task.state === "BLOCKED" && d.task.blockedReason === "spec-invalid");
  if (!d.spec) {
    return RUNNING.has(d.task.state) || d.task.state === "DRAFT" ? (
      <EmptyState
        icon={FileCheck2}
        title="No spec yet"
        body="Tandem drafts the spec once the task passes the readiness and size checks."
      />
    ) : (
      <EmptyState icon={FileCheck2} title="No spec" />
    );
  }
  const owner = d.approvalState?.owner;
  const pmA = d.approvalState?.pm;
  const viewingLatest = version === String(latest);
  return (
    <div className="grid gap-6 @3xl:grid-cols-[1fr_280px]">
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="w-52">
            <Select
              label="Version"
              value={version}
              onChange={setVersion}
              options={[...d.specs]
                .reverse()
                .map((s) => ({
                  value: String(s.version),
                  label: `Version ${s.version}${s.version === latest ? " (current)" : ""}`,
                  description: `${s.source === "edit" ? "Edited" : s.source === "redraft" ? "Redrafted" : "Drafted"} ${relativeTime(s.createdAt)}`,
                }))}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton
              label="Copy as Markdown"
              text={() =>
                fetchText(`/api/tasks/${d.task.id}/spec/${version}?format=md`)
              }
            />
            <LinkButton
              to={`/api/tasks/${d.task.id}/spec/${version}?format=pdf`}
              download
              size="sm"
              icon={Download}
            >
              Export as PDF
            </LinkButton>
            {editable && viewingLatest && !editing && (
              <Button
                size="sm"
                icon={Pencil}
                onClick={() => {
                  setDraft(d.spec!.markdown);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
          </div>
        </div>
        {d.specCheck &&
          viewingLatest &&
          (d.specCheck.problems.length > 0 ||
            d.specCheck.openQuestions.length > 0) && (
            <div className="mb-4">
              <Callout
                tone="warn"
                title={
                  d.specCheck.openQuestions.length
                    ? "Open questions must be answered before approval"
                    : "The spec needs fixes before approval"
                }
              >
                {[
                  ...d.specCheck.openQuestions.map((q) => `• ${q}`),
                  ...d.specCheck.problems.map((p) => `• ${p}`),
                ].join("\n")}
              </Callout>
            </div>
          )}
        {editing ? (
          <div className="flex flex-col gap-3">
            <Textarea
              label="Spec (Markdown)"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[560px] font-mono text-[13px]"
              help="Saving creates a new version. Approvals for earlier versions stop counting."
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button
                variant="primary"
                busy={act.isPending}
                onClick={() =>
                  act.mutate(
                    {
                      path: `/api/tasks/${d.task.id}/spec`,
                      method: "PUT",
                      body: { markdown: draft },
                      done: "Saved a new spec version. Approvals reset.",
                    },
                    { onSuccess: () => setEditing(false) },
                  )
                }
              >
                Save new version
              </Button>
            </div>
          </div>
        ) : (
          <Card>
            {shown.isLoading ? (
              <Loading rows={6} />
            ) : shown.isError ? (
              <ErrorState error={shown.error} />
            ) : (
              <Markdown source={shown.data ?? ""} />
            )}
          </Card>
        )}
      </div>
      <aside className="flex h-fit flex-col gap-4 @3xl:sticky @3xl:top-6">
        <Card
          title="Approvals"
          description={`For version ${latest}. Both keys are needed before any code is written.`}
        >
          <ul className="flex flex-col gap-3">
            {[
              { role: "Owner", what: "the how", a: owner, need: true },
              {
                role: "PM",
                what: "the what",
                a: pmA,
                need: d.project.pmGate !== "off",
              },
            ].map((k) => (
              <li key={k.role} className="flex items-start gap-3">
                {k.a ? (
                  <CheckCircle2 aria-hidden className="mt-0.5 size-4 text-ok" />
                ) : k.need ? (
                  <Circle aria-hidden className="mt-0.5 size-4 text-faint" />
                ) : (
                  <Ban aria-hidden className="mt-0.5 size-4 text-faint" />
                )}
                <div className="min-w-0 text-[13px]">
                  <p className="font-medium">
                    {k.role}{" "}
                    <span className="font-normal text-muted">· {k.what}</span>
                  </p>
                  <p className="text-[13px] break-words text-muted">
                    {k.a
                      ? `${k.a.name}, ${k.a.date.slice(0, 10)}${k.a.evidence ? ` · ${k.a.evidence}` : ""}`
                      : k.need
                        ? "Waiting"
                        : "Not required for this project"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {inReview && (
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              {!owner && (
                <Button
                  variant="primary"
                  icon={ThumbsUp}
                  busy={act.isPending}
                  disabled={
                    !d.specCheck?.valid ||
                    (d.specCheck?.openQuestions.length ?? 0) > 0
                  }
                  onClick={() =>
                    act.mutate({
                      path: `/api/tasks/${d.task.id}/approve`,
                      done: "Approved.",
                    })
                  }
                >
                  Approve spec
                </Button>
              )}
              {d.project.pmGate === "tandem" && !pmA && (
                <Button icon={FileCheck2} onClick={() => setDialog("pm")}>
                  Record PM approval
                </Button>
              )}
              {d.project.pmGate === "jira" && !pmA && (
                <p className="text-[13px] text-muted">
                  Waiting for a PM to reply “approve” on the Jira issue.
                </p>
              )}
              <Button icon={Undo2} onClick={() => setDialog("changes")}>
                Request changes
              </Button>
            </div>
          )}
        </Card>
      </aside>
      <Dialog
        open={dialog === "changes"}
        onClose={() => setDialog(null)}
        title="Request changes"
        description="Tandem redrafts the spec with your feedback. The new version needs approval again."
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!feedback.trim()}
              busy={act.isPending}
              onClick={() =>
                act.mutate(
                  {
                    path: `/api/tasks/${d.task.id}/request-changes`,
                    body: { feedback },
                    done: "Redrafting the spec.",
                  },
                  { onSuccess: () => (setDialog(null), setFeedback("")) },
                )
              }
            >
              Redraft spec
            </Button>
          </>
        }
      >
        <Textarea
          label="What should change?"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          autoFocus
          placeholder="Also return the app version from /health."
        />
      </Dialog>
      <Dialog
        open={dialog === "pm"}
        onClose={() => setDialog(null)}
        title="Record PM approval"
        description={`Share the spec (Copy as Markdown or Export as PDF), then record where the PM approved version ${latest}.`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!pm.name.trim() || !pm.evidence.trim()}
              busy={act.isPending}
              onClick={() =>
                act.mutate(
                  {
                    path: `/api/tasks/${d.task.id}/pm-approval`,
                    body: { ...pm, date: new Date(pm.date).toISOString() },
                    done: "PM approval recorded.",
                  },
                  { onSuccess: () => setDialog(null) },
                )
              }
            >
              Record approval
            </Button>
          </>
        }
      >
        {d.project.pmNames.length > 0 ? (
          <Select
            label="PM"
            value={pm.name}
            onChange={(name) => setPm({ ...pm, name })}
            options={d.project.pmNames.map((n) => ({ value: n, label: n }))}
          />
        ) : (
          <Input
            label="PM name"
            value={pm.name}
            onChange={(e) => setPm({ ...pm, name: e.target.value })}
          />
        )}
        <Input
          label="Date"
          type="date"
          value={pm.date}
          onChange={(e) => setPm({ ...pm, date: e.target.value })}
        />
        <Textarea
          label="Evidence"
          value={pm.evidence}
          onChange={(e) => setPm({ ...pm, evidence: e.target.value })}
          placeholder="Link to the message, or a note: “Approved in the planning call on 3 Nov”"
        />
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ changes */

function ChangesTab({ d }: { d: TaskDetail }) {
  const diffs = useQuery({
    queryKey: ["diff", d.task.id, d.task.updatedAt],
    queryFn: () => api<RepoDiff[]>(`/api/tasks/${d.task.id}/diff`),
  });
  if (diffs.isLoading) return <Loading rows={4} />;
  if (diffs.isError)
    return (
      <ErrorState error={diffs.error} retry={() => void diffs.refetch()} />
    );
  if (!diffs.data?.some((x) => x.diff.trim()))
    return (
      <EmptyState
        icon={GitPullRequest}
        title="No changes yet"
        body="The diff appears here once Copilot starts building on the task branch."
      />
    );
  return (
    <div className="flex flex-col gap-8">
      {diffs.data.map((r) => (
        <Section key={r.repoId} title={r.name} description={r.branch}>
          <DiffView diff={r.diff} />
        </Section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ checks */

function CommandRow({ r }: { r: CommandResult }) {
  const ok = r.exitCode === 0 && !r.timedOut;
  const [open, setOpen] = useState(!ok);
  return (
    <li className="py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 text-left text-[13px]"
      >
        {ok ? (
          <CheckCircle2 aria-hidden className="size-4 shrink-0 text-ok" />
        ) : (
          <XCircle aria-hidden className="size-4 shrink-0 text-danger" />
        )}
        <span className="w-24 shrink-0 font-medium">{r.kind}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
          {r.command}
        </code>
        <span className="text-[12px] text-faint tabular-nums">
          {r.timedOut ? "timed out" : `${(r.durationMs / 1000).toFixed(1)} s`}
        </span>
      </button>
      {open && r.outputTail.trim() && (
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
          {r.outputTail.trim()}
        </pre>
      )}
    </li>
  );
}

function ChecksTab({ d }: { d: TaskDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const last = d.verifyRuns.at(-1);
  const verified = d.verifyRuns.length > 0;
  const repoName = (id?: string) =>
    d.repos.find((r) => r.id === id)?.name ?? "project";
  const toRule = useMutation({
    mutationFn: (f: ReviewFinding) =>
      post("/api/rules", {
        repoId: f.repoId ?? d.repos[0]?.id,
        text: `${f.title}: ${f.detail.split("\n")[0]}`,
        source: `Self-review finding on ${d.task.key}`,
      }),
    onSuccess: () => {
      toast("Saved as a rule for the next task branch.", "ok");
      void qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <Card title="Acceptance criteria and tests" padded={false}>
        {d.task.requirement.criteria.length === 0 ? (
          <p className="p-5 text-[13px] text-muted">No criteria.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-5 py-2.5 font-medium">Criterion</th>
                <th className="px-5 py-2.5 font-medium">Test</th>
                <th className="w-28 px-5 py-2.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.task.requirement.criteria.map((c, i) => {
                const tests = d.tests.filter((t) => t.criterion === i + 1);
                const result =
                  tests.length === 0
                    ? verified
                      ? "none"
                      : "not-run"
                    : tests.some((t) => t.result === "fail")
                      ? "fail"
                      : tests.every((t) => t.result === "pass")
                        ? "pass"
                        : "not-run";
                return (
                  <tr key={i} className="align-top">
                    <td className="px-5 py-3">
                      <span className="mr-2 font-mono text-[12px] text-faint">
                        {i + 1}
                      </span>
                      <CriterionText c={c} keywordClass="" />
                    </td>
                    <td className="px-5 py-3">
                      {tests.length ? (
                        tests.map((t) => (
                          <p
                            key={`${t.repoId}${t.file}${t.name}`}
                            className="font-mono text-[12px]"
                          >
                            <span className="text-muted">
                              {repoName(t.repoId)}/
                            </span>
                            {t.file}{" "}
                            <span className="text-muted">› {t.name}</span>
                            {t.scope === "suite" && (
                              <span className="text-faint"> (suite)</span>
                            )}
                          </p>
                        ))
                      ) : (
                        <span className="text-faint">
                          {verified
                            ? "No test recorded"
                            : "Recorded during the build"}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Pill
                        tone={
                          result === "pass"
                            ? "ok"
                            : result === "fail"
                              ? "danger"
                              : result === "none"
                                ? "warn"
                                : "neutral"
                        }
                      >
                        {result === "pass"
                          ? "Pass"
                          : result === "fail"
                            ? "Fail"
                            : result === "none"
                              ? "Missing"
                              : "Pending"}
                      </Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <Card
        title="Verification"
        description={
          last
            ? `Run ${d.verifyRuns.length} · ${relativeTime(last.createdAt)} · run by Tandem, not the agent`
            : undefined
        }
        actions={
          last && (
            <Pill tone={last.passed ? "ok" : "danger"} dot>
              {last.passed ? "All checks pass" : "Failing"}
            </Pill>
          )
        }
      >
        {!last ? (
          <p className="text-[13px] text-muted">
            Tandem runs each repo's install, lint, type-check, build and test
            commands after the build.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {[...new Set(last.results.map((r) => r.repoId ?? ""))].map(
              (repoId) => (
                <div key={repoId}>
                  {d.repos.length > 1 && (
                    <p className="mb-1 text-[12px] font-semibold tracking-wide text-faint uppercase">
                      {repoName(repoId)}
                    </p>
                  )}
                  <ul className="-my-2.5 divide-y divide-line">
                    {last.results
                      .filter((r) => (r.repoId ?? "") === repoId)
                      .map((r, i) => (
                        <CommandRow key={i} r={r} />
                      ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
      </Card>
      <Card
        title="Self-review"
        description="A separate read-only review against the spec, the criteria, your repo rules and a security checklist."
      >
        {d.findings.length === 0 ? (
          <p className="text-[13px] text-muted">
            {d.task.progress.reviewed
              ? "No findings."
              : "Runs after verification."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {d.findings.map((f) => (
              <li key={f.id} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill
                    tone={
                      f.severity === "high"
                        ? "danger"
                        : f.severity === "medium"
                          ? "warn"
                          : "neutral"
                    }
                  >
                    {f.severity}
                  </Pill>
                  <Pill>{f.category}</Pill>
                  <span className="text-[13.5px] font-medium">{f.title}</span>
                  <span className="ml-auto">
                    <Pill
                      tone={
                        f.status === "fixed"
                          ? "ok"
                          : f.status === "dismissed"
                            ? "neutral"
                            : "accent"
                      }
                    >
                      {f.status === "open"
                        ? "Open"
                        : f.status === "fixed"
                          ? "Fixed"
                          : "Dismissed"}
                    </Pill>
                  </span>
                </div>
                {f.file && (
                  <p className="mt-1 font-mono text-[12px] text-muted">
                    {repoName(f.repoId)}/{f.file}
                    {f.line ? `:${f.line}` : ""}
                  </p>
                )}
                <p className="mt-1 text-[13px] whitespace-pre-line text-muted">
                  {f.detail}
                </p>
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={ShieldAlert}
                    busy={toRule.isPending && toRule.variables?.id === f.id}
                    onClick={() => toRule.mutate(f)}
                  >
                    Turn into a rule
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ pull requests */

function PrCard({
  pr,
  repoName,
  taskId,
  host,
}: {
  pr: PullRequest;
  repoName: string;
  taskId: string;
  host?: "codecommit" | "github";
}) {
  const act = useAct(taskId);
  const [url, setUrl] = useState("");
  const tone =
    pr.status === "merged"
      ? "ok"
      : pr.status === "closed"
        ? "neutral"
        : pr.status === "manual-pending"
          ? "warn"
          : "accent";
  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          {host ? (
            <BrandLogo brand={hostBrand(host)} size={17} title={host === "github" ? "GitHub" : "AWS CodeCommit"} />
          ) : (
            <GitPullRequest aria-hidden className="size-4 text-faint" />
          )}
          <span className="text-[14px] font-semibold">{repoName}</span>
        </div>
      }
      description={pr.title}
      actions={
        <Pill tone={tone} dot>
          {pr.status === "manual-pending"
            ? "Create it from the link"
            : pr.status === "open"
              ? "Open"
              : pr.status === "merged"
                ? "Merged"
                : "Closed"}
        </Pill>
      }
    >
      {pr.manual && pr.status === "manual-pending" ? (
        <div className="flex flex-col gap-4">
          <Callout tone="warn" title="Open the pull request yourself">
            Your AWS profile can't create pull requests, so Tandem prepared one:
            open the link (the branches are preselected), paste the title and
            description, then paste the new PR's link below.
          </Callout>
          <div className="flex flex-wrap gap-2">
            <LinkButton
              to={pr.url}
              external
              size="sm"
              variant="primary"
              icon={ExternalLink}
            >
              Open create page
            </LinkButton>
            <CopyButton label="Copy title" text={pr.title} />
            <CopyButton label="Copy description" text={pr.description} />
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({
                path: `/api/prs/${pr.id}/url`,
                method: "PUT",
                body: { url },
                done: "Tandem will follow this pull request.",
              });
            }}
          >
            <div className="flex-1">
              <Input
                label="Link to the new pull request"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/pull-requests/12/details"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={!url.trim()}
              busy={act.isPending}
            >
              Save link
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <LinkButton to={pr.url} external size="sm" icon={ExternalLink}>
            Open pull request
          </LinkButton>
          <CopyButton label="Copy description" text={pr.description} />
          {pr.status === "open" && (
            <Button
              size="sm"
              variant="ghost"
              icon={GitMerge}
              busy={act.isPending}
              onClick={() =>
                act.mutate({
                  path: `/api/prs/${pr.id}/merged`,
                  done: "Marked as merged.",
                })
              }
            >
              Mark as merged
            </Button>
          )}
        </div>
      )}
      <PrSyncNote pr={pr} taskId={taskId} />
    </Card>
  );
}

/** Where the PR stands against its base branch, from Tandem's last check while it waits for review. */
function PrSyncNote({ pr, taskId }: { pr: PullRequest; taskId: string }) {
  const act = useAct(taskId);
  const s = pr.sync;
  if (!s || pr.status === "merged" || pr.status === "closed") return null;
  if (s.state === "up-to-date" || s.state === "mergeable")
    return (
      <p className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-[13px] text-muted">
        <CheckCircle2 aria-hidden className="size-3.5 text-ok" />
        {s.state === "up-to-date" ? s.message : "Merges cleanly into the latest base branch."}
        <span className="text-faint">· checked {relativeTime(s.at)}</span>
      </p>
    );
  const title = {
    updated: "Updated from the base branch",
    "needs-person": "Conflicts with the base branch",
    unresolved: "Conflicts Tandem could not resolve",
    "checks-failed": "Conflict fix failed the checks",
    "branch-rewritten": "Branch rewritten by someone else",
  }[s.state];
  const canFix = s.state === "needs-person" || s.state === "unresolved" || s.state === "checks-failed";
  return (
    <div className="mt-4">
      <Callout
        tone={s.state === "updated" ? "ok" : s.state === "branch-rewritten" ? "neutral" : "warn"}
        title={title}
        {...(canFix
          ? {
              actions: (
                <Button
                  size="sm"
                  variant="primary"
                  icon={GitMerge}
                  busy={act.isPending}
                  onClick={() =>
                    act.mutate({
                      path: `/api/tasks/${taskId}/fix-conflicts`,
                      done: "Tandem is merging the base branch in and resolving the conflicts.",
                    })
                  }
                >
                  Fix conflicts
                </Button>
              ),
            }
          : {})}
      >
        {s.message}
        {s.files.length > 0 && s.state !== "updated" && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {s.files.map((f) => (
              <code key={f} className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[12px]">
                {f}
              </code>
            ))}
          </span>
        )}
      </Callout>
    </div>
  );
}

function PrsTab({ d }: { d: TaskDetail }) {
  if (!d.prs.length)
    return (
      <EmptyState
        icon={GitPullRequest}
        title="No pull requests yet"
        body="Tandem opens one per repository after verification, self-review and a rebase onto the latest default branch. While they wait for review, Tandem keeps them mergeable."
      />
    );
  return (
    <div className="flex flex-col gap-4">
      {d.task.needsAttention && (
        <Callout tone="warn" title="Needs attention">
          {d.task.attentionNotes.map((n) => `• ${n}`).join("\n")}
        </Callout>
      )}
      {d.prs.map((pr) => (
        <PrCard
          key={pr.id}
          pr={pr}
          taskId={d.task.id}
          repoName={d.repos.find((r) => r.id === pr.repoId)?.name ?? "repo"}
          {...(d.repos.find((r) => r.id === pr.repoId)
            ? { host: d.repos.find((r) => r.id === pr.repoId)!.host.kind }
            : {})}
        />
      ))}
      <p className="text-[12px] text-faint">
        Agents never merge. When every pull request is merged, Tandem marks the
        task done and cleans up.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ chat */

function ChatTab({ d }: { d: TaskDetail }) {
  const thread = useQuery({
    queryKey: ["task-thread", d.task.id],
    queryFn: () => api<{ id: string }>(`/api/tasks/${d.task.id}/thread`),
  });
  if (thread.isLoading) return <Loading />;
  if (thread.isError || !thread.data)
    return <ErrorState error={thread.error} />;
  return (
    <ThreadPanel
      threadId={thread.data.id}
      repos={d.repos}
      placeholder="Why did the test fail? Can the endpoint also return the version?"
      compact
      task={{ id: d.task.id, state: d.task.state, needsAttention: d.task.needsAttention }}
    />
  );
}

/* ------------------------------------------------------------------ status banner and screen */

/** Under a stuck task's message: tell Copilot how to go on, or talk it through in the chat first. */
function HelpCopilot({ taskId, fixing, onOpenChat }: { taskId: string; fixing?: boolean; onOpenChat: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const go = useMutation({
    mutationFn: () => post<{ action: string }>(`/api/tasks/${taskId}/continue`, { text }),
    onSuccess: (r) => {
      setText("");
      toast(r.action === "fixing" ? "Copilot is fixing the checks with your guidance." : "Continuing with your guidance.", "ok");
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["thread"] });
    },
    onError: (err) => toast(err instanceof Error ? err.message : String(err), "danger"),
  });
  return (
    <div className="mt-3 rounded-xl bg-surface p-2 whitespace-normal shadow-[0_0_0_1px_var(--border)]">
      <label htmlFor={`help-${taskId}`} className="sr-only">
        Tell Copilot how to continue
      </label>
      <textarea
        id={`help-${taskId}`}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={fixing ? "Tell Copilot how to fix it. For example: the test expects UTC dates, so use UTC everywhere." : "Tell Copilot how to continue. For example: keep our version of the header and add theirs below it."}
        className="block w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" icon={MessageSquareText} onClick={onOpenChat}>
          Ask Copilot first
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim()} busy={go.isPending} onClick={() => go.mutate()}>
          Continue with this
        </Button>
      </div>
    </div>
  );
}

function StatusBanner({
  d,
  onOpenSpec,
  onOpenChat,
  inChat,
}: {
  d: TaskDetail;
  onOpenSpec: () => void;
  onOpenChat: () => void;
  /** The chat tab is open: its composer is where to answer, so the banner doesn't repeat it. */
  inChat: boolean;
}) {
  const act = useAct(d.task.id);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const t = d.task;
  if (t.state === "BLOCKED" && t.blockedReason === "split-proposed") {
    return (
      <>
        <Callout
          tone="warn"
          title="This is too big for one reviewable change"
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                icon={Scissors}
                busy={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: `/api/tasks/${t.id}/accept-split`,
                    done: "Split into smaller tasks.",
                  })
                }
              >
                Accept the split
              </Button>
              <Button size="sm" onClick={() => setOverride(true)}>
                Keep as one task
              </Button>
            </>
          }
        >
          {t.blockedMessage}
        </Callout>
        <Dialog
          open={override}
          onClose={() => setOverride(false)}
          title="Keep as one task"
          footer={
            <>
              <Button onClick={() => setOverride(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!reason.trim()}
                busy={act.isPending}
                onClick={() =>
                  act.mutate(
                    {
                      path: `/api/tasks/${t.id}/override-split`,
                      body: { reason },
                      done: "Continuing as one task.",
                    },
                    { onSuccess: () => setOverride(false) },
                  )
                }
              >
                Continue
              </Button>
            </>
          }
        >
          <Textarea
            label="Why should this stay one change?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </Dialog>
      </>
    );
  }
  if (t.state === "BLOCKED" || t.state === "FAILED") {
    const title =
      t.state === "FAILED"
        ? "Something failed"
        : t.blockedReason === "readiness-missing"
          ? "Not ready yet"
          : t.blockedReason === "budget-reached"
            ? "Copilot limit reached"
            : t.blockedReason === "disk-low"
              ? "Low disk space"
              : t.blockedReason === "rebase-conflict"
                ? "Rebase conflict"
                : "Waiting for you";
    return (
      <Callout
        tone={t.state === "FAILED" ? "danger" : "warn"}
        title={title}
        actions={
          t.blockedReason !== "readiness-missing" && (
            <>
              {t.blockedReason === "budget-reached" && (
                <LinkButton size="sm" to="/settings">
                  Open Settings
                </LinkButton>
              )}
              <Button
                size="sm"
                variant="primary"
                icon={RotateCcw}
                busy={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: `/api/tasks/${t.id}/resume`,
                    done: "Retrying.",
                  })
                }
              >
                {t.state === "FAILED" ? "Retry" : "Resume"}
              </Button>
            </>
          )
        }
      >
        {t.blockedMessage}
        {t.blockedReason === "readiness-missing" &&
          "\n\nEdit the requirement in the Overview, then check readiness again."}
        {!inChat && t.blockedReason !== "readiness-missing" && t.blockedReason !== "budget-reached" && t.blockedReason !== "disk-low" && (
          <HelpCopilot taskId={t.id} onOpenChat={onOpenChat} />
        )}
      </Callout>
    );
  }
  if (t.needsAttention && t.state !== "DONE") {
    return (
      <Callout tone="warn" title="Needs attention">
        {t.attentionNotes.map((n) => `• ${n}`).join("\n")}
        {!inChat && t.state === "PR_OPEN" && <HelpCopilot taskId={t.id} fixing onOpenChat={onOpenChat} />}
      </Callout>
    );
  }
  if (t.state === "SPEC_REVIEW") {
    return (
      <Callout
        tone="accent"
        title="Your review is needed"
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={FileCheck2}
            onClick={onOpenSpec}
          >
            Read the spec
          </Button>
        }
      >
        The spec is ready. Approve it or request changes. No code is written
        before approval.
      </Callout>
    );
  }
  return null;
}

type View = "chat" | "details";
const VIEW_KEY = "tandem.taskView";
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === "details" ? "details" : "chat";
  } catch {
    return "chat";
  }
};

/** Chat (the task as a conversation) or Details (the tabs). */
function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  return (
    <div role="group" aria-label="Task view" className="flex items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
      {(
        [
          ["chat", "Chat", MessagesSquare],
          ["details", "Details", LayoutList],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cx(
            "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-[background-color,color,box-shadow] duration-150",
            value === id ? "bg-surface font-medium text-fg shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.06)]" : "text-muted hover:text-fg",
          )}
        >
          <Icon aria-hidden className="size-3.5" strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}

/** What to show beside the conversation when a task opens: whatever needs looking at now. */
function defaultPanel(d: TaskDetail): PanelTab | null {
  const t = d.task;
  if (t.state === "SPEC_REVIEW") return "spec";
  if (!window.matchMedia?.("(min-width: 1280px)").matches) return null;
  if (t.state === "PR_OPEN" || (t.state === "DONE" && d.prs.length)) return "prs";
  if (d.verifyRuns.at(-1)?.passed === false) return "checks";
  if (t.state === "BUILDING" || t.state === "VERIFYING" || t.state === "SELF_REVIEW") return "changes";
  return "overview";
}

export function TaskDetailScreen({ id }: { id: string }) {
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const act = useAct(id);
  const [tab, setTab] = useState<Tab>("overview");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const q = useQuery({
    queryKey: ["task", id],
    queryFn: () => api<TaskDetail>(`/api/tasks/${id}`),
    refetchInterval: (query) =>
      query.state.data && RUNNING.has(query.state.data.task.state)
        ? 4_000
        : 20_000,
  });
  // A task that is already waiting for review opens on its spec (once per task, not on every refresh).
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data || openedOn.current === q.data.task.id) return;
    openedOn.current = q.data.task.id;
    if (q.data.task.state === "SPEC_REVIEW") setTab("spec");
    setPanel(defaultPanel(q.data));
  }, [q.data]);
  // When the task reaches a point that needs you, show that part beside the conversation (unless the
  // panel was closed): the spec to review, failing checks, the pull requests.
  const seenState = useRef<string | null>(null);
  const state = q.data?.task.state;
  const failing = q.data?.verifyRuns.at(-1)?.passed === false;
  useEffect(() => {
    if (!state) return;
    const before = seenState.current;
    seenState.current = state;
    if (!before || before === state) return;
    const next: PanelTab | null = state === "SPEC_REVIEW" ? "spec" : state === "PR_OPEN" ? "prs" : failing && state === "BUILDING" ? "checks" : null;
    if (next) setPanel((p) => (p === null ? p : next));
  }, [state, failing]);
  if (q.isLoading) return <Loading rows={5} />;
  if (q.isError || !q.data)
    return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const t = d.task;
  const finished = t.state === "DONE" || t.state === "CANCELLED";
  const openFindings = d.findings.filter((f) => f.status === "open").length;
  const lastVerify = d.verifyRuns.at(-1);
  const tabDefs: Array<{ id: Tab; label: string; badge?: ReactNode }> = [
          { id: "overview", label: "Overview" },
          { id: "activity", label: "Activity", ...(d.running ? { badge: <span aria-label="Copilot is working" className="size-1.5 animate-pulse rounded-full bg-ok" /> } : {}) },
          {
            id: "spec",
            label: "Spec",
            ...(d.spec
              ? {
                  badge: (
                    <span className="text-[12px] text-faint">
                      v{d.spec.version}
                    </span>
                  ),
                }
              : {}),
          },
          { id: "changes", label: "Changes" },
          {
            id: "checks",
            label: "Checks",
            ...(lastVerify
              ? {
                  badge: lastVerify.passed ? (
                    <CheckCircle2
                      aria-label="passing"
                      className="size-3.5 text-ok"
                    />
                  ) : (
                    <AlertTriangle
                      aria-label="failing"
                      className="size-3.5 text-warn"
                    />
                  ),
                }
              : openFindings
                ? {
                    badge: (
                      <span className="text-[12px] text-warn">
                        {openFindings}
                      </span>
                    ),
                  }
                : {}),
          },
          {
            id: "prs",
            label: "Pull requests",
            ...(d.prs.length
              ? {
                  badge: (
                    <span className="text-[12px] text-faint">
                      {d.prs.length}
                    </span>
                  ),
                }
              : {}),
          },
          { id: "trace", label: "Trace" },
          { id: "chat", label: "Chat" },
        ];
  const panelTabs = tabDefs.filter((x): x is { id: PanelTab; label: string; badge?: ReactNode } => x.id !== "activity" && x.id !== "chat");
  const renderTab = (id: Tab) => (
    <>
      {id === "overview" && <Overview d={d} />}
      {id === "activity" && <TaskActivity taskId={d.task.id} />}
      {id === "spec" && <SpecTab d={d} />}
      {id === "changes" && <ChangesTab d={d} />}
      {id === "checks" && <ChecksTab d={d} />}
      {id === "prs" && <PrsTab d={d} />}
      {id === "trace" && <TraceTab taskId={d.task.id} />}
      {id === "chat" && <ChatTab d={d} />}
    </>
  );
  return (
    <div>
      <Link
        to="/tasks"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
      >
        <ArrowLeft aria-hidden className="size-3.5" /> Tasks
      </Link>
      <PageHeader
        eyebrow={
          <>
            <span className="font-mono">{t.key}</span>
            <span aria-hidden>·</span>
            <span>{d.project.name}</span>
            <span aria-hidden>·</span>
            <span>
              {t.source === "chat"
                ? "From chat"
                : t.source === "jira"
                  ? "From Jira"
                  : t.source === "split"
                    ? "Split task"
                    : "Created in Tandem"}
            </span>
          </>
        }
        title={t.title}
        actions={
          <>
            <ViewSwitch value={view} onChange={setView} />
            <Pill tone={STATE_TONE[t.state]}>
              <StatusIcon state={t.state} className="size-3.5" />
              {STATE_LABEL[t.state]}
              {RUNNING.has(t.state) && t.step ? ` · ${stepLabel(t.step)}` : ""}
            </Pill>
            {t.state === "DRAFT" && (
              <Button
                variant="primary"
                icon={Sparkles}
                busy={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: `/api/tasks/${t.id}/submit`,
                    done: "Checking readiness.",
                  })
                }
              >
                Check readiness
              </Button>
            )}
            {!finished && (
              <Button
                variant="danger"
                icon={Ban}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel task
              </Button>
            )}
          </>
        }
      />
      {view === "details" ? (
        <>
          <ProgressRail task={t} />
          <div className="mb-6 empty:hidden">
            <StatusBanner d={d} onOpenSpec={() => setTab("spec")} onOpenChat={() => setTab("chat")} inChat={tab === "chat"} />
          </div>
          <Tabs
            label="Task sections"
            value={tab}
            onChange={setTab}
            tabs={tabDefs}
          />
          <TabPanel id={tab}>
            <div className="@container">{renderTab(tab)}</div>
          </TabPanel>
        </>
      ) : (
        <TaskChatView
          d={d}
          panel={panel}
          setPanel={setPanel}
          tabs={panelTabs}
          renderPanel={(id) => (
            <>
              {id === "overview" && (
                <div className="mb-6">
                  <ProgressRail task={t} />
                </div>
              )}
              {renderTab(id)}
            </>
          )}
          banner={<StatusBanner d={d} onOpenSpec={() => setPanel("spec")} onOpenChat={() => undefined} inChat />}
        />
      )}
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={`Cancel ${t.key}?`}
        description="Tandem stops the work and removes the task folder. Pushed branches and opened pull requests stay as they are."
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>
              Keep working
            </Button>
            <Button
              variant="danger"
              icon={Ban}
              busy={act.isPending}
              onClick={() =>
                act.mutate(
                  {
                    path: `/api/tasks/${t.id}/cancel`,
                    done: `${t.key} cancelled.`,
                  },
                  { onSuccess: () => setConfirmCancel(false) },
                )
              }
            >
              Cancel task
            </Button>
          </>
        }
      >
      </Dialog>
    </div>
  );
}
