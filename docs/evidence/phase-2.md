# Phase 2 evidence: core and adapters

Run on the owner's machine (Ubuntu 20.04, Node 22.23.1, git 2.25.1). No Copilot model
calls were made in Phase 2: every workflow test uses the scripted agent, and the Copilot
adapter is covered by unit tests, a replay of the event stream recorded in spike a, and a
real-runtime self-test that sends no prompt.

## Results

| Check | Result |
| --- | --- |
| `pnpm typecheck` (build + tests) | exit 0 |
| `pnpm lint` | exit 0 |
| `vitest run --coverage` (unit + integration) | 16 files, 201 tests passed (2 real-CodeCommit tests skipped without `TANDEM_REAL=1`) |
| Line coverage, `packages/core/src` | 99.4 % (gate: 85 %) |
| Line coverage, all packages | 93.0 % |
| Real CodeCommit (`pnpm test:real`, scripted agent) | 2/2 passed: host checks and a full workflow to a real PR |

## What is covered

- **Core (unit, in-memory store, fakes).** State machine table; runner (leases, recovery
  after a crash, lanes, retries with backoff, budget block, failure and retry, cancel
  while a step runs); readiness, size, shell, path and tool policies (60+ allowed and
  denied command lines); redaction; spec validation and finalization; PR descriptions;
  config; budget. Workflow scenarios: both project shapes, missing readiness, Jira-style
  extraction, split accepted or overridden, request changes and redraft, a spec edit
  resetting approvals, open questions blocking approval, PM via Jira (only configured
  PMs count; "changes:" redrafts), failing tests leading to "needs attention", a fix that
  passes, single-test and integration commands, missing test coverage, self-review fixes,
  rebase conflicts (resolved, unresolved, resolved but failing), push rejected and lease
  re-push, manual PR fallback followed to merge, a PR closed without merging, restart
  mid-build in the same agent session, cancel, transient and permanent agent errors, the
  Copilot budget, learned rules. Chat: Ask with checked file references and session
  resume, Request mode clarifying until the Definition of Ready passes and creating the
  task without a separate size call, task chat proposing a redraft or an exact edit that
  the owner confirms. Repo detection for Node (npm, pnpm, yarn), Python, Go, Java,
  Gradle, .NET and Rust, including the three sandbox templates.
- **Store contract.** The same suite runs against the in-memory store and SQLite:
  every repository, rollback, isolation of open transactions, reopening the file,
  redaction on write.
- **Adapters (unit).** Jira Cloud and Data Center against a fake server (auth, search
  paging, ADF, transitions, PM replies, every error class, the token never appearing in
  errors). CodeCommit (URLs, console links, idempotent PRs, permission probe, fallbacks,
  status) and GitHub (URLs including `*.ghe.com`, reuse of an existing PR, compare-link
  fallback, status) with fake clients. Copilot runtime: enforcement wiring, streaming and
  usage per turn, model choice by tier, resume fallback, model-call cap, timeout, error
  classification, tool argument validation, restart on a host change, replay of the live
  event stream. Process runner: line streaming, process-tree kill, credentials kept out.
- **Integration (real git, local bare remotes).** Git layer: mirror, worktrees, commits,
  rebase (clean and conflicting), lease push, branch guard, reference checkouts. Whole
  workflow on SQLite with the real process runner and local tracker: full-stack to merged
  PR, split repos in contract order, a real rebase conflict resolved, an unresolved
  conflict blocking cleanly, failing tests leading to "needs attention", restart with the
  database reopened.
- **Integration (real Copilot runtime, 0 model calls).** The safety self-test: 8/8
  forbidden actions denied.
- **Integration (real CodeCommit, eu-central-1 sandbox).** Preflight (read, AWS, PR
  permission), mirror, push, an idempotent PR, status, description update, close; then a
  full workflow from request to an open PR, with the sandbox's real `npm ci`, lint,
  type-check, build and test all passing. PRs were closed and branches deleted
  afterwards.

## Bugs the tests found (all fixed)

1. SQLite `INSERT OR REPLACE` moved updated rows to the end (lists came back reordered).
   It is now a true upsert.
2. Transactions were not isolated: a read from outside could run inside an open
   transaction (the "in transaction" flag was global). Both stores now use one
   locked-store wrapper.
3. The memory store didn't sort tracker comments by time.
4. Runner race: a tick started by a service action could make `runUntilIdle` return
   early. Ticks now wait for one in flight.
5. Spec validation treated "None." as an empty section.
6. GitHub URLs on `*.ghe.com` hosts weren't recognized.
7. The agent-branch guard allowed `agent//x`.
8. A conflict whose markers were resolved but not `git add`-ed blocked the task. It now
   counts as resolved; Tandem stages it when continuing.
