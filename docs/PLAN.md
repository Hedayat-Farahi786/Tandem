# Tandem v1.0 plan

Six phases. Each ends with build, type-check, lint and tests passing, a
commit, and evidence (command output, screenshots or test reports) in
`docs/evidence/phase-N.md`. Nothing is called working until it has been run
and seen to pass. See `docs/ARCHITECTURE.md` for the design.

---

## Where things run

This work is done from a cloud container. It has Node 22, pnpm 10, git and
the Copilot SDK runtime (which starts here but has no Copilot login), and no
access to your SSH keys, CodeCommit, AWS profile or Copilot account.

| Work | Where |
| --- | --- |
| Code, unit tests, integration tests against local git remotes, scripted-agent e2e, Playwright | container (Linux) |
| Spikes, real integration and real e2e (Copilot login, SSH to CodeCommit, AWS profile), `pnpm tandem doctor`, OS-specific checks | **your machine** |

To run things on your machine, either:

1. **Remote Control (recommended).** In the Claude desktop app open
   Settings → Claude Code → Remote Control and share a folder (for example
   a clone of this repo), or run `claude remote-control` in that folder. I
   then attach this session to it and run the spikes and tests myself, on
   your OS.
2. **You run the commands.** I give you one command per spike
   (`pnpm spike:a` … `pnpm spike:d`); each writes a report file to
   `spikes/reports/` that you paste back or commit.

---

## What I need from you

Only these, and only when the phase that needs them starts:

| Value | Needed for | Notes |
| --- | --- | --- |
| A way to run on your machine (option 1 or 2 above) | Phase 1 onward | – |
| Three empty CodeCommit sandbox repos (SSH URLs), or permission for me to create them with your AWS profile | Phase 1b, 4 | Suggested names: `tandem-sandbox-fullstack`, `tandem-sandbox-frontend`, `tandem-sandbox-backend`. Tandem seeds them with small TypeScript apps from `spikes/sandbox/`. |
| AWS profile name and region (if you have one) | Phase 1c | Optional. Without it the console-link fallback is what gets tested. |
| Your approval before each live Copilot run | end of Phase 1, end of Phase 4 | Everything else uses no Copilot at all. See "Copilot budget" below: about 25 prompts in total, or about 14 on the minimum plan. |
| A GitHub sandbox repo (optional) | Phase 2 GitHub adapter real test | Without it the GitHub adapter is tested against mocks and local remotes only. |

---

## Copilot budget

Your Copilot plan is shared, so testing does not use it unless a test cannot be
done any other way, and then only with your go-ahead.

**Free (no model calls, used for all development and the full test suite):**

- Everything about the Copilot runtime that doesn't need a model: starting it,
  your login, the model list with each model's cost, the tool list, and the
  safety rules. Tools can be run through the runtime's own pipeline without a
  model (`session.rpc.tools.execute`), so the hook and permission checks are
  tested in the real runtime for free. Verified in the container: 15 of 15
  forbidden actions denied, 0 usage events.
- All workflow, UI and end-to-end tests use the scripted agent
  (`agent-scripted`): same `AgentRuntime` interface, deterministic edits and
  answers, no network. Real git, real CodeCommit and real PRs are still used
  where those are what's being tested.
- Adapter tests replay Copilot event streams recorded once during the live
  runs (`spikes/reports/fixtures/`), so the parsing of real SDK events is
  covered without calling the model again.

**Live (real model calls), only at the end, each run asks first:**

| Run | When | Prompts (estimate) | Why it can't be free |
| --- | --- | --- | --- |
| Spike a live (`pnpm spike:a -- --live`) | end of Phase 1, optional | 2 (hard cap in code) | proves streaming, structured output and a real edit + test run with your login |
| E2E (b) split frontend + backend, with a restart during BUILDING | end of Phase 4 | about 12 | the most demanding real case: two repos, API contract, resume after restart |
| E2E (a) one full-stack repo | end of Phase 4 | about 10 | the second shape from the Definition of Done |

That is about 25 prompts in total, or about 14 if you choose the minimum plan:
spike a live plus E2E (b) only, with (a) covered by the scripted run against
the real repo. Each live run defaults to the cheapest enabled model, as
reported by `listModels` (on request-based billing some models cost 0×). It
stops at a hard prompt cap and reports usage from the runtime's
`assistant.usage` events.

The same controls are product features, because Tandem itself will be used on
a shared plan (see ARCHITECTURE.md §7, "Copilot budget").

