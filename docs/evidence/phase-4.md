# Phase 4 evidence: end to end

Every scenario runs through the real server (`apps/server/dist/cli.js start`, a child process)
and its HTTP API, the way the web app drives it, starting from chat Request mode with: "Add a GET
/health endpoint returning {status: 'ok'} and show the status on the main page." The agent is
the scripted one: no Copilot prompts. Builds run the sandbox repos' real checks (`npm ci`, lint,
type-check, build, the test suite and one test per criterion).

```sh
pnpm build
pnpm test:flows                                          # local remotes
TANDEM_E2E_REAL=1 TANDEM_AWS_PROFILE=<profile> pnpm test:flows   # real CodeCommit
```

Suite: `e2e/flows/workflow.e2e.test.ts` (harness: `e2e/flows/harness.ts`), Jira:
`e2e/flows/jira.e2e.test.ts`, live Copilot: `e2e/flows/copilot.e2e.test.ts` (skipped unless
`TANDEM_E2E_COPILOT=1`; it spends AI credits, so it runs only with the owner's go-ahead).

## Results

| Scenario | Scripted agent, local remotes | Scripted agent, real CodeCommit | Live Copilot |
| --- | --- | --- | --- |
| (a) one full-stack repo | ✅ 42 s | ✅ 67 s, PR #8 opened by Tandem | ✅ 2.9 min, 0.94 credits (+0.17 chat) |
| (b) separate frontend + backend repos | ✅ 56 s, two cross-linked PRs | ✅ 92 s, PRs #9 and #10, cross-linked | ✅ 3.7 min, 1.15 credits (+0.21 chat), two cross-linked PRs |
| request that needs clarifying questions | ✅ in every scenario: a question, "not ready" refused, the answer, then ready | ✅ | the live requests were complete, so the agent marked them ready on the first reply |
| too-big task → split | ✅ 880 lines → 4 parts accepted (parent cancelled, each part drafts its spec); and overridden with a reason | ✅ 33 s | – |
| request changes → redraft from task chat | ✅ task chat proposes the change, owner confirms, spec v2 | ✅ | – |
| spec edit resets approvals | ✅ owner approval of v2 stops counting after the edit to v3; the build starts only after both keys on v3 | ✅ (with the redraft, 15 s) | – |
| failing tests → "needs attention" | ✅ 3 verification runs, 2 fix runs, PR titled `[needs attention]` | ✅ 96 s, PR #13 `[needs attention]` | – |
| rebase conflict | ✅ another developer changes the same lines while the task verifies; the agent resolves it, checks run again, both changes are in the pushed branch | ✅ 68 s, the other developer's commit pushed to CodeCommit, PR #12 | – |
| restart mid-build resumes | ✅ `kill -9` of the server and its child processes during verification, a new start, the task finishes | ✅ 55 s, PR #11 | part of (b) |
| cancel | ✅ cancelled during verification: the task folder is removed, nothing is pushed, no PR | ✅ 47 s, no branch pushed, no PR | – |
| Jira flows | written, skipped without `TANDEM_E2E_JIRA=1` | skipped | – |

Local run: 8/8 passed in 6.1 minutes (Ubuntu 20.04, Node 22.23.1, git 2.25.1). Again after the
dependency cache (problem 10): 8/8 in 4.2 minutes; (a) 34 s, (b) 42 s.

## Live Copilot

Run on 2026-11-03 with the owner's go-ahead, on `gpt-6-luna` (picked in chat with the new model
picker), against local copies of the sandbox repos (the AWS sign-in had expired; the Copilot part is
the same either way, only the last step is a prefilled console link instead of a created PR). Hard
limits for the run: 15 AI credits per task, 40 per day, 60 model calls per run.

| | (a) one full-stack repo | (b) frontend + backend |
| --- | --- | --- |
| Path | chat → readiness → spec → review → build → checks → self-review → PR | same, backend first, then frontend |
| Chat turns to ready | 1 | 1 |
| Checks | passed on the first run, no fix attempts | passed on the first run |
| Criteria with a passing test | 3 of 3 | 2 of 2 (criterion 2 tested in both repos) |
| Self-review findings | none | none |
| Needs attention | no | no |
| Task credits / model calls | 0.94 / 13 | 1.15 / 19 |
| Time | 2.9 min | 3.7 min |

Copilot spend today: 2.47 credits for this run (40 model calls: request chat 0.39, specs 0.45,
builds 1.42, reviews 0.22), 1.53 for a first attempt stopped on purpose after it failed (problem 6
below), and 0.05 for one structured-output check after the fix: about 4.1 credits in total.

