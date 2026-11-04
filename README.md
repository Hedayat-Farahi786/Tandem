# Tandem

Tandem turns a request in chat into a tested, reviewed pull request. You
describe a change; Tandem asks until it is clear and testable, writes a spec
for you (and a PM) to approve, and only then lets GitHub Copilot write the
code. Tandem itself runs every check, maps each acceptance criterion to a
passing test, reviews the change, and opens one pull request per repository.
A person always reviews and merges: agents never merge and never push to a
default branch.

It runs on your machine as a local web app (127.0.0.1 only), on AWS
CodeCommit or GitHub repositories, with Jira as an option.

```
Chat request ─▶ Ready? ─▶ Spec ─▶ Owner + PM approve ─▶ Build ─▶ Checks ─▶ Self-review ─▶ Pull requests ─▶ Merged
```

## What you need

| | |
| --- | --- |
| Node.js | 22.13 or newer |
| pnpm | 10 (`corepack enable` sets it up) |
| git | 2.25 or newer |
| GitHub Copilot | a seat that may use Copilot from the CLI or SDK, and the GitHub CLI signed in (`gh auth login`) |
| AWS CLI v2 | for CodeCommit, signed in with the profile you use for your repos (`aws login` or `aws sso login`) |
| Disk | a few GB free; each repo is cloned once and its dependencies are shared between tasks |

Jira is optional. A GitHub token is optional (the GitHub CLI is used when
it's signed in).

## Install and start

```sh
git clone <this repository> tandem
cd tandem
pnpm install
pnpm tandem
```

`pnpm tandem` builds Tandem if the build is missing or out of date, starts
it at <http://127.0.0.1:4317>, opens your browser, and runs the doctor on
the first launch. The setup wizard then walks you through adding
repositories, grouping them into a project, and checking your setup.
Stop it with Ctrl+C; unfinished work resumes on the next start.

If your Copilot comes from a GitHub Enterprise host with data residency
(for example `yourcompany.ghe.com`), sign in to it with
`gh auth login --hostname yourcompany.ghe.com` and set the Copilot host in
the wizard or in Settings.

Other commands:

```sh
pnpm tandem doctor          # check the setup in the terminal (--json for a report)
pnpm tandem --no-open       # start without opening a browser
pnpm tandem --version
```

On a remote machine (for example over VS Code Remote-SSH), forward port
4317 to the **same** local port: Tandem only answers on its own port.

## Documentation

- [User guide](docs/USER_GUIDE.md): chat, specs and approvals, tasks,
  pull requests, models and credit limits.
- [Runbook](docs/RUNBOOK.md): data on disk, logs, backups, blocked tasks,
  sign-in problems, disk space, upgrades.
- [Enable Jira](docs/ENABLE_JIRA.md): import issues, post specs, PM
  approval from Jira, and a keychain on headless Linux.
- [Adapters](docs/ADAPTERS.md): how the source hosts, trackers and the
  agent runtime plug in, and how to add one.
- [Architecture](docs/ARCHITECTURE.md) and [plan](docs/PLAN.md).
- [Changelog](CHANGELOG.md).

## Safety in short

- Chat and spec work are read-only; code is written only after both
  approvals of the current spec version.
- The agent may only run commands on an allowlist: the repo's own install,
  lint, type-check, build and test commands, package installs, read-only
  git and file helpers. Cloud CLIs, `curl`, `ssh`, `git push` or `commit`,
  publish and deploy commands are refused, and it can't write outside the
  task folder. This is enforced in code, not in the prompt.
- Tandem pushes only to the `feature/<key>-…` branches it created, never with
  `--force` (only `--force-with-lease` after its own rebase), and never
  merges.
- Secrets (Jira and GitHub tokens) live only in the OS keychain. Logs and
  stored output are redacted.
- Copilot use has hard limits per task and per day, in prompts and in AI
  credits; a run that reaches one stops at once.

## Development

```sh
pnpm build && pnpm typecheck && pnpm lint && pnpm test   # what CI should run
pnpm test:ui        # browser tests (Playwright, axe in light and dark)
pnpm test:flows     # end-to-end flows on local git remotes, scripted agent
```

`.env.example` lists every setting that can come from the environment.
Tests never call Copilot: they use a scripted agent. See the runbook for the
live and real-CodeCommit test modes.
