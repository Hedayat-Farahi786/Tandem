# Phase 1 spikes

Small, standalone proofs that the risky parts of Tandem work on your machine before
anything is built on them. Each spike writes a Markdown and JSON report to
`spikes/reports/`.

| Spike | Proves | Needs |
| --- | --- | --- |
| `pnpm spike:a` | Copilot SDK with your existing Copilot CLI login: auth, policy access, model costs, tool list, forbidden actions denied in the real runtime, restart fallback. **No model calls** (checked: 0 usage events). | Copilot CLI signed in (`copilot` → `/login`) |
| `pnpm spike:a -- --live` | Adds 2 real prompts on the cheapest model (asks first, hard cap): streaming + structured output, a real edit and test run, history restored after the runtime is killed. Saves event streams as test fixtures. | Your go-ahead; run once, at the end |
| `pnpm spike:b` | CodeCommit over SSH with your `~/.ssh/config`: bare clone, worktree, commit, clean and conflicting rebase, push with explicit refspec, `--force-with-lease`, push guard, cleanup | `TANDEM_SPIKE_REPO_URL` |
| `pnpm spike:c` | CodeCommit PR API with your AWS profile (permission probe, idempotent create, get, update, close) and the console-link fallback | `TANDEM_SPIKE_REPO_URL`, optional `TANDEM_SPIKE_AWS_PROFILE` |
| `pnpm spike:d` | Local tracker on SQLite survives restarts and hard kills | nothing |
| `pnpm spike:d-jira` | Jira REST endpoints Tandem uses | skipped until `JIRA_*` values exist |

## Run them

```bash
pnpm install
```

```bash
cp spikes/.env.example spikes/.env
```

Fill in `spikes/.env`, then seed the sandbox repo once (only works on an empty repo):

```bash
pnpm spike:seed -- backend ssh://git-codecommit.<region>.amazonaws.com/v1/repos/tandem-sandbox-backend
```

```bash
pnpm spike:all
```

Spikes only create branches named `agent/spike-<id>-*` and delete them at the end. The
default branch is never written to (seeding an empty repo is the one exception).
`pnpm spike:all` runs spike a in free mode. `pnpm spike:b -- --local` rehearses the git logic against a local bare repo with no SSH.

`reports/container/` holds rehearsal runs from the Linux build container (no SSH keys,
AWS profile or Copilot login there), kept for comparison.

## Sandbox templates

`sandbox/backend` (Fastify), `sandbox/frontend` (React + Vite) and `sandbox/fullstack`
(both in one repo) are the apps used here and in the Phase 4 end-to-end tests. Each has
working `lint`, `typecheck`, `build` and `test` scripts and an npm lockfile.
