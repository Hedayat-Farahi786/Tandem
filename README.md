# Tandem

Tandem turns a request in chat into a tested, reviewed pull request. You
describe a change; Tandem asks until it is clear and testable, writes a spec
for you (and a PM) to approve, and only then lets GitHub Copilot write the
code. Tandem itself runs every check, maps each acceptance criterion to a
passing test, reviews the change, and opens one pull request per repository.
A person always reviews and merges: agents never merge and never push to a
default branch.

Tandem is a web app. People sign in with GitHub, and each team works in a
workspace: its projects, tasks, chats and connections. A workspace works in
Tandem's cloud, in the EU, or on a company's own computer through a runner
when the code must not leave the company. It works on AWS CodeCommit or
GitHub repositories, with Jira as an option.

```
Chat request ─▶ Ready? ─▶ Spec ─▶ Owner + PM approve ─▶ Build ─▶ Checks ─▶ Self-review ─▶ Pull requests ─▶ Merged
```

## What people need

| | |
| --- | --- |
| A GitHub account | to sign in; Tandem uses it for GitHub repositories too |
| GitHub Copilot | any plan: Free, Pro or Pro+ of your own, or Business or Enterprise from work. A workspace runs on one member's plan |
| AWS (CodeCommit only) | connected in the app: your company's IAM Identity Center sign-in, an access key, or a role in your account. No AWS CLI needed |
| Jira (optional) | **Connect Jira** in the app: sign in at Atlassian, or a token for Jira Data Center |

The first person in a workspace sets it up in a short wizard: Copilot,
repositories (picked from what their accounts can reach, or a clone URL),
a project, Jira, and a check. They invite colleagues with a link.

## Running Tandem

**On a server**, for a team or as a service: the Docker image and everything
around it (the GitHub App, settings, isolation of builds, backups, several
replicas, monitoring) are in [Deploying Tandem](docs/DEPLOYMENT.md).

**On one computer**, to try it or to develop it, you need a GitHub App for
the sign-in ([section 1 of the deployment guide](docs/DEPLOYMENT.md#1-create-the-github-app),
with the callback `http://localhost:4317/auth/github/callback`). Then:

```sh
git clone <this repository> tandem
cd tandem
pnpm install
TANDEM_GITHUB_CLIENT_ID=… TANDEM_GITHUB_CLIENT_SECRET=… TANDEM_PORT=4317 pnpm tandem
```

(or put those settings in a `.env` file; see `.env.example`). `pnpm tandem`
builds Tandem when needed, starts it at <http://localhost:4317>, and opens
your browser. Its data stay in `~/.tandem`, with a secret key Tandem makes
there once. Stop it with Ctrl+C; unfinished work resumes on the next start.
On a remote machine (for example over VS Code Remote-SSH), forward the port
to the **same** local port.

**On a company computer**, when a workspace's code must stay in the company:
an owner chooses Settings › Workspace › **Use a company computer**, and runs
the two commands it shows there:

```sh
npm install -g https://app.[domain]/download/tandem.tgz
tandem runner --url https://app.[domain] --key tdr_…
```

Other commands:

```sh
tandem doctor               # check a computer for a company runner (--json for a report)
tandem backup --to <folder> # copy Tandem's databases while it runs; tandem restore --from <folder>
tandem --help
```

## Documentation

- [User guide](docs/USER_GUIDE.md): chat, specs and approvals, tasks,
  pull requests, models and credit limits.
- [Deploying Tandem](docs/DEPLOYMENT.md): the server, the GitHub App,
  isolation, backups, replicas, monitoring.
- [Runbook](docs/RUNBOOK.md): data on disk, logs, backups, blocked tasks,
  sign-in problems, disk space, upgrades.
- [Enable Jira](docs/ENABLE_JIRA.md): connect Jira, import issues, post
  specs, PM approval from Jira.
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
- Every workspace is apart from the others: its own database and folders,
  and each build isolated in its own namespaces. Secrets are sealed per
  workspace (or kept in the keychain of a company runner's computer), never
  in a page or a log. Logs and stored output are redacted.
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