---

## Phase 0 – Plan (this phase)

- `docs/ARCHITECTURE.md`, `docs/PLAN.md`.
- Copilot SDK 1.0.28 / runtime 1.0.105 read from the published package
  (README, type definitions) and probed in the container: client start,
  `getStatus`, `getAuthStatus` (unauthenticated here), built-in tool list.
- **Exit:** you say "go".

## Phase 1 – Spikes (on your machine, in `/spikes`)

Each spike is a standalone TypeScript script with a pass/fail report. If
one fails, I stop and explain the options before building anything on it.

**a) Copilot SDK with your existing login** (`pnpm spike:a`, free)
1. `CopilotClient` start, `getAuthStatus()` shows your login with no token
   passed; record whether the bundled runtime or `COPILOT_CLI_PATH` (your
   installed CLI) is needed.
2. `listModels()`: policy access, and each model's cost, so the cheapest model
   can be chosen.
3. Tool list on your OS (shell tool name differs on Windows).
4. Read-only and build sessions in a worktree of the sandbox repo, with
   forbidden actions run through the runtime's tool pipeline: writes, shell
   and web in read-only sessions; push, commit, git options, cloud CLIs,
   network, command substitution, writes outside the worktree or into `.git`
   in build sessions. All must be denied, with 0 model calls counted.
5. Restart before the first turn: the session isn't stored yet (seen in the
   container), so Tandem re-creates it with the same enforcement.
6. Unknown model: record when and how the error appears.

`pnpm spike:a -- --live` (2 prompts, asks first): streaming plus structured
output in a read-only session; a real edit and test run in a build session
with the forbidden actions attempted by the model; the session's history
restored after the runtime is killed. It records the event streams as test
fixtures.

**b) CodeCommit over SSH**: bare clone with remote-tracking refspec, fetch,
default branch via `ls-remote --symref`, worktree on `agent/spike-…`,
commit, rebase onto a commit pushed to default meanwhile (clean and
conflicting cases), push with explicit refspec, `--force-with-lease`
re-push, refusal to push to a non-`agent/*` ref, cleanup of the worktree
and remote branch.

**c) CodeCommit PR**: with an AWS profile, permission probe (non-existent
source ref → expected exception), `CreatePullRequest` with
`clientRequestToken` (retry returns the same PR), `GetPullRequest`,
`UpdatePullRequestDescription`, close the PR. Without a profile, or in
addition: build the console "create pull request" link and confirm it
opens the prefilled page; record the exact URL format.

**d) Local tracker**: create a task, add comments, change status, restart
the process, data intact. Jira spike written (`spikes/d-jira.ts`) and
skipped until `JIRA_*` values and a token exist.

**Exit:** four reports in `spikes/reports/` (Jira one marked skipped),
committed, plus decisions recorded in ARCHITECTURE.md where a spike changed
anything.

## Phase 2 – Core and adapters

1. Monorepo scaffold: workspace, strict tsconfig base, ESLint, Vitest with
   coverage, `packageManager` pin, `.env.example`, typed config.
2. `packages/shared`: schemas for the domain model, API DTOs, events,
   agent structured outputs.
3. `packages/core`: state machine table and guards; runner (jobs table,
   leases, boot recovery, concurrency, backoff, timeouts); policies
   (readiness, size decision, spec validation, command allowlist, path
   containment, redaction); spec template rendering; PR description
   builder; prompts; chat service; workflow steps written against ports.
4. `packages/adapters`: storage-sqlite with migrations; git layer;
   source-codecommit; source-github; tracker-local; tracker-jira (mocked
   HTTP, every method, error paths, ADF conversion, PM reply parsing);
   agent-copilot (permission handler and hook covered by unit tests with
   recorded SDK permission requests); agent-scripted; secrets; process.
5. Integration tests: git and both hosts against local bare remotes; full
   workflow with scripted agent through PR_OPEN against local remotes and
   the CodeCommit adapter in fallback mode; restart in every state.
   Real-mode integration tests against the CodeCommit sandbox repos run on
   your machine.

**Exit:** all green; core line coverage >= 85 % (report in evidence); real
integration run on your machine.

## Phase 3 – Web UI

1. Server API and SSE wired to core; host/origin/token checks.
2. Design tokens, layout, light/dark, components (buttons, pills, cards,
   tables, dialogs, toasts, empty/loading/error states).
