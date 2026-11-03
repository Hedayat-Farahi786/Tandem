# Tandem architecture

Tandem is a local web app that takes a request (from chat, a form, or later
Jira) through an agentic software development lifecycle and ends with tested,
reviewed pull requests. GitHub Copilot is the only agent. Everything runs on
the user's machine and binds to `127.0.0.1`.

This document describes how Tandem is built and why. `docs/PLAN.md` describes
the order it is built in and how each phase is proven.

---

## 1. Goals and constraints

| Constraint | Consequence in the design |
| --- | --- |
| Local only, no telemetry | One Node process. Server binds to `127.0.0.1` only (rejected otherwise). No analytics. Copilot runtime started with `COPILOT_GITHUB_TELEMETRY_DISABLED=true`. Outbound traffic only to Git remotes, AWS, Copilot, and Jira when it is turned on. |
| Copilot is the only AI | `AgentRuntime` port with one real implementation (`agent-copilot`) built on `@github/copilot-sdk`. It uses the Copilot CLI's existing signed-in user (`useLoggedInUser`, the default). No other AI keys. |
| CodeCommit (SSH or git-remote-codecommit), GitHub too | `SourceHost` port. Git operations use the system `git` binary with whatever the repo URL uses: the user's own `~/.ssh/config` for SSH URLs, or their AWS credentials for `codecommit::` URLs (git-remote-codecommit). PR APIs are per host (AWS SDK for CodeCommit, REST for GitHub), each with a manual-link fallback. |
| Jira not available yet | `Tracker` port. `tracker-local` (SQLite) is the default and is complete on its own. `tracker-jira` turns on when a token is saved in Settings. |
| macOS, Windows, Linux | No shell-specific code paths in core. Git and process execution go through one `ProcessRunner` that uses `execFile` (no shell) for Tandem's own commands. Paths built with `node:path`. Native dependencies limited to ones with prebuilt binaries for all three OSes. |
| Survives restart at any point | Every state transition and step checkpoint is written to SQLite before the side effect is reported. The runner re-enqueues active tasks on boot. Every step is idempotent. |
| Agent safety in code | Tool filtering (`availableTools`/`excludedTools`) plus a permission handler and a pre-tool hook that enforce path containment and a command allowlist. Prompts repeat the rules but are not relied on. |

Non-goals for v1.0: multi-user, remote hosting, running more than one Tandem
instance against the same `~/.tandem`, merging PRs (agents never merge).

---

## 2. Repository layout

pnpm workspace, TypeScript strict, Node 22 (>= 22.13), ESM everywhere,
exact dependency versions, `pnpm-lock.yaml` committed.

```
apps/
  server/            Fastify app, HTTP + SSE API, CLI entry (tandem, tandem doctor)
  web/               React + Vite + Tailwind single-page app
packages/
  shared/            Types and zod schemas: domain model, API DTOs, events, config
  core/              State machine, workflow runner, policies, ports (interfaces)
  adapters/          Implementations of the ports:
    src/source-codecommit/
    src/source-github/
    src/tracker-local/
    src/tracker-jira/
    src/agent-copilot/
    src/agent-scripted/      deterministic agent used by tests only
    src/storage-sqlite/      repository layer implementation (node:sqlite)
    src/git/                 system git wrapper shared by both source hosts
    src/secrets/             OS keychain (@napi-rs/keyring)
    src/process/             ProcessRunner (execFile, timeouts, redaction)
spikes/              Phase 1 proofs, kept as runnable scripts
e2e/                 End-to-end suites (scripted and real modes)
docs/
```

Dependency rule (enforced by ESLint `no-restricted-imports` and by package
`dependencies`):

```
shared  <-  core  <-  adapters  <-  apps/server  ->  (serves) apps/web
                                    apps/web depends only on shared
```

`core` never imports an adapter, the SDK, `node:sqlite`, `fetch`, or
`child_process`. It talks to the outside world only through ports.

### Pinned toolchain (checked against the registry on 2026-11-02)

| Purpose | Package | Version |
| --- | --- | --- |
| Agent | `@github/copilot-sdk` | 1.0.28 (bundles Copilot runtime 1.0.105) |
| Server | `fastify` / `@fastify/static` | 5.12.8 / 10.1.8 |
| Web | `react`, `react-dom` | 19.3.1 |
| Build | `vite` / `@vitejs/plugin-react` | 8.3.5 / 6.2.1 |
| Styles | `tailwindcss` / `@tailwindcss/vite` | 4.3.4 |
| Schemas | `zod` | 4.6.7 (the SDK itself depends on zod 4.3.6) |
| Language | `typescript` | 6.0.3 (TS 7 is out but `typescript-eslint` 8.72 supports `<6.1`) |
| Lint | `eslint` / `typescript-eslint` | 10.14.0 / 8.72.1 |
| Tests | `vitest` / `@vitest/coverage-v8` | 5.1.0 |
| UI tests | `@testing-library/react` / `@playwright/test` | 16.3.3 / 1.64.1 |
| AWS | `@aws-sdk/client-codecommit`, `@aws-sdk/credential-providers` | 3.1161.0 |
| Keychain | `@napi-rs/keyring` | 2.1.2 (prebuilt for macOS, Windows, Linux) |
| Markdown | `marked` | 18.1.3 |
| PDF | `pdfmake` | 0.3.13 |
| Logging | `pino` | 10.4.0 |
| Storage | `node:sqlite` (built into Node >= 22.13, no native build step) | – |

