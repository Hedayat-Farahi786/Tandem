import { useEffect, useRef, useState, type ReactNode } from "react";
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
  GitPullRequest,
  Pencil,
  RotateCcw,
  Scissors,
  Sparkles,
  PanelRight,
  ThumbsUp,
  Undo2,
} from "lucide-react";
import type {
  PullRequest,
} from "@tandem/shared";
import { api, fetchText, patch, post, put } from "../lib/api";
import { ModelPicker } from "../ui/model-picker";
import { CriterionText, InlineText } from "../ui/text";
import {
  STATE_LABEL,
  STATE_TONE,
  relativeTime,
  stepLabel,
  plainReason,
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
  IconButton,
  ErrorState,
  Input,
  Loading,
  Markdown,
  Pill,
  Section,
  Select,
  Textarea,
  cx,
  useToast,
} from "../ui/kit";
import { CriteriaEditor, ReadinessChecklist } from "./Tasks";
import { TraceTab } from "./Trace";
import { TaskChatView, type PanelTab } from "./TaskChat";
import { ChecksTab } from "./ChecksPanel";
import { StatusIcon } from "../ui/visual";
import { BrandLogo, hostBrand } from "../ui/brands";

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


/* ------------------------------------------------------------------ overview */


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


/* ------------------------------------------------------------------ status banner and screen */


function StatusBanner({
  d,
  onOpenSpec,
}: {
  d: TaskDetail;
  onOpenSpec: () => void;
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
          {t.blockedMessage ? plainReason(t.blockedMessage) : null}
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
        {t.blockedMessage ? plainReason(t.blockedMessage) : null}
        {t.blockedReason === "readiness-missing" &&
          "\n\nEdit the requirement in the Overview, then check readiness again."}
      </Callout>
    );
  }
  if (t.needsAttention && t.state !== "DONE") {
    return (
      <Callout tone="warn" title="Needs attention">
        {t.attentionNotes.map((n) => `• ${n}`).join("\n")}
      </Callout>
    );
  }
  if (t.state === "DRAFT") {
    return (
      <Callout
        tone="accent"
        title="Saved, not started yet"
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={Sparkles}
            busy={act.isPending}
            onClick={() =>
              act.mutate({
                path: `/api/tasks/${t.id}/submit`,
                done: "Started: checking readiness, then drafting the spec.",
              })
            }
          >
            Start task
          </Button>
        }
      >
        Nothing runs until you start it. Edit the requirement in Overview first if
        you like; starting checks it is ready, then Copilot drafts the spec.
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
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const act = useAct(id);
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
  const tabDefs: Array<{ id: PanelTab; label: string; badge?: ReactNode }> = [
          { id: "overview", label: "Overview" },
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
        ];
  const renderTab = (id: PanelTab) => (
    <>
      {id === "overview" && <Overview d={d} />}
      {id === "spec" && <SpecTab d={d} />}
      {id === "changes" && <ChangesTab d={d} />}
      {id === "checks" && <ChecksTab d={d} />}
      {id === "prs" && <PrsTab d={d} />}
      {id === "trace" && <TraceTab taskId={d.task.id} />}
    </>
  );
  const statusPill = (
    <Pill tone={STATE_TONE[t.state]}>
      <StatusIcon state={t.state} className="size-3.5" />
      {STATE_LABEL[t.state]}
      {RUNNING.has(t.state) && t.step ? ` · ${stepLabel(t.step)}` : ""}
    </Pill>
  );
  const startTask = () =>
    act.mutate({
      path: `/api/tasks/${t.id}/submit`,
      done: "Started: checking readiness, then drafting the spec.",
    });
  const flowAt = Math.max(0, FLOW.indexOf((t.state === "BLOCKED" || t.state === "FAILED" ? (t.resumeTo?.state ?? "READINESS") : t.state) as (typeof FLOW)[number]));
  return (
    // Chat view: an app-style page on wide screens. One compact bar, then the conversation and the
    // details side by side, each scrolling on its own, so nothing needs the whole page to scroll.
    <div data-layout="app" className="flex flex-col lg:h-[calc(100dvh-16px)]">
          <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pb-3 lg:h-14 lg:flex-nowrap lg:border-b lg:border-line lg:px-4 lg:pb-0">
            <Link to="/tasks" aria-label="Back to Tasks" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <ArrowLeft aria-hidden className="size-4" />
            </Link>
            <div className="min-w-0 flex-1 basis-60">
              <p className="flex min-w-0 items-center gap-1.5 text-[12px] leading-tight text-faint">
                <span className="font-mono">{t.key}</span>
                <span aria-hidden>·</span>
                <span className="truncate">{d.project.name}</span>
              </p>
              <h1 className="truncate text-[15px] leading-snug font-semibold tracking-[-0.01em]" title={t.title}>
                {t.title}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {statusPill}
              {t.state === "DRAFT" && (
                <Button size="sm" variant="primary" icon={Sparkles} busy={act.isPending} onClick={startTask}>
                  Start task
                </Button>
              )}
              <IconButton icon={PanelRight} label={panel ? "Hide details" : "Show details"} aria-pressed={Boolean(panel)} onClick={() => setPanel(panel ? null : (defaultPanel(d) ?? "overview"))} />
              {!finished && <IconButton icon={Ban} label="Cancel task" className="text-danger hover:bg-danger-soft" onClick={() => setConfirmCancel(true)} />}
            </div>
          </header>
          {/* Where the task is, at a glance: one segment per stage. */}
          <div role="progressbar" aria-label={`Stage ${flowAt + 1} of ${FLOW.length}: ${STATE_LABEL[FLOW[flowAt]!]}`} aria-valuemin={1} aria-valuemax={FLOW.length} aria-valuenow={flowAt + 1} className="flex shrink-0 gap-1 pb-3 lg:px-4 lg:py-2">
            {FLOW.map((st, i) => (
              <span key={st} title={STATE_LABEL[st]} className={cx("h-1 flex-1 rounded-full transition-colors duration-500", t.state === "DONE" || i < flowAt ? "bg-ok" : i === flowAt ? (t.state === "FAILED" ? "bg-danger" : t.state === "BLOCKED" || t.needsAttention ? "bg-warn" : "bg-accent") : "bg-surface-3")} />
            ))}
          </div>
      <TaskChatView d={d} panel={panel} setPanel={setPanel} tabs={tabDefs} renderPanel={renderTab} banner={<StatusBanner d={d} onOpenSpec={() => setPanel("spec")} />} />
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