The picker's "credits per task" estimate is calibrated on these runs (1.3 on `gpt-6-luna`).

Screenshots (real model list of the account, light and dark): `phase-4/picker-*.jpg`,
`phase-4/live-task-overview-*.jpg`, `phase-4/live-task-changes-*.jpg`.

With local remotes, the PR API answers "access denied", so every PR is the prefilled console link
(checked to point at the right repository, base branch and agent branch). On real CodeCommit
with a profile that may create PRs, Tandem opens them itself: the real run (2026-11-03, 8/8 in
8.8 minutes, scripted agent, no credits) opened PRs #8–#13 in the three sandbox repositories through
the CodeCommit API, each from its agent branch into the run's base branch, with the spec, checks and
review in the description.

## Problems found and fixed in this phase

1. **A crash during `git worktree add` broke the repository for every later task.** Git writes a
   placeholder HEAD (all zeros) before the real one; a task cancelled or killed in between left
   that entry behind, and from then on every `git fetch` in the mirror failed with "bad object
   worktrees/…/HEAD". Cleanup could not remove it either (`git worktree remove` refuses a broken
   worktree, and `prune` keeps entries whose folder exists), and a resumed task reused the broken
   folder because it only checked that the folder existed. Now: git operations on a mirror run one
   at a time (a fetch can no longer see another task's half-made worktree); broken entries are
   repaired before every fetch and worktree add; an existing worktree is checked and its checkout
   completed or remade; removal deletes the folder when git can't. Covered by new git tests that
   reproduce the "bad object" failure.
2. **Fix and conflict runs were recorded as "build".** The run history now says `fix` and `conflict`.
3. **The frontend sandbox failed its own type-check** (`process` in `vite.config.ts` without Node's
   types), so every two-repo task ended "needs attention". The template now reads its variables
   through Vite's `loadEnv`. Real-CodeCommit runs apply the current template to their run branch, so
   the sandbox repos' `main` stays untouched.
4. The scripted agent's size estimate now grows with the number of features a request lists (three
   or more is too big, with a split proposal), so the split path runs end to end.

Found by the live Copilot run (the scripted agent could not show these):

5. **Every real full-stack task was blocked as "too big".** The model estimated 40 lines but listed
   "Health endpoint" and "Main-page health status" as two features, and any two features blocked.
   Now a split needs more lines than the limit, three or more features, or two that the estimate
   itself proposes to split; the prompts define an independent feature as one that is useful
   shipped on its own (an endpoint and the page that shows it are one).
6. **Self-review failed with a 400 on OpenAI models.** Structured output is sent as strict JSON
   Schema, where every property must be required; the review's optional `repo`/`file`/`line` were
   not. The Copilot adapter now sends a strict form of every schema (all fields required, optional
   ones nullable, no extra keys) and maps nulls back before validating. Checked live with one
   capped prompt (0.05 credits), then the full run.
7. **That 400 was retried three times.** The "retry on 5xx" pattern matched `520` inside the request
   ID. Request IDs are ignored now, and 4xx answers (other than 429) are never retried.
8. **A failed agent run was recorded as succeeded** once its session closed. Failed runs stay failed.
9. The local-remote test switch (`TANDEM_TEST_REMOTE_ROOT`) only worked with the scripted agent;
   it now works with either, and the start banner and log say when it is on.

Found by looking at disk use (the owner asked whether every task copies everything):

10. **Every task kept its own installed dependencies.** The git side was already shared (one mirror
    per repo; a task's checkout is 0.2 to 0.7 MB of files), but `node_modules` is 150 to 230 MB per
    sandbox repo, about 99.6% of a task, and stayed until the task finished. Now installs are cached
    per repo and lockfile, the way pnpm does it: after a clean install Tandem keeps the dependency
    folders once, and every later task or retry with the same lockfile gets them as hard links (no
    download, no extra space, about a second). Tool caches inside `node_modules` are never shared,
    a real install first removes shared links so it can never write into the cache, and each repo
    keeps its three most recent installs (none older than two weeks). A task waiting on review drops
    its links; checks restore them. Below `limits.minFreeDiskGb` (2 GB) a task waits with "Low disk
    space" instead of failing mid-install. Measured on the local suite: task folders 4.1 MB in total
    for 13 tasks (about 1.3 GB before), one shared install per repo (575 MB), reused 6 times.
11. Tests left their temporary folders behind (1,467 folders, 2.4 GB on this machine, now removed).
    Test runs now delete what they create.