Why `node:sqlite` rather than `better-sqlite3`: it removes the only native
module that needs a C++ toolchain when prebuilds can't be downloaded (common
on locked-down Windows work machines). It is still marked experimental in
Node 22, so all access goes through the repository layer and a small
`Database` wrapper; switching to `better-sqlite3` or Postgres touches one
folder. The experimental warning for `sqlite` only is suppressed.

---

## 3. Runtime topology

```
 Browser (127.0.0.1:4317)
   │  HTTPS not needed: loopback only
   │  REST for commands, one SSE stream for events
   ▼
 apps/server  (single Node process)
   ├─ HTTP API (Fastify)  ── host/origin checks, per-launch API token
   ├─ Event bus  ──────────  SSE fan-out, replay by Last-Event-ID
   ├─ Workflow runner (core)  ─ job queue, concurrency limits, resume on boot
   ├─ Chat service (core)  ─── Ask / Request / task chat
   ├─ Pollers  ─────────────── PR status, Jira JQL and PM replies (when on)
   └─ Adapters
        ├─ storage-sqlite  →  ~/.tandem/tandem.db
        ├─ git             →  system git  →  ssh (user's ~/.ssh/config)
        ├─ source-codecommit → AWS SDK (user's AWS profile) or console link
        ├─ source-github   →  GitHub REST (token from keychain or `gh auth token`) or compare link
        ├─ tracker-local / tracker-jira → SQLite / Jira REST
        ├─ agent-copilot   →  @github/copilot-sdk → Copilot runtime (stdio child process)
        └─ secrets         →  OS keychain
```

`pnpm tandem` builds anything stale, starts the server, runs doctor on first
launch, and opens the browser. `pnpm tandem doctor` runs the same checks in
the terminal.

### Files on disk

```
~/.tandem/                       (TANDEM_HOME overrides)
  tandem.db                      SQLite: all state, no secrets
  logs/tandem-YYYY-MM-DD.log     pino JSON, redacted, rotated, 14 days kept
  mirrors/<host>/<repo>.git      one bare clone per repo (see §6)
  projects/<projectId>/<repo>/   read-only reference checkouts for Ask and spec
  tasks/<taskId>/<repo>/         one worktree per affected repo, per task
  tasks/<taskId>/.tandem/        verify logs, diffs, review output for that task
  deps/<repoId>/<installKey>/    shared installed dependencies (hard-linked into task worktrees)
```

Worktrees and the task folder are removed on Done and Cancelled. Mirrors are
kept and fetched before use.

---

## 4. Domain model

All types live in `packages/shared` as zod schemas; TypeScript types are
inferred from them, and the same schemas validate API input, DB rows, agent
structured output, and config.

- **Repo**: id, SSH URL, host kind (`codecommit` | `github`), host details
  (region + name, or owner + name), default branch, language, framework,
  role (`frontend` | `backend` | `full-stack` | `other`), commands
  (`install`, `lint`, `typecheck`, `build`, `test`, `testSingle` pattern),
  each editable.
- **Project**: id, name, repos (one full-stack repo, or a frontend and a
  backend repo, or any mix), contract order (backend first by default),
  spec repo (the "main affected repo": the full-stack repo, else backend),
  integration command (optional), PM gate (`tandem` | `jira` | `off`), PM
  names, Jira PM account IDs, Jira project key and JQL.
- **Task**: id, key (`TND-12` locally, Jira key when imported), title,
  project, structured requirement (goal, user story, acceptance criteria as
  `{given, when, then}[]`, example data, affected areas, out of scope, open
  questions), affected repos, state, step, blocked reason, needs-attention
  flag, timestamps.
- **TaskTransition**: task id, from, to, step, reason, actor
  (`system` | `owner` | `pm` | `agent`), timestamp. Append-only.
- **SpecVersion**: task id, version number, markdown, source (`draft` |
  `redraft` | `edit`), feedback that caused it, created at. Append-only.
- **Approval**: task id, spec version, role (`owner` | `pm`), name, date,
  evidence (note or link), method (`tandem` | `jira`). Only approvals whose
  spec version equals the current version count.
- **AgentRun**: task id or chat id, kind (`ask` | `request` | `task-chat` |
  `size` | `spec` | `build` | `fix` | `review` | `conflict`), mode
  (`read-only` | `build`), Copilot session id, status, attempt, started,
  ended, error.
- **VerifyRun / CommandResult**: per repo and command: exit code, duration,
  redacted output tail, full log path.
- **CriterionTest**: criterion number, repo, test file, test name, result.
- **ReviewFinding**: severity, category (`spec` | `criteria` | `rules` |
  `security`), file, line, title, detail, status (`open` | `fixed` |
  `dismissed`).
- **PullRequest**: task id, repo, provider id or manual link, URL, title,
  description, status (`open` | `merged` | `closed` | `manual-pending`),
  last polled.
- **ChatThread / ChatMessage**: scoped to a project or a task, mode,
  role, content, references, created at. The Copilot session id of the
  thread is stored so the conversation resumes after restart.
- **Rule**: repo, text, source (review comment or finding), status
  (`pending` until committed on the next task branch, then `committed`).

---

## 5. Workflow and state machine

### States

