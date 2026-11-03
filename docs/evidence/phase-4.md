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
`e2e/flows/jira.e2e.test.ts`.

## Results

| Scenario | Scripted agent, local remotes | Scripted agent, real CodeCommit | Live Copilot |
| --- | --- | --- | --- |
| (a) one full-stack repo | ✅ 42 s | pending: AWS sign-in expired | pending: asks first |
| (b) separate frontend + backend repos | ✅ 56 s, two cross-linked PRs | pending | pending |
| request that needs clarifying questions | ✅ in every scenario: a question, "not ready" refused, the answer, then ready | pending | part of (a)/(b) |
| too-big task → split | ✅ 880 lines → 4 parts accepted (parent cancelled, each part drafts its spec); and overridden with a reason | pending | – |
| request changes → redraft from task chat | ✅ task chat proposes the change, owner confirms, spec v2 | pending | – |
| spec edit resets approvals | ✅ owner approval of v2 stops counting after the edit to v3; the build starts only after both keys on v3 | pending | – |
| failing tests → "needs attention" | ✅ 3 verification runs, 2 fix runs, PR titled `[needs attention]` | pending | – |
| rebase conflict | ✅ another developer changes the same lines while the task verifies; the agent resolves it, checks run again, both changes are in the pushed branch | pending | – |
| restart mid-build resumes | ✅ `kill -9` of the server and its child processes during verification, a new start, the task finishes | pending | part of (b) |
| cancel | ✅ cancelled during verification: the task folder is removed, nothing is pushed, no PR | pending | – |
| Jira flows | written, skipped without `TANDEM_E2E_JIRA=1` | skipped | – |

Local run: 8/8 passed in 6.1 minutes (Ubuntu 20.04, Node 22.23.1, git 2.25.1).

With local remotes, the PR API answers "access denied", so every PR is the prefilled console link
(checked to point at the right repository, base branch and agent branch). On real CodeCommit
with a profile that may create PRs, Tandem opens them itself.

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
