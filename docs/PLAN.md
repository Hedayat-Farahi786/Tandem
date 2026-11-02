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
| Okay to spend Copilot premium requests on spikes and e2e | Phase 1a, 4 | Rough estimate: 10–20 requests per e2e scenario run, about 150–250 in total. |
| A GitHub sandbox repo (optional) | Phase 2 GitHub adapter real test | Without it the GitHub adapter is tested against mocks and local remotes only. |

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

**a) Copilot SDK with your existing login**
1. `CopilotClient` start, `getAuthStatus()` shows your login with no token
   passed; record whether the bundled runtime or `COPILOT_CLI_PATH` (your
   installed CLI) is needed.
2. `listModels()`; record the default and whether `auto` exists.
3. Streaming chat: read-only session, `assistant.message_delta` events
   arrive before `session.idle`; time to first token recorded.
4. Build session in a worktree of a sandbox repo: agent makes a small edit,
   runs the repo's tests through the shell tool, a denied command (`git
   push`, `aws …`) is rejected by the permission handler, a write outside
   the worktree is rejected, session ends cleanly (`disconnect`, `stop`).
5. Structured output with a zod schema returns parsed data.
6. `resumeSession` after killing the Node process mid-turn.
7. Record the error shown when the model or policy is unavailable.

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

| Scenario | Scripted (container) | Real (your machine) |
| --- | --- | --- |
| (a) one full-stack repo | yes | Copilot + CodeCommit, PR visible |
| (b) separate frontend + backend repos | yes | Copilot + CodeCommit, two linked PRs |
| request that needs clarifying questions | yes | yes |
| too-big task → split | yes | yes |
| request changes → redraft from task chat | yes | yes |
| spec edit resets approvals | yes | yes |
| failing tests → "needs attention" | yes | scripted agent, real repos |
| rebase conflict | yes | scripted agent, real repos (harness pushes a conflicting commit to the sandbox default branch) |
| restart mid-build resumes | yes | Copilot, process killed during BUILDING |
| cancel | yes | yes |
| Jira flows | written, skipped unless `TANDEM_E2E_JIRA=1` | skipped |

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
      visible in CodeCommit (or fallback links work)
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
| Premium request usage | Read-only steps reuse one session per step; chat sessions are resumed rather than recreated; e2e budget stated up front. |
| Squash merges defeat git-ancestry merge detection in fallback mode | "Mark as merged" button; API polling is used whenever a profile or token exists. |