```
DRAFT ─▶ READINESS ─▶ SPEC_DRAFTING ─▶ SPEC_REVIEW ─▶ BUILDING ─▶ VERIFYING ─▶ SELF_REVIEW ─▶ PR_OPEN ─▶ DONE
             │  ▲            ▲              │                                       │
             ▼  │            └── request ───┘                                       ▼
          BLOCKED (waiting on a person, with resumeTo)                       BLOCKED (rebase/push)
any active state ──▶ FAILED (unrecoverable after retries; "Retry" resumes the failed step)
any non-terminal ──▶ CANCELLED (cleanup)
```

States hold coarse status. Each state has ordered **steps**; the current step
is persisted, so a restart resumes at the step, not the state:

| State | Steps (each idempotent) |
| --- | --- |
| READINESS | `check-ready` → `check-size` |
| SPEC_DRAFTING | `refresh-refs` → `draft` → `validate-spec` |
| SPEC_REVIEW | waits for approvals (no runner work) |
| BUILDING | `prepare-workspace` → `apply-rules` → `implement:<repo>` (contract order) → `commit-spec` → `commit-work` |
| VERIFYING | `install` → `verify` → `fix:1` → `verify` → `fix:2` → `verify` (stops early on green) |
| SELF_REVIEW | `review` → `fix-findings` → `verify` → `confirm-findings` → `sync` → (`resolve-conflict` → `verify`) → `push` |
| PR_OPEN | `open-prs` → `cross-link` → `report` → `poll` (repeats: PR status, then each open PR against its base branch, see §6) |
| DONE | `cleanup` |

The transition table lives in `core/src/state-machine.ts` as data: allowed
`(from, to)` pairs, guard functions, and the actor allowed to cause them.
Anything not in the table throws. Transitions are written in the same SQLite
transaction as the task row update, so the timeline can't disagree with the
task.

### Blocked reasons

`readiness-missing` (list of missing items), `split-proposed`,
`spec-invalid`, `rebase-conflict`, `push-rejected`, `preflight-failed`,
`pm-changes-requested` (Jira), `budget-reached` (Copilot limit, §7),
`disk-low` (less free space than `limits.minFreeDiskGb` before an install). Each carries `resumeTo` (state + step) and a
plain message that says what to do next. Fixing the cause (editing the task,
accepting the split, retrying) re-enters the workflow at `resumeTo`.

### Step-by-step behaviour

1. **Intake.** Chat Request mode, the New task form, or (Jira on) import by
   key or JQL poll (default `status = "Ready for AI"`, deduplicated by
   key). Result: a task in DRAFT, then READINESS when the owner submits it.
2. **Readiness check.** Deterministic code in `core/policies/ready.ts`
   evaluates the structured requirement: goal present, >= 2 criteria with
   non-empty given/when/then, example data, affected areas, out of scope
   present, no open questions. Free text (Jira descriptions) is turned into
   the structured form by a read-only agent call using structured output
   (`sendAndWait(prompt, zodSchema)`); the gate itself is never the model's
   opinion. Missing items → BLOCKED with the list (and a Jira comment when
   Jira is the source).
3. **Size check.** The estimate is structured output: estimated changed
   lines per repo, the independent features, and a proposed split. Tasks
   from Request mode get it in the chat's final turn. Jira and form tasks
   get it from one read-only call over the reference checkouts, combined
   with extraction, so it costs no separate call. Code decides:
   too big if estimated lines > 400 (configurable) or features > 1.
   Too big → BLOCKED `split-proposed` with the proposal. The owner accepts
   (child tasks are created in READINESS, the parent is cancelled with a
   link) or overrides (recorded with a reason).
4. **Spec.** A read-only session drafts the spec from `specs/TEMPLATE.md` in
   the spec repo if present, otherwise the default template
   (`core/spec/default-template.md`). Code validates it: all template
   sections present; when more than one repo is affected, the API contract
   section must contain a request example, a response example and an error
   example. One automatic redraft on validation failure, then BLOCKED
   `spec-invalid`. Spec versions are append-only.
5. **Approval.** Owner approves or requests changes in Tandem. PM gate:
   *Recorded in Tandem* (owner records PM name, date, evidence after sharing
   via Copy as Markdown or Export as PDF), *Via Jira* (spec posted as a
   comment; only replies from configured PM account IDs that start with
   `approve` or `changes:` count), or *Off*. Approve is disabled while Open
   questions is not empty. Any edit creates a new version and approvals for
   older versions stop counting. Request changes → SPEC_DRAFTING with the
   feedback. Both keys on the current version → BUILDING.
6. **Build.** `prepare-workspace` creates `~/.tandem/tasks/<taskId>/` with a
   worktree per affected repo on `agent/<taskKey>-<slug>` from the freshly
   fetched default branch. Pending learned rules are appended to
   `docs/agent-rules.md` in that branch. One build session runs in the task
   folder with build-mode tools. Context sent explicitly (not left to
   auto-discovery): approved spec, each repo's
   `.github/copilot-instructions.md`, `.github/agents/*`, and
   `docs/agent-rules.md`. For split repos, the backend is implemented first,
   then the frontend in a second prompt against the approved contract. The
   agent must call the custom tool `tandem_record_test` for every
   criterion; code rejects completion while a criterion has no test (one
   follow-up prompt, then "needs attention"). Tandem commits: the spec to
   `specs/<taskKey>-<slug>.md` in the spec repo, then the work, with
   conventional messages. The agent may run `git add/diff/status/log`, but
   commits, rebases and pushes are Tandem's.
