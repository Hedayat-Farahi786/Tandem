# Phase 5 evidence: packaging, docs, release

## Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| `pnpm tandem doctor` passes (Jira shown as optional) | ✅ | From-scratch walkthrough below: "Everything required passes, with 2 warnings" (disk space and keychain on the reference machine); Jira "Not configured (optional)". |
| build, type-check, lint, all tests pass | ✅ | `pnpm build && pnpm typecheck && pnpm lint && pnpm test:coverage`: 286 tests pass (2 skipped need real CodeCommit), core coverage 98.3%. Browser tests 9/9 with axe in light and dark. |
| both e2e scenarios from chat against real sandbox repos, PRs visible | ✅ | Scripted agent on real CodeCommit: 8/8 scenarios, PRs #8–#13 opened by Tandem through the API ([phase-4.md](phase-4.md)). Live Copilot: (a) one full-stack repo, 0.94 credits, and (b) frontend + backend with two linked PRs, 1.15 credits, on copies of the same sandbox repos (phase-4.md, "Live Copilot"). |
| every Phase 4 failure-path test passes | ✅ | Local flows 9/9 on 2026-11-03 after the last code change: clarifying questions, split, request changes, spec edit resets approvals, cancel, restart, rebase conflict, conflict after the PR is open, failing tests → needs attention. |
| restart during BUILDING resumes correctly | ✅ | `workflow.test.ts` "resumes a build interrupted by a restart, in the same agent session"; flows "restart mid-build" (`kill -9` of the server and its children during verification, real server and git); `workflow.it.test.ts` "survives a restart". |
| Jira adapter unit tests pass; enabling Jira only needs a token in Settings | ✅ | `jira-tracker.test.ts`; import by key and by query in `workflow.test.ts`; the tracker switches to Jira when the URL and token exist, without a restart (`compose.ts`). Real Jira flows need a Jira token, which this machine can't store yet (no keychain; see ENABLE_JIRA.md). |
| no secrets in logs, DB, or committed files | ✅ | Scan below. |
| docs let a new user set up from scratch | ✅ | Walkthrough below. |

## Secret scan

Run on 2026-11-03 after all e2e runs (script kept outside the repo; it
prints counts, never values). It looks for token formats (AWS keys, GitHub
`ghp_`/`gho_`/`github_pat_`, Atlassian `ATATT`, Slack, private keys, JWTs),
for the **live** values of both signed-in GitHub tokens and the four AWS
session credential values, and for the company identifiers (AWS account,
Copilot host, work login).

```
repo files (tracked):              token patterns=10 live tokens/keys=0 company identifiers=1 (the AWS profile name, see below)
repo history (all commits):        token patterns=10 live tokens/keys=0 company identifiers=1 (same)
db ~/.tandem/tandem.db:            token patterns=0  live tokens/keys=0
db live Copilot home:              token patterns=0  live tokens/keys=0
db local flows home:               token patterns=0  live tokens/keys=0
db conflict flow home:             token patterns=0  live tokens/keys=0
db browser test home:              token patterns=0  live tokens/keys=0
db real CodeCommit run:            token patterns=0  live tokens/keys=0
logs (all five homes):             token patterns=0  live tokens/keys=0
real CodeCommit server.log, run.log: token patterns=0 live tokens/keys=0
```

The 10 pattern matches in the repo are the fake values the redaction tests
feed in (`policies.test.ts`, `store.contract.test.ts`) and the redactor's
own pattern. The one name the first pass flagged (the AWS profile) is the
owner's first name, which is already in the public repository owner; no AWS
account ID, Copilot host or work login is in any file or commit.

## From-scratch setup, following only the docs

2026-11-03, on the reference machine (Ubuntu 20.04, Node 22.23, git 2.25),
with a new data folder and port so the existing one wasn't touched:

1. README › Install and start: `git clone` from GitHub, `pnpm install`
   (2.3 s with a warm pnpm store), `pnpm tandem --no-open`, which printed
   "Building Tandem (no build yet)…", started, and ran the doctor on the
   first launch.
2. User guide › First-time setup, driven in the browser:
   - The first launch opened the setup wizard.
   - **Repositories**: `codecommit::eu-central-1://<profile>@tandem-sandbox-fullstack`
     was cloned from real CodeCommit and detected: default branch `main`,
     `npm ci`, `npm run lint`, `npm run build`, `npm test`.
   - **Project** "Shop" created.
   - **Copilot and AWS**: name, Copilot host and AWS profile saved.
   - **Jira (optional)** skipped.
   - **Check**: "Everything required passes, with 2 warnings". Copilot was
     signed in, with 18 models available; the safety rules blocked 8 of 8
     actions with no model calls; the repo was readable; AWS was signed in
     and may create pull requests. The two warnings were disk space and the
     keychain.
   - **Finish and open chat**: "What should we build?".

No Copilot prompts were used. The clone and its data were deleted after.

## Changes in this phase

- **Launcher.** `pnpm tandem` (`scripts/tandem.mjs`) builds only when a
  package's source, `package.json` or the lockfile is newer than its build,
  then runs the CLI. A second start skips the build (1.1 s).
- **Docs.** `README.md`, `docs/USER_GUIDE.md`, `docs/RUNBOOK.md`,
  `docs/ADAPTERS.md`, `docs/ENABLE_JIRA.md`, `CHANGELOG.md`; the
  architecture doc is updated for the dependency cache, `disk-low` and open
  PR syncing.
- **Open PRs stay mergeable.** When the base branch moves and conflicts,
  Tandem merges it into the PR branch, resolves the conflict, runs checks
  and pushes without force. It leaves branches others pushed to alone
  unless asked, and never touches rewritten ones. Tested in unit tests,
  against real git, and end to end. Screenshot:
  `phase-5/pr-updated-from-base-*.jpg`.
- **UI.**
  - Conversations moved into the main sidebar.
  - The accent is #0B0B0B in light mode and the inverse (#F2F1EE) in dark
    mode; both pass the axe contrast checks.
  - **Tasks › Import from Jira**.
  - **Fix conflicts** on a pull request.
  - A **Settings** switch for fixing conflicts automatically.

## Problems found and fixed in this phase

1. **A wake-up during a running step was lost.** "Mark as merged" during a
   PR check finished the task 5 minutes late, because the check rescheduled
   itself over the wake-up. The runner now keeps it, and a test reproduces
   the race and fails without the fix.
2. **Jira's Ready query from Settings was never used**, so with the defaults
   nothing was imported. The project's own query now wins, then the Settings
   query. With several projects, only projects with their own query are
   polled.
3. **Logs were never deleted**, though 14 days were documented. They're now
   pruned at start.
4. **Browser tests left about 250 MB in `/tmp` per run.** Playwright loaded
   the config twice (two folders per run), and the test server treated its
   folder as the caller's. It now uses one fixed folder that is emptied at
   start and removed after; failure traces are kept.
5. **The PR status line didn't update live.** The PR check now notifies the
   page.
