# Tandem runbook

How to run, inspect, fix and upgrade a Tandem installation. For everyday use,
see the [user guide](USER_GUIDE.md).

## Start, stop, check

```sh
pnpm tandem                # build if needed, start on 127.0.0.1:4317, open the browser
pnpm tandem --no-open      # same, without the browser
pnpm tandem doctor         # all checks in the terminal; exit code 1 if a required one fails
pnpm tandem doctor --json  # the same as JSON
```

Ctrl+C stops Tandem. Work in progress is saved after every step: on the next
start, each task continues from the step it was on, including after a crash
or a `kill -9`. A step that was running is run again from its start.

Tandem only listens on 127.0.0.1 and only answers requests addressed to
`127.0.0.1:<port>` or `localhost:<port>`; anything else gets
`421 Misdirected Request`. Over SSH or VS Code Remote, forward the port to
the **same** local port (4317 to 4317).

## Data on disk

Everything lives in `TANDEM_HOME` (default `~/.tandem`):

| Path | What | Safe to delete? |
| --- | --- | --- |
| `tandem.db` (+ `-wal`, `-shm`) | all state: projects, tasks, specs, approvals, runs, chats, settings. No secrets. | No: this is your data. |
| `logs/tandem-YYYY-MM-DD.log` | JSON logs, redacted, one file per start day, 14 days kept | Yes |
| `mirrors/<host>/<repo>.git` | one bare clone per repository, fetched before use | Yes, when Tandem is stopped; recloned on next use |
| `projects/<id>/<repo>/` | read-only checkouts for chat, specs and reviews | Yes, when stopped; recreated |
| `tasks/<id>/<repo>/` | one git worktree per task and repository | Only for finished or cancelled tasks (Tandem removes those itself) |
| `tasks/<id>/.tandem/` | check logs and diffs of that task | Same as above |
| `deps/<repo>/<key>/` | shared installed dependencies (see below) | Yes, when stopped; the next check reinstalls |

Secrets (the AWS connection, Jira and GitHub tokens) are in the OS keychain
under the service name `tandem`, never in these files. The Copilot sign-in
is kept by the Copilot runtime in the keychain, with its state in
`copilot/`. `bin/` holds the git credential helper Tandem writes at start
(it asks the running Tandem for credentials and stores none).

### Backups

Back up while Tandem runs; no extra tool is needed:

```sh
pnpm tandem backup --to ~/tandem-backups/2026-11-05
```

The backup holds the database: projects, tasks, chats, approvals and the audit log. It doesn't
hold repository copies, which come back from the repositories, or secrets, which stay in your
keychain.

To restore, stop Tandem, move `~/.tandem` aside, then run:

```sh
pnpm tandem restore --from ~/tandem-backups/2026-11-05
```

To restore over existing data instead, add `--force`.

## Disk space

- **Git history** is shared: each repository is cloned once into `mirrors/`,
  and each task adds a worktree with just the checked-out files.
- **Installed dependencies** are shared: the first install for a lockfile is
  kept in `deps/` and later tasks with the same lockfile get hard links to
  it, which use no extra space. The 3 most recent installs per repository
  are kept, and any not used for 14 days are removed.
- While a pull request waits for review, its task folder drops its
  dependencies; they come back from the cache if checks run again.
- Before installing, Tandem checks for free space. Below
  `limits.minFreeDiskGb` (Settings, default 2 GB) the task waits with
  **Low disk space** instead of failing halfway. Free space, then **Resume**.

The doctor shows free space and the size of the dependency cache.

## Configuration