7. **Verify.** Tandem (never the agent) runs per repo: install, lint,
   type-check, build, test; then the project's integration command if set.
   Commands run with a timeout, and output is redacted and stored. Each
   mapped criterion test is run on its own with the repo's `testSingle`
   pattern when one is known (vitest, jest, pytest, go); otherwise the
   result is the repo's suite result, labelled "suite". On failure the
   build session gets the exact errors (trimmed tails) for up to 2 fix
   attempts. Still failing → continue with `needsAttention = true`.
8. **Self-review.** A new read-only session reviews the full diff of every
   repo against the spec, criteria, repo rules, and a security checklist
   (secrets, injection, auth, input validation). Findings are structured
   output. The build session fixes valid findings once; Tandem re-verifies;
   a read-only confirm pass marks which findings remain. Remaining findings
   go into the PR description.
9. **Sync and push.** Fetch, then rebase each branch onto the latest default
   branch. On conflict, the build session resolves conflict markers, Tandem
   continues the rebase and re-runs verify. Still failing → `git rebase
   --abort`, BLOCKED `rebase-conflict` with the conflicting files. Push over
   SSH with an explicit refspec. Code refuses any push whose destination is
   not `refs/heads/agent/*`.
10. **Pull requests.** One per repo through its adapter. CodeCommit:
    `CreatePullRequest` with `clientRequestToken = <taskId>:<repoId>` so a
    retry after restart cannot create a duplicate; if the profile lacks
    permission, a console link plus ready-to-paste title and description.
    GitHub: REST `POST /repos/{o}/{r}/pulls`, or a compare link. After all
    PRs exist, descriptions are updated with links to each other. The
    description (built by `core/pr/description.ts`): summary, spec link,
    other PRs, criterion → test → result table, verification results, open
    findings, Jira link when on. Over-length descriptions (CodeCommit allows
    10,240 characters) are trimmed with a pointer to the spec file.
11. **Report.** PR links and results on the task page; with Jira, a comment
    and a transition to "In Review" when that transition exists.
12. **Done.** A poller checks PR status (CodeCommit `GetPullRequest`, GitHub
    REST; for manual links, git ancestry of the branch on the default branch,
    plus a "Mark as merged" button for squash merges). All merged → DONE,
    Jira comment, worktree cleanup.
13. **Learn.** Any review finding or PR comment can be turned into a rule;
    it is stored as pending and committed to `docs/agent-rules.md` on that
    repo's next task branch.

### Runner, concurrency, resume

- `core/runner` is a durable queue backed by the `jobs` table: one job per
  task step, `status`, `attempt`, `notBefore`, `lockedBy` (process id +
  boot id).
- On boot, jobs locked by an older boot id are released and re-queued;
  tasks in active states without a job get one for their persisted step.
- Concurrency: `maxConcurrentBuilds` (default 1) gates BUILDING, VERIFYING
  and SELF_REVIEW. Read-only work (readiness, size, spec, chat) has its own
  limit (default 2).
- Agent runs persist their Copilot session id. On restart mid-build the
  runner calls `resumeSession(id)` and sends a continuation prompt that
  includes the current `git status` and diff summary. If resume fails (for
  example the session was killed before its first turn, when nothing is
  stored yet), it starts a new build session with the spec plus the current
  diff. Work on disk in the worktree is never discarded by a restart.
- Retries: Copilot errors (rate limit, transient network, `session.error`)
  are retried with exponential backoff (2 s, 4 s, 8 s, 16 s, jittered,
  4 attempts) before the task goes to FAILED. Git network errors use the
  same policy.
- Hard timeouts per agent run (defaults: chat 5 min, read-only steps 15 min,
  build 60 min) and per command (default 15 min). On timeout the session is
  aborted and disconnected and the step fails with a clear message.

---

## 6. Git and source hosts

### Git layer (`adapters/git`)

Uses the system `git` through `execFile` with `GIT_TERMINAL_PROMPT=0` and
`GIT_SSH_COMMAND="ssh -o BatchMode=yes"` (still reads `~/.ssh/config`; it
only stops ssh from hanging on a prompt). An existing `GIT_SSH_COMMAND` or
`GIT_SSH` is respected. For `codecommit::` URLs git calls
git-remote-codecommit, which uses the AWS profile named in the URL (or the
default chain), so Tandem's own git commands keep the AWS environment; only
the agent runtime's environment has it removed.