3. Screens: setup wizard, Chat (Ask/Request with streaming), Tasks, Task
   detail (all panels), Projects, Settings, Doctor.
4. Component tests for every screen state; Playwright smoke for every
   screen and the wizard against the real server with scripted agent and
   local remotes; axe accessibility checks; keyboard-only pass.

**Exit:** all green, screenshots of every screen in light and dark mode in
the evidence file.

## Phase 4 – End-to-end

Both shapes, started from chat Request mode with: "Add a GET /health
endpoint returning {status: 'ok'} and show the status on the main page."
Each run: clarifying questions → readiness → spec → owner approval →
recorded PM approval → build → verify → self-review → PRs.

| Scenario | Scripted agent, local remotes (container) | Scripted agent, real CodeCommit (your machine, free) | Live Copilot (your machine, asks first) |
| --- | --- | --- | --- |
| (a) one full-stack repo | yes | yes, PR visible | yes, unless you choose the minimum plan |
| (b) separate frontend + backend repos | yes | yes, two linked PRs | yes |
| request that needs clarifying questions | yes | yes | part of (a) and (b) |
| too-big task → split | yes | yes | – |
| request changes → redraft from task chat | yes | yes | – |
| spec edit resets approvals | yes | yes | – |
| failing tests → "needs attention" | yes | yes | – |
| rebase conflict | yes (harness pushes a conflicting commit) | yes | – |
| restart mid-build resumes | yes | yes | part of (b) |
| cancel | yes | yes | – |
| Jira flows | written, skipped unless `TANDEM_E2E_JIRA=1` | skipped | – |

**Exit:** every row above passes; links to the sandbox PRs (or working
fallback links) in the evidence file.

## Phase 5 – Packaging and docs

`pnpm tandem` (build if stale, start, open browser, doctor on first run),
`pnpm tandem doctor`; README, `docs/USER_GUIDE.md`, `docs/RUNBOOK.md`,
`docs/ADAPTERS.md`, `docs/ENABLE_JIRA.md`, `CHANGELOG.md`; secret scan of
the repo, the DB and the logs after the e2e runs; a from-scratch setup
following only the docs; tag `v1.0.0`.

**Exit:** the Definition of Done checklist below, each item with evidence.

---

## Definition of Done checklist

- [ ] `pnpm tandem doctor` passes on your machine (Jira shown as optional)
- [ ] build, type-check, lint, all tests pass
- [ ] both e2e scenarios pass from chat against real sandbox repos, PRs
      visible in CodeCommit (or fallback links work). On the minimum Copilot
      plan, (a) runs with the scripted agent and (b) with live Copilot.
- [ ] every Phase 4 failure-path test passes
- [ ] restart during BUILDING resumes correctly
- [ ] Jira adapter unit tests pass; enabling Jira only needs a token in
      Settings
- [ ] no secrets in logs, DB, or committed files (scan output attached)
- [ ] docs let a new user set up from scratch (walk-through recorded)

---

## Risks and how they are handled

| Risk | Handling |
| --- | --- |
| Your org's Copilot policy blocks CLI/SDK use | Spike a checks this first; nothing else is built on Copilot until it passes. |
| SDK and runtime change quickly (1.0.x releases weekly) | Exact pins; the adapter reads the live tool list and fails closed on unknown tool names; spike a re-run is part of upgrading. |
| Model ignores instructions | Safety and gates are enforced in code (tool filter, permission handler, hook, deterministic readiness/spec/verify checks), not by prompts. |
| CodeCommit permission probe behaves differently than expected | Spike c confirms it; if it doesn't hold, the fallback is "try to create, fall back to link on AccessDenied", which is also safe because of `clientRequestToken`. |
| `node:sqlite` is experimental in Node 22 | Hidden behind the repository layer; `better-sqlite3` is a drop-in alternative there. |
| No Secret Service on headless Linux | Doctor detects it; Jira/GitHub tokens can't be saved until one is installed (no file fallback by design). |
| Shared Copilot plan | Development and tests use the scripted agent and recorded fixtures; live runs only at the end with your approval and a hard cap; Tandem has per-task and per-day limits (ARCHITECTURE.md §7). |
| The scripted agent hides a real-model problem | The live runs at the end cover the main path for real, and the free runtime checks cover enforcement in the real runtime. Recorded event streams keep the adapter honest about real event shapes. |
| Squash merges defeat git-ancestry merge detection in fallback mode | "Mark as merged" button; API polling is used whenever a profile or token exists. |
