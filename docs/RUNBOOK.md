# Tandem runbook

How to run, inspect, fix and upgrade Tandem. Running it for a team, on a
server, is in [Deploying Tandem](DEPLOYMENT.md); everyday use is in the
[user guide](USER_GUIDE.md). This page covers Tandem on one computer (to try
it or develop it) and company runners.

## Start, stop, check

```sh
pnpm tandem                # build if needed, start the web app at http://localhost:4317, open the browser
pnpm tandem --no-open      # same, without the browser
tandem runner              # a company runner (after its first start with --url and --key)
tandem doctor              # check a computer for a company runner; exit code 1 if a required check fails
```

`pnpm tandem` needs the GitHub App's client ID and secret
(`TANDEM_GITHUB_CLIENT_ID`, `TANDEM_GITHUB_CLIENT_SECRET`, in the environment
or `.env`). Signing in, the first person gets a workspace of their own, and
its setup wizard.

Ctrl+C stops Tandem. Work in progress is saved after every step: on the next
start, each task continues from the step it was on, including after a crash
or a `kill -9`. A step that was running is run again from its start.

On one computer, Tandem listens on 127.0.0.1 and answers only requests for
its own address (`localhost:<port>` or `127.0.0.1:<port>`); anything else
gets `421 Misdirected Request`. Over SSH or VS Code Remote, forward the port
to the **same** local port (4317 to 4317).

## Data on disk

Everything lives in `TANDEM_HOME` (default `~/.tandem`):

| Path | What | Safe to delete? |
| --- | --- | --- |
| `directory.db` | people, sessions, workspaces, members, invitations; tokens and workspace secrets, sealed | No: this is who may do what |
| `secret.key` | the key that seals them (one computer only; a server takes it from its secret manager) | No: without it, every sign-in and connection must be made again |
| `workspaces/<id>/tandem.db` | one workspace: projects, tasks, specs, approvals, runs, chats, settings, the audit log | No: this is the workspace's data |
| `workspaces/<id>/mirrors/<host>/<repo>.git` | one bare clone per repository, fetched before use | Yes, when Tandem is stopped; recloned on next use |
| `workspaces/<id>/projects/<id>/<repo>/` | read-only checkouts for chat, specs and reviews | Yes, when stopped; recreated |
| `workspaces/<id>/tasks/<id>/<repo>/` | one git worktree per task and repository | Only for finished or cancelled tasks (Tandem removes those itself) |
| `workspaces/<id>/deps/<repo>/<key>/` | shared installed dependencies (see below) | Yes, when stopped; the next check reinstalls |
| `logs/` | JSON logs, redacted, one file per day, 14 days kept | Yes |

A company runner keeps its workspace in `~/.tandem-runner`, laid out like
one `workspaces/<id>/` folder; its secrets (the runner key, AWS, Jira and
GitHub tokens, the Copilot sign-in) are in that computer's keychain.

### Backups

Back up while Tandem runs; no extra tool is needed:

```sh
tandem backup --to ~/tandem-backups/2026-11-05
```

The backup holds every database (the directory and each workspace) and, on
one computer, the secret key. It doesn't hold repository copies, which come
back from the repositories. To restore, stop Tandem, move `~/.tandem` aside,
then run `tandem restore --from ~/tandem-backups/2026-11-05` (`--force`
restores over existing data). With `TANDEM_HOME=~/.tandem-runner`, the same
commands back up a company runner.

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

`.env.example` lists every setting, and [Deploying Tandem](DEPLOYMENT.md#2-settings)
explains them. Workspace settings (models, budgets, limits, connections) are
edited in the app, per workspace; the environment only gives new workspaces
their starting values.

## Fixing common problems

### AWS: "Sign in again" or 403 on CodeCommit

An IAM Identity Center sign-in renews itself for as long as your company
allows (often 8 hours to 90 days), then expires. Settings › AWS shows
**Expired**; choose **Sign in again**, confirm the code in the browser, and
**Resume** any task that was waiting. The sign-in works from any device:
the code page can be opened on your phone. With a profile from this
runner's computer, renew it the way you usually do for that profile. Without permission to create pull
requests, Tandem gives you a prefilled console link instead.

### Copilot: "This account can't use Copilot here" (403)

The GitHub account whose plan the workspace uses has no Copilot seat. In
Settings › Copilot, another member with a plan chooses **Use my Copilot
plan**. On a company runner, sign in on that computer with the account that
has the seat (for example on `yourcompany.ghe.com`), then run `tandem doctor`
there.

### "No usable OS keychain" (company runner)

A company runner keeps its key and sign-ins in that computer's keychain.
macOS and Windows always have one. On Linux, see
[Enable Jira › Keychain on Linux](ENABLE_JIRA.md#keychain-on-linux).

### A task is waiting

Every waiting task says why and what to do on its page. Fix the cause, then
**Resume**. A **failed** task (an error that retries did not fix) shows the
error; **Retry** runs that step again. The task's timeline shows every
transition with its reason; the log has the details:

```sh
grep '"taskId":"<id>"' ~/.tandem/logs/*-$(date +%F).log | tail
```

### Copilot limit reached

A run stopped at the per-task or per-day limit. An owner raises it in
Settings › Budget, then **Resume**. Today's use is shown on the same card. The
day resets at midnight local time.

### Conflicts

- **Before the pull request** (rebase conflict): Tandem rebases the branch
  onto the latest default branch before pushing and lets the agent resolve
  conflicts. If it can't, the task waits with the files listed. Resolve
  them on the `agent/…` branch, push, and **Resume**.
- **After the pull request is open**: see
  [Keeping pull requests mergeable](USER_GUIDE.md#keeping-pull-requests-mergeable).

### A repository is in a bad state

Stop Tandem, delete the workspace's `mirrors/<host>/<repo>.git` and `projects/<id>/<repo>`,
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

The databases are migrated on start. Back them up first (see above). A
server upgrades by its new image (see [Deploying Tandem](DEPLOYMENT.md)); a
company runner with `npm install -g https://app.[domain]/download/tandem.tgz`
again.

## Test modes

These are for developing Tandem; none of them call Copilot unless stated.

| Command | What it does |
| --- | --- |
| `pnpm test` | unit, integration and web tests |
| `pnpm test:ui` | browser tests with axe checks in light and dark (`TANDEM_SCREENSHOTS=1` saves screenshots) |
| `pnpm test:flows` | end-to-end flows through the real web app behind a pretend GitHub, on local bare git remotes, scripted agent |
| `TANDEM_E2E_REAL=1 TANDEM_AWS_PROFILE=<p> pnpm test:flows` | the same flows on real CodeCommit sandbox repositories, through a company runner on this computer |
| `TANDEM_E2E_COPILOT=1 pnpm test:flows e2e/flows/copilot.e2e.test.ts` | **live Copilot, spends AI credits**, through a company runner on this computer (its Copilot sign-in): two short tasks with hard caps (15 credits per task, 40 per day), cheapest model by default (`TANDEM_E2E_MODEL`) |

`TANDEM_E2E_PORT=<port>` runs a flow on a fixed port so you can watch it in
the browser, and `TANDEM_E2E_DIR=<dir>` keeps its data afterwards.
`TANDEM_E2E_MIN_FREE_DISK_GB=1` lowers the low-disk guard (default 2 GB) for
the flows' own data, on a machine short of disk.
`TANDEM_AGENT=scripted` starts Tandem with the scripted agent, and
`TANDEM_TEST_REMOTE_ROOT=<dir>` serves CodeCommit repositories from local
copies in `<dir>/<name>.git`; the account menu then shows a test-mode note.