Minimum git is 2.25 (Ubuntu 20.04, seen on the user's machine). Code avoids
newer options such as `init --initial-branch` (2.28); the spike b steps all
pass on 2.25.

- **"Mirror"**: `git clone --bare <url> mirrors/<host>/<repo>.git`, then
  `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*`. A true
  `--mirror` clone is deliberately not used: with `remote.origin.mirror`
  set, git refuses explicit refspecs on push and a plain push would mirror
  every ref, which is the opposite of safe.
- **Worktree**: `git --git-dir=<mirror> worktree add -b agent/<key>-<slug>
  tasks/<id>/<repo> origin/<default>`.
- **Reference checkout** (Ask, size, spec, review context): detached
  worktree at `origin/<default>` under `projects/<id>/<repo>`, refreshed
  before each read-only session.
- **Rebase**: `git fetch origin`, `git rebase origin/<default>`; conflicts
  read from `git diff --name-only --diff-filter=U`.
- **Push**: `git push origin refs/heads/agent/X:refs/heads/agent/X`. A
  re-push after a rebase uses `--force-with-lease=refs/heads/agent/X:<sha>`,
  only on `agent/*` branches Tandem created. Never `--force`.
- Windows: `core.longpaths=true` on mirrors, short task ids in paths.

### SourceHost port

```ts
interface SourceHost {
  readonly kind: 'codecommit' | 'github';
  detect(url: string): HostRef | null;               // parse SSH/HTTPS/GRC URLs
  preflight(repo: Repo): Promise<PreflightResult>;   // SSH read, PR API permission
  mirror(repo: Repo): Promise<MirrorInfo>;           // create or fetch, default branch
  createWorktree(repo: Repo, opts: WorktreeOpts): Promise<Worktree>;
  rebase(wt: Worktree): Promise<RebaseResult>;       // ok | conflicts(files)
  push(wt: Worktree, opts?: { forceWithLease?: string }): Promise<PushResult>;
  openPullRequest(req: PullRequestRequest): Promise<PullRequestResult>; // created | manual(link)
  updatePullRequestDescription(pr: PullRequest, body: string): Promise<void>;
  getPullRequestStatus(pr: PullRequest): Promise<PullRequestStatus>;
}
```

Both implementations share the git layer; they differ in URL parsing,
preflight, and PR APIs.

- **CodeCommit**: accepts `codecommit::<region>://[profile@]<name>`
  (what the user's existing clones use),
  `ssh://git-codecommit.<region>.amazonaws.com/v1/repos/<name>` and HTTPS.
  Non-SSH URLs are cloned over HTTPS with `aws codecommit credential-helper
  --profile <p>` as the only credential helper, written into Tandem's own
  mirror config (`credential.helper=` reset, then the helper, plus
  `credential.UseHttpPath=true`). The user's git config is never changed.
  This replaces git-remote-codecommit, whose bundled botocore cannot read
  `aws login` sessions (spike b). Default branch: `GetRepository` first,
  because CodeCommit HTTPS doesn't advertise the HEAD symref. PR API via the AWS SDK with the profile
  named in the URL, else the one from Settings, else the default chain.
  Expired credentials (for example an `aws login` session) are reported as
  "Sign in again with `aws login --profile <name>`", never as a generic
  failure. Permission probe without
  creating anything: `CreatePullRequest` against the real repository with a
  source reference that does not exist; `ReferenceDoesNotExistException`
  means allowed, `AccessDeniedException` means use the console link. (This
  probe behaviour is confirmed in spike c before relying on it.) Console
  link for the fallback is built and verified in spike c.
- **GitHub**: SSH `git@github.com:o/r.git`. Token from the keychain
  (Settings) or `gh auth token` if the GitHub CLI is logged in. Without a
  token: compare link `https://github.com/o/r/compare/<base>...<head>?expand=1`
  with the title and body to paste.

### Open pull requests and their base branch

Each `PR_OPEN:poll` fetches the mirror and compares every open PR branch
with its base (`syncWithBase` in `core/workflow/steps.ts`). The result is
stored on the PR as `sync`: `up-to-date`, `mergeable`, `updated`,
`needs-person`, `unresolved`, `checks-failed` or `branch-rewritten`.

- Base not ahead, or ahead without conflicts (a `merge --no-commit` probe,
  aborted): nothing changes.
- Conflicts, and the branch head is what Tandem pushed: merge the base into
  the branch (a merge commit, so no history rewrite and no force push;
  review comments stay anchored), let the agent resolve the conflict
  (`conflict` run), run every check, push only if they pass, update the PR
  description, comment on the tracker.
- Someone else pushed on top (Tandem's last push is an ancestor of the
  head): leave it to them (`needs-person`) unless the owner asks
  (`fixConflicts`), which merges on top of their commits.
- The head no longer contains Tandem's last push (force-pushed): never
  touched again.
- Each base/head pair is handled once, so a failed attempt is not retried
  until something moves or the owner asks. `polling.fixConflicts = false`
  makes every conflict wait for a person.

This follows what dependency bots and Copilot's coding agent do: update a
bot-owned branch automatically, stop once a person has pushed to it, and
always run the checks before pushing.

### Repo detection

From the URL: host, region/owner, name. After the bare clone, from the
default branch tree via `git show <ref>:<path>` (no checkout): language and
package manager (lockfiles), framework (dependency names), role
(frontend / backend / full-stack / other), and commands from `package.json`
scripts, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `*.csproj`,
`Cargo.toml`. Everything detected is shown in the setup wizard and editable.

---

## 7. Agent runtime (Copilot)

### Port

```ts
interface AgentRuntime {
  startSession(opts: {
    workspace: string;            // task folder or reference checkout root
    mode: 'read-only' | 'build';
    instructions: string;         // appended system message
    allowedCommands: CommandRule[]; // build mode only
    tools?: TandemTool[];         // e.g. tandem_record_test
    resumeId?: string;
    timeoutMs: number;
  }): Promise<AgentSession>;
}
interface AgentSession {
  readonly id: string;
  send(prompt: string, opts?: { schema?: ZodType }): Promise<AgentTurnResult>;
  streamEvents(): AsyncIterable<AgentEvent>; // deltas, tool calls, denials, errors
  stop(): Promise<void>;
}
```

### Copilot implementation (verified against SDK 1.0.28 / runtime 1.0.105)

- One `CopilotClient` per server process, started lazily, stdio transport,
  `useLoggedInUser: true` (default), `env` passed explicitly: the parent
  environment minus AWS, Jira, and GitHub token variables, plus
  `COPILOT_GITHUB_TELEMETRY_DISABLED=true`. The SDK's bundled,
  version-matched runtime is used by default and reads the same
  `~/.copilot` login as the installed CLI; `COPILOT_CLI_PATH` points it at
  the installed `copilot` binary instead if needed. On the user's machine
  the bundled runtime works.
- **Copilot host.** Copilot can come from a GitHub Enterprise Cloud
  data-residency host (`<company>.ghe.com`). The runtime authenticates
  against github.com unless `COPILOT_GH_HOST` is set; Tandem's
  `copilot.host` setting is passed as `COPILOT_GH_HOST`. Observed on the
  user's machine: the Copilot CLI had no login of its own and used the GitHub
  CLI's tokens (`authType: gh-cli`). With two `gh` accounts, the default host
  gave `403 not authorized to use this Copilot feature`, and the company host
  worked. Doctor reads the `gh auth status` accounts and, on a 403, suggests
  the host that has Copilot. The setup wizard asks once.
- `client.getAuthStatus()` → `{ isAuthenticated, login, authType }` for
  doctor. Policy access is checked with `client.listModels()` plus one tiny
  prompt in doctor's full mode (spike a records the real error text when
  the org policy blocks the CLI).
- `createSession({ workingDirectory, streaming: true, systemMessage: {
  content }, availableTools, excludedTools, onPermissionRequest, hooks: {
  onPreToolUse }, tools, infiniteSessions })`.
- Streaming: `assistant.message_delta` (`deltaContent`) is forwarded to the
  SSE bus; `assistant.message`, `tool.execution_start/complete`,
  `session.idle`, `session.error` drive the turn state.
- Structured output: `session.sendAndWait(prompt, zodSchema)` for readiness
  extraction, size estimate, review findings.
- Tool names differ by model: the gpt models' search tool is `rg`, others
  get `grep` (spike a live). The read-only set is `view`, `glob`, `grep`
  and `rg`.
- Built-in tool names observed from the runtime (`rpc.tools.list`): `bash`,
  `read_bash`, `stop_bash`, `list_bash`, `glob`, `grep`, `view`, `create`,
  `edit`, `web_fetch`, `skill`, `task`, `read_agent`, `list_agents`,
  `write_agent` (some models add `apply_patch`; Windows uses a PowerShell
  shell tool). The adapter reads the live list at startup and fails closed
  on names it doesn't know.

### Enforcement (in code, three layers)

| Layer | Read-only mode (Ask, size, spec, review, task questions) | Build mode (implement, fix, conflicts) |
| --- | --- | --- |
| Tool filter (`availableTools`) | `builtin:view`, `builtin:glob`, `builtin:grep`, Tandem's read-only custom tools | + `create`, `edit`, `apply_patch`, the shell tool and its `read/stop/list` companions, `tandem_record_test` |
| Excluded (`excludedTools`) | everything else incl. `web_fetch`, `task`, `mcp:*`, `skill` | `web_fetch`, `task`, sub-agent tools, `mcp:*`, `skill` |
| `onPermissionRequest` | approve `read` only when the resolved path is inside the workspace; reject everything else with feedback | `read`/`write`: path must resolve inside the task folder and not inside `.git` internals; `shell`: every parsed command segment must match the allowlist and none may match the denylist; `url`, `mcp`, `memory`, `hook`: reject; unknown kinds: reject |
| `hooks.onPreToolUse` | deny any tool not in the filter (second check) | same, plus re-checks shell text for the denylist |

Shell allowlist (build mode): `git` with `status|diff|log|show|add|restore|
checkout -- <path>|stash|rm|mv|grep|ls-files` (no `push`, `commit`,
`rebase`, `reset --hard`, `clean -fdx`, `--force`, `-f` on push, config
writes); the repo's configured install/lint/typecheck/build/test/testSingle
and integration commands; package installs with the repo's package manager
(`pnpm add|install`, `npm install|i`, `yarn add|install`, `pip install` into
a venv, `go get`, `go mod tidy`); read-only helpers (`ls`, `cat`, `head`,
`tail`, `wc`, `find`, `rg`). Denylist wins over
allowlist: `aws`, `az`, `gcloud`, `kubectl`, `helm`, `terraform`, `pulumi`,
`cdk`, `serverless`, `sls`, `docker push`, `npm publish`, `pnpm publish`,
`vercel`, `netlify`, `fly`, `heroku`, `ssh`, `scp`, `curl`, `wget`,
`sudo`, inline interpreters (`node -e`, `python -c`), migration commands (`prisma migrate deploy`,
`knex migrate`, `sequelize db:migrate`, `alembic upgrade`, `flyway`,
`liquibase`, `rails db:migrate`) unless the configured test command runs
them against a local test database, and any command with
`DATABASE_URL` pointing at a non-local host. Rules are data
(`core/policies/commands.ts`), unit-tested with a table of allowed and
denied examples, and shown read-only in Settings.

Verified in the real runtime without a model (spike a, container rehearsal):
`session.rpc.tools.execute` runs a tool through the runtime's own pipeline,
and the `onPreToolUse` hook denied 15 of 15 forbidden actions with 0
`assistant.usage` events. The hook is therefore the primary gate and fires
before the tool runs; the permission handler is the second layer for calls
the hook allows. A session is not stored until its first model turn, so
resuming a session killed before that fails with "Session not found"; the
runner then creates a new session with the same enforcement and Tandem's own
context.

### Copilot budget

Copilot plans are often shared, so Tandem treats model calls as a budget:

- **Metering.** Every `assistant.usage` event (model, cost multiplier, AI
  credits) is stored against the task or chat that caused it and shown on the
  task page and in Settings.
- **Limits.** Per task (default 15 prompts) and per day (default 40), both
  editable. When a limit is reached, the task goes to BLOCKED
  `budget-reached` ("Raise the limit in Settings or continue tomorrow"), and
  nothing is lost. `sessionLimits.maxAiCredits` is also set when the account
  uses AI-credit billing.
- **Model per step.** Settings picks a model for light steps (chat,
  extraction, size, review) and one for build. Defaults: the cheapest enabled
  model for light steps, the runtime default for build. Each model's cost
  comes from `listModels().billing`.
- **Fewer calls by design.** The readiness gate is code, so tasks created in
  Request mode cost no extra call. The size estimate comes back as structured
  output in the Request chat's final turn, or together with extraction for
  Jira tasks. Self-review is one call; the build agent marks each finding
  fixed through `tandem_resolve_finding`, and verify re-runs
  deterministically instead of making a second review call. Sessions are
  reused within a step.

### Secret redaction

`core/policies/redact.ts` applies to every log line, persisted event, chat
message, command output, PR description and Jira comment: AWS access keys
and secret keys, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`,
`github_pat_`), Atlassian tokens, JWTs, private key blocks, `password=` /
`token=` assignments, plus the exact values of any secret Tandem holds
(registered at runtime from the keychain). Tested with fixtures.

### Audit log and traceability

`store.audit` is an append-only log (`audit` table, SQLite migration 2).
`append` assigns the next sequence number and a SHA-256 hash over the
previous hash and the canonical JSON of the entry (`core/audit.ts`), after
redaction, so the hash covers exactly what is stored. SQLite triggers
refuse `UPDATE` and `DELETE` on the table; someone who drops the triggers
can still change a row, but `verifyAuditChain` then reports the first
entry whose hash or link does not match. The memory and SQLite stores
share `chainEntry`, and the store contract test covers both.

Written by core: every state change (`task.state`, inside the transition's
transaction), task creation, spec edits, approvals (Tandem and Jira),
pushes with the commit (`git.pushed`), pull requests opened, prepared or
linked, and "mark merged". Written by the server: settings changes (field,
old and new value), token saved or removed (name only), repositories,
projects, rules, model changes, "Fix conflicts" and "Request changes".

Agent activity: `openSession` saves each run's steps in `agent_steps`
(migration 3) as they happen: the prompt, intents, reasoning, tool calls
(paired start and end, with input, output, edited files and duration),
blocked actions, errors and messages. Text is capped (20,000 characters;
tool output 4,000) and redacted by the store. Each save emits `agent.step`
over SSE, and `GET /api/tasks/:id/activity` returns the runs with their
steps, model, prompts and credits (usage records carry the run id).

`GET /api/activity` (used by the exports in Settings) merges the audit log with Copilot usage records, check
runs and (for tasks from before the audit log) transitions; it filters by
time, project, task and kind, and exports CSV (formula-like cells are
quoted) or JSON. `GET /api/audit/verify` recomputes the chain.
`GET /api/tasks/:id/trace` joins a task's criteria, criterion tests, spec
versions and approvals, agent runs and usage, verify runs, findings,
commits and PRs, and its audit entries; `?format=md` is the report.

---

## 8. Trackers

```ts
interface Tracker {
  readonly kind: 'local' | 'jira';
  getTask(key: string): Promise<TrackerTask>;
  findReadyTasks(query?: string): Promise<TrackerTask[]>;
  comment(key: string, markdown: string): Promise<{ id: string }>;
  transition(key: string, statusName: string): Promise<'moved' | 'not-available'>;
  readReplies(key: string, since: Date, authorIds?: string[]): Promise<TrackerComment[]>;
}
```

- **tracker-local**: tasks and comments in SQLite. Comments appear in the
  task timeline. Always available.
- **tracker-jira**: Jira Cloud REST v3 (email + API token, Basic auth) or
  Data Center (personal access token, Bearer). Base URL, email, and PM
  account IDs are plain settings; the token is the only secret and lives in
  the keychain. Markdown → Atlassian Document Format for comments. Search
  uses the current JQL search endpoint (verified in Phase 2 against the
  docs; mocked in tests). Transition by name via the transitions list.
  When no token exists, the factory returns `tracker-local` and Settings
  shows "Not configured (optional)".

---

## 9. Chat

- **Ask** (per project): read-only session over the reference checkouts.
  The answer streams. File references in the form `path:line` are checked
  against the checkout and rendered as links into a file viewer; unknown
  paths are shown as plain text.
- **Request** (per project): a session with the custom tool
  `tandem_update_draft` (structured requirement fields). After every turn,
  code runs the readiness check on the draft and feeds back what is
  missing, so the agent's next message asks about exactly that. When the
  draft passes, the chat shows the readiness checklist with Create task.
- **Task chat** (per task): read-only session over the task folder (or
  reference checkouts before build) with the spec, timeline, diff summary,
  and last verify output as context. The custom tool
  `tandem_request_spec_change` turns a conversational change request into
  either a direct edit (new spec version) or a redraft with feedback; the
  owner confirms it from the chat card. Chat never writes code.
- History is stored per thread in SQLite; the Copilot session id is stored
  so a thread continues after restart (resume, or a new session seeded with
  the last messages if resume fails).

---

## 10. HTTP API and events

- REST under `/api`: projects, repos (detect, preflight), tasks (create,
  submit, accept split, override, approve, request changes, record PM
  approval, edit spec, retry, cancel), specs (versions, markdown, pdf),
  diffs, verify results, findings, PRs (mark merged, set manual PR URL),
  rules, chat threads and messages, settings, doctor, activity (with CSV
  and JSON export), audit verification, and each task's trace.
- One SSE stream `/api/events` with typed events (`task.transition`,
  `task.step`, `agent.delta`, `agent.tool`, `chat.delta`, `chat.done`,
  `verify.output`, `doctor.check`). Events have monotonically increasing
  ids; the server keeps a replay buffer and the client reconnects with
  `Last-Event-ID`. Anything that matters is also in the DB, so a full page
  reload rebuilds state from REST.
- Local security: bind `127.0.0.1` only; reject requests whose `Host` is
  not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); require a
  per-launch random token in an `X-Tandem-Token` header for every non-GET
  request (injected into the served page; blocks cross-site requests from
  other browser tabs); no CORS; strict CSP on the web app.

---

## 11. Web UI

React 19 + Vite + Tailwind 4, React Router, TanStack Query for REST data,
one SSE hook for live events. Screens: Setup wizard, Chat (Ask / Request),
Tasks, Task detail (timeline, task chat, readiness, spec viewer/editor with
versions and approvals, Copy as Markdown, Export as PDF, per-repo diff
viewer, verify and review results, criterion → test table, PR links, Copilot's
activity step by step, trace),
Projects, Settings (with the audit log), Doctor, and a Ctrl/⌘K command palette.

Design tokens as CSS variables mapped into Tailwind's theme: neutral grays,
one deep teal accent (#0E3B3B), 8 px spacing grid, Inter with optical sizing (display
cut for headings), the sidebar as the canvas and pages on a raised panel,
light and dark mode (system default, manual toggle). WCAG AA contrast
checked in tests (axe in Playwright), full keyboard support, visible focus
rings, `aria-live` for streaming text. Each screen has designed loading,
empty and error states; error copy says what happened and what to do next.
PDF export is generated server-side with pdfmake from the spec Markdown so
the file is identical on every OS.

---

## 12. Configuration and secrets

- One typed config: `packages/shared/src/config.ts` (zod). Precedence:
  defaults < settings saved in the DB (edited in the UI) < environment
  variables (`.env` in the repo root is loaded for development;
  `.env.example` lists every variable). Secrets are not config.
- Secrets (Jira token, optional GitHub token) are stored with
  `@napi-rs/keyring` under service `tandem`: macOS Keychain, Windows
  Credential Manager, Linux Secret Service. If no keychain is available
  (headless Linux without a Secret Service), Tandem refuses to store the
  secret and doctor explains how to install one. There is no file fallback.
- AWS credentials stay where the AWS CLI keeps them; Tandem stores only the
  profile name.

---

## 13. Doctor

Each check returns `pass | warn | fail | skipped` with one plain-language
fix line:

Node >= 22.13 · pnpm · git >= 2.25 · disk space under `~/.tandem` (warn
< 5 GB, fail < 1 GB) · keychain available · port free · Copilot runtime
starts · Copilot signed in (`getAuthStatus`, showing account and host) ·
Copilot policy access (`listModels`, no model call; on a 403 it lists the
other `gh` accounts and suggests `copilot.host`) · read access to each
configured repo (`git ls-remote`, 20 s timeout, over SSH or
git-remote-codecommit) · AWS credentials for each profile in use (expired
sessions get "Sign in again with `aws login`") · AWS PR permission probe
(optional) · Jira ("Not
configured (optional)" until a token exists, then `GET /myself`). Runs
automatically on first launch and from the Doctor screen.

---

## 14. Testing strategy

| Level | What | Where it runs |
| --- | --- | --- |
| Unit | core (state machine, runner, policies, spec validation, PR description, redaction, allowlist), adapters with mocked externals (Jira via recorded fixtures, AWS SDK client mocked, Copilot SDK client faked) | anywhere; core gated at >= 85 % line coverage |
| Integration | git layer and both source hosts against local bare repos (`file://`); storage; tracker-local restart; agent-copilot wiring against the real runtime without auth | anywhere |
| Integration (real) | CodeCommit sandbox repos over SSH, AWS PR API, Copilot with the user's login | user's machine (`TANDEM_REAL=1`) |
| Component | every screen's states with Testing Library | anywhere |
| Smoke | Playwright, every screen + setup wizard against the real server with the scripted agent and local remotes | anywhere |
| End-to-end | both project shapes from chat Request mode to PRs, plus every failure path | scripted mode anywhere; real mode on the user's machine with CodeCommit + Copilot |

The scripted agent (`agent-scripted`) implements `AgentRuntime` and replays
scripted edits and answers. All development and the whole test suite use it,
so normal testing makes no Copilot calls. It also makes failure paths
(failing tests, conflicts, restarts) deterministic. The Copilot adapter is
covered without model calls in two ways. Its enforcement is tested in the
real runtime through `tools.execute`. Its event handling is tested against
event streams recorded once during the live runs. Live Copilot runs happen
only at the end, with the owner's approval and a hard prompt cap (see
`docs/PLAN.md`, "Copilot budget"). Jira end-to-end tests are written and
skipped unless `TANDEM_E2E_JIRA=1`.