Settings edited in the UI are stored in the database. Environment variables
override them; `.env.example` lists every one. The most useful:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TANDEM_HOME` | `~/.tandem` | data folder |
| `TANDEM_PORT` | `4317` | port on 127.0.0.1 |
| `TANDEM_LOG_LEVEL` | `info` | `debug` for more detail |
| `TANDEM_AWS_PROFILE`, `TANDEM_AWS_REGION` | default chain | CodeCommit access |
| `TANDEM_CREDITS_PER_TASK`, `TANDEM_CREDITS_PER_DAY` | 25, 75 | Copilot AI credit limits for a **new install**; then set in Settings |
| `TANDEM_BUDGET_PER_TASK`, `TANDEM_BUDGET_PER_DAY` | 15, 40 | Copilot prompt limits for a **new install**; then set in Settings |
| `TANDEM_MAX_CONCURRENT_BUILDS` | 1 | builds at a time |

## Fixing common problems

### AWS: "Sign in again" or 403 on CodeCommit

An IAM Identity Center sign-in renews itself for as long as your company
allows (often 8 hours to 90 days), then expires. Settings › AWS shows
**Expired**; choose **Sign in again**, confirm the code in the browser, and
**Resume** any task that was waiting. The sign-in works from any device:
the code page can be opened on your phone. With a profile from this
computer, renew it the way you usually do for that profile. Without permission to create pull
requests, Tandem gives you a prefilled console link instead.

### Copilot: "This account can't use Copilot here" (403)

The signed-in GitHub account has no Copilot seat on that host. If your seat
comes from a GitHub Enterprise host (`yourcompany.ghe.com`):

1. Settings › Copilot › Add another account › Your company's GitHub, and
   sign in with `yourcompany.ghe.com` in the browser.
2. Choose "Use this account" next to it.
3. `pnpm tandem doctor`

When this check fails and the GitHub CLI is signed in to another host, the
doctor names that host as the likely fix.

### "No usable OS keychain"

Only needed to save a Jira or GitHub token. macOS and Windows always have
one. On Linux, see [Enable Jira › Keychain on Linux](ENABLE_JIRA.md#keychain-on-linux).

### A task is waiting

Every waiting task says why and what to do on its page. Fix the cause, then
**Resume**. A **failed** task (an error that retries did not fix) shows the
error; **Retry** runs that step again. The task's timeline shows every
transition with its reason; the log has the details:

```sh
grep '"taskId":"<id>"' ~/.tandem/logs/tandem-$(date +%F).log | tail
```

### Copilot limit reached

A run stopped at the per-task or per-day limit. Raise it in Settings ›
Copilot budget, then **Resume**. Today's use is shown on the same card. The
day resets at midnight local time.

### Conflicts

- **Before the pull request** (rebase conflict): Tandem rebases the branch
  onto the latest default branch before pushing and lets the agent resolve
  conflicts. If it can't, the task waits with the files listed. Resolve
  them on the `agent/…` branch, push, and **Resume**.
- **After the pull request is open**: see
  [Keeping pull requests mergeable](USER_GUIDE.md#keeping-pull-requests-mergeable).

### A repository is in a bad state

Stop Tandem, delete `mirrors/<host>/<repo>.git` and `projects/<id>/<repo>`,
and start again: Tandem clones it again. Do this only when no task is
working on that repository: task worktrees live inside the mirror, so a
task's unpushed work would be lost. A worktree left half-made by a crash
does not need this; Tandem repairs those itself.

## Upgrading

```sh
git pull
pnpm install
pnpm tandem      # rebuilds because the source changed
```

The database is migrated on start. Back it up first (see above).

## Test modes

These are for developing Tandem; none of them call Copilot unless stated.

| Command | What it does |
| --- | --- |
| `pnpm test` | unit, integration and web tests |
| `pnpm test:ui` | browser tests with axe checks in light and dark (`TANDEM_SCREENSHOTS=1` saves screenshots) |
| `pnpm test:flows` | end-to-end flows through the real server on local bare git remotes, scripted agent |
| `TANDEM_E2E_REAL=1 TANDEM_AWS_PROFILE=<p> pnpm test:flows` | the same flows on real CodeCommit sandbox repositories |
| `TANDEM_E2E_COPILOT=1 pnpm test:flows e2e/flows/copilot.e2e.test.ts` | **live Copilot, spends AI credits**: two short tasks with hard caps (15 credits per task, 40 per day), cheapest model by default (`TANDEM_E2E_MODEL`) |

`TANDEM_E2E_PORT=<port>` runs a flow on a fixed port so you can watch it in
the browser, and `TANDEM_E2E_DIR=<dir>` keeps its data afterwards.
`TANDEM_E2E_MIN_FREE_DISK_GB=1` lowers the low-disk guard (default 2 GB) for
the flows' own data, on a machine short of disk.
`TANDEM_AGENT=scripted` starts Tandem with the scripted agent, and
`TANDEM_TEST_REMOTE_ROOT=<dir>` serves CodeCommit repositories from local
copies in `<dir>/<name>.git`; the sidebar then shows a test-mode badge.
