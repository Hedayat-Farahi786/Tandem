# Deploying Tandem (hosted)

For the team that runs Tandem as a web app. It covers the GitHub App, the container, its
settings, data, isolation and the checklist before going live. How Tandem works inside is in
[ARCHITECTURE.md](ARCHITECTURE.md); the plan for the web app is in [WEB_PLAN.md](WEB_PLAN.md).

## What runs

One container (see the [Dockerfile](../Dockerfile)) holds:

- **The front.** GitHub sign-in, sessions, workspaces and members, all checked on every request.
- **One cell per workspace.** Each cell has its own SQLite database, its own engine and its own
  runner. Cells are opened when the server starts and keep working while nobody is signed in.
- **The runner.** It clones the workspace's repositories, runs Copilot and the project's checks
  (install, lint, typecheck, build, test), pushes the branch and opens the pull request.

State lives in one volume, `/data`. On one replica, everything is there, including the directory
(SQLite). To run several replicas, give them a shared Postgres for the directory and each its own
volume; see [section 8](#8-more-than-one-replica).

## 1. Create the GitHub App

This is done once, by the operator, at github.com → Settings → Developer settings → GitHub Apps → New.

| Field | Value |
| --- | --- |
| Homepage URL | `https://app.[domain]` |
| Callback URL | `https://app.[domain]/auth/github/callback`. To run Tandem on one computer too (a trial, development), add `http://localhost:4317/auth/github/callback` as a second callback URL, or make a separate App for it |
| Expire user authorization tokens | **On** (8-hour tokens, renewed with a 6-month refresh token) |
| Request user authorization (OAuth) during installation | On |
| Webhook | On. URL `https://app.[domain]/hooks/github`, with a random secret (at least 16 characters) → `TANDEM_GITHUB_WEBHOOK_SECRET`. Events: Pull request, Pull request review, Pull request review comment, Pull request review thread, Issue comment, Check suite, Check run. Without it, Tandem polls pull requests every few minutes. |
| Repository permissions | Contents: read and write · Pull requests: read and write · Metadata: read |
| Account permissions | Copilot Requests (so Copilot runs on the member's own plan), plus Email addresses: read |
| Where can it be installed | Any account |

Before relying on the Copilot permission, check its exact name and level in GitHub's form at the
time you create the App.

Afterwards, keep:

- the **Client ID** → `TANDEM_GITHUB_CLIENT_ID`;
- a new **client secret** → `TANDEM_GITHUB_CLIENT_SECRET`;
- the App's URL name (`github.com/apps/<slug>`) → `TANDEM_GITHUB_APP_SLUG`, for the "Give Tandem
  access" link.

Members install the App on their account or organization to choose which repositories Tandem
may use.

### Jira: "Connect Jira" with Atlassian's sign-in

So that members connect Jira Cloud in one click, register Tandem once as an Atlassian app, at
<https://developer.atlassian.com/console/myapps/> → Create → **OAuth 2.0 integration**:

| Step | Value |
| --- | --- |
| Permissions → Jira API | Add it, then the classic scopes `read:jira-work`, `write:jira-work` and `read:jira-user` |
| Authorization → OAuth 2.0 (3LO) | Callback URL `https://app.[domain]/auth/jira/callback` |
| Distribution | **Enable sharing**, so people outside your own Atlassian site can connect; fill in the vendor and privacy details |
| Settings | Keep the **Client ID** → `TANDEM_JIRA_CLIENT_ID` and the **Secret** → `TANDEM_JIRA_CLIENT_SECRET` |

Tandem asks for `offline_access` as well, so the sign-in renews itself. Atlassian's refresh
tokens rotate: Tandem stores each new one at once, per workspace and sealed. Company runners renew
theirs through the web app (`/runner/jira/refresh`, with their runner key), so the client
secret stays on this server. Without the app, members connect Jira with a token (the form also
covers Jira Data Center).

## 2. Settings

| Variable | Required | Value |
| --- | --- | --- |
| `TANDEM_PUBLIC_URL` | yes | The app's public address, e.g. `https://app.[domain]`. Requests for any other Host are refused. |
| `TANDEM_GITHUB_CLIENT_ID` | yes | From the GitHub App |
| `TANDEM_GITHUB_CLIENT_SECRET` | yes | From the GitHub App. Keep it in your secret manager. |
| `TANDEM_GITHUB_APP_SLUG` | recommended | The App's URL name |
| `TANDEM_SECRET_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`). It seals stored tokens and connection secrets. Keep it in your secret manager. |
| `TANDEM_HOME` | set in the image | `/data` |
| `TANDEM_PORT` | set in the image | `8080` |
| `TANDEM_LISTEN_HOST` | set in the image | `0.0.0.0` |
| `TANDEM_CLI_PACKAGE` | set in the image | `/app/cli/tandem.tgz`: the `tandem` command, offered at `/download/tandem.tgz` for company runners (section 6) |
| `TANDEM_GITHUB_WEBHOOK_SECRET` | recommended | The GitHub App's webhook secret. Keep it in your secret manager. |
| `TANDEM_JIRA_CLIENT_ID`, `TANDEM_JIRA_CLIENT_SECRET` | recommended | Tandem's Atlassian app, for "Connect Jira" (section 1). Keep the secret in your secret manager. |
| `TANDEM_AWS_ROLE_SOURCE` | recommended | `on`: customers connect CodeCommit with a role in their account that trusts this server's AWS identity (see below). |
| `TANDEM_AWS_ROLE_PRINCIPAL` | no | The ARN customers' roles trust, when the server's role has a path (`arn:aws:iam::<account>:role/<path>/<name>`). |
| `TANDEM_AWS_TEMPLATE_URL` | no | The role template on S3, for CloudFormation's one-click "quick create" link (see below). |
| `TANDEM_DATABASE_URL` | for several replicas | `postgres://…`: the directory in Postgres, shared by the replicas (section 8). |
| `TANDEM_REPLICA_ID`, `TANDEM_REPLICA_URL` | for several replicas | This replica's stable name and its address inside the cluster (section 8). |
| `TANDEM_SIGNUP` | recommended at launch | `invite`: only people already here, people with an invitation link, and the GitHub logins in `TANDEM_SIGNUP_ALLOW` (comma-separated) can sign in. `open` (default): anyone with GitHub. |
| `TANDEM_LIMIT_WORKSPACES_PER_PERSON`, `TANDEM_LIMIT_MEMBERS_PER_WORKSPACE`, `TANDEM_LIMIT_INVITES_PER_DAY` | no | Quotas: 10, 100 and 50 by default. |
| `TANDEM_TRUST_PROXY` | no | How many proxies in front add `X-Forwarded-For` (default 1, the load balancer). Rate limits use the address the nearest trusted proxy saw. |
| `TANDEM_METRICS_TOKEN` | recommended | A long random token; Prometheus scrapes `GET /metrics` with `Authorization: Bearer <token>`. Without it, `/metrics` is off. |
| `TANDEM_SANDBOX` | no | `on` (default): builds run isolated, and Tandem won't start if it can't isolate them. `off` only to try Tandem out without real users. |
| `TANDEM_LOG_LEVEL` | no | `info` (default), `warn`, `debug` |
| `TANDEM_MODEL`, `TANDEM_LIGHT_MODEL` | no | The default Copilot models for every workspace |
| `TANDEM_MAX_CONCURRENT_BUILDS`, `TANDEM_BUILD_TIMEOUT_MIN` | no | Runner limits for every workspace |
| `TANDEM_BUDGET_PER_TASK`, `TANDEM_BUDGET_PER_DAY`, `TANDEM_CREDITS_PER_TASK`, `TANDEM_CREDITS_PER_DAY` | no | Starting Copilot budget of a new workspace. Its owners can change it later. |

`TANDEM_AWS_PROFILE` and `TANDEM_HOST` are ignored in hosted mode, and so are the server's own
AWS credentials. A workspace reaches AWS only through the connection its members make in the app.

**`TANDEM_SECRET_KEY` cannot be rotated yet.** If it is lost, members must sign in again, and every
workspace must reconnect AWS and Jira. Back it up with the same care as the data.

## 3. Run it

```sh
docker build -t tandem .
docker run -d --name tandem -p 8080:8080 -v tandem-data:/data --env-file tandem.env --restart unless-stopped \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
  tandem
```

- **TLS.** Terminate HTTPS at your load balancer and forward to port 8080 with the original
  `Host` header. Cookies are set `Secure` when `TANDEM_PUBLIC_URL` is `https://`.
- **Health checks.** `GET /healthz` (liveness) answers while the process runs. `GET /readyz`
  (readiness) also checks that the directory database answers. Both work on the pod's own
  address. The image's `HEALTHCHECK` uses `/healthz`.
- **Stop.** On SIGTERM the server stops gracefully. Tasks that were running continue from their
  last step after the next start.
- **Upgrades.** Database migrations run by themselves at start. Take a backup first.
- **Logs.** Logs go to stdout and to `/data/logs`. They hold no tokens, because secrets are
  redacted before writing.
- **Resources.** Builds run here, so size for them: about 2 vCPU and 4 GB of memory per concurrent
  build, plus room on `/data` for the clones and dependencies of every workspace.

**On Kubernetes,** start from [deploy/kubernetes/tandem.yaml](../deploy/kubernetes/tandem.yaml):
a StatefulSet with a volume per replica, the headless Service the replicas use, probes, the
security settings of section 5, a NetworkPolicy that keeps the pods off private and metadata
addresses, and an ingress example with WebSocket and live-update timeouts. Replace its
`[placeholders]` and create the Secret `tandem-secrets` from your secret manager. It needs
Kubernetes 1.33 or later, for user namespaces. Check it with `kubeconform -strict`.

## 4. Data and backups

| Path in `/data` | Holds |
| --- | --- |
| `directory.db` | People, sessions, workspaces, members, invitations, sealed GitHub tokens and workspace secrets. With several replicas this is in Postgres instead: back it up with your database's backups. |
| `workspaces/<id>/` | One workspace: its database (projects, tasks, chats, audit log), repository mirrors and worktrees |
| `logs/` | Service logs |

Back up daily, with either:

- **`tandem backup --to <folder>`** inside the container, while it runs. It copies every database
  consistently: the directory on one replica, and each workspace's projects, tasks, chats,
  approvals and audit log. It leaves out repository mirrors and task folders, which come back
  from the repositories; a task that was building starts its step again.
- **A snapshot of the whole volume,** filesystem-consistent or taken while the container is
  stopped.

With Postgres, back the directory up with the database's own backups as well.

**Restore** with Tandem stopped: `tandem restore --from <folder>` into an empty `/data`, then
start it with the same `TANDEM_SECRET_KEY`. Sign-ins, workspaces and their data come back as
they were. Try a restore once before launch, and again after each upgrade that changes the data
(the test suite runs this drill too).

Keep backups in the EU, encrypted, for as long as the privacy policy says. Deleting a workspace
or an account removes its folder at once. Backups expire on their own schedule, and the privacy
policy says so. Expired sessions and invitations are deleted every hour.

## 5. Isolation of builds

The runner executes code from customers' repositories: install scripts, tests, builds, and the
commands Copilot runs. Treat that code as untrusted.

**Inside the container, Tandem isolates every build.** Each command of a cloud workspace starts
in its own Linux namespaces: user, mount and process.

- **What it sees:**
  - its own workspace folder only. Every other workspace, the directory and the logs are hidden.
  - the git mirrors read-only, so it can't plant hooks or config that Tandem's git would run.
  - its workspace database and the git helper's key masked.
  - a private `/tmp` and `HOME`.
  - none of the server's processes, whose memory and environment hold the secrets.
- **What Tandem's own git checks:** before touching a task folder, that its `.git` link still
  points into that workspace's mirrors. Repository files Tandem reads itself are never read
  through symlinks that lead out of the checkout.
- **Startup self-test:** Tandem proves this works when it starts, and refuses to start if it
  doesn't (`TANDEM_SANDBOX=off` skips this, for trials only).

It needs user namespaces and permission to mount inside them. Docker's defaults block both, hence
the three `--security-opt` flags in section 3. On Kubernetes, use `seccompProfile: Unconfined`,
`appArmorProfile: Unconfined` and `procMount: Unmasked` (with `hostUsers: false`), as the example
manifest does. It works with `allowPrivilegeEscalation: false` and every capability dropped, so
keep those. These loosen
the container's own confinement in exchange for the per-build isolation, so pair them with the
rest of this list:

- **A host of its own.** Run Tandem on a dedicated VM or node pool, never next to other services.
- **A sandboxed runtime around the container.** gVisor (`runsc`) or Kata/Firecracker add a second
  wall between builds and the host's kernel.
- **No cloud metadata endpoint.** Block `169.254.169.254` and IPv6 `fd00:ec2::254` from the
  container. Tandem never uses the machine's own credentials, but a build could try to.
- **Restricted egress.** Allow GitHub (`github.com`, `api.github.com`, `*.githubusercontent.com`),
  Copilot (`*.githubcopilot.com`), AWS in the regions your workspaces use (`git-codecommit.*`,
  `codecommit.*`, `oidc.*`, `portal.sso.*`, `sts.*`), Atlassian if Jira is used, and the package registries
  builds need (`registry.npmjs.org`, …).
- **Non-root.** The container already runs as the `node` user. Don't add capabilities.

Each workspace's clones live in its own folder and are reached only through its own cell.

### CodeCommit through customers' roles

With `TANDEM_AWS_ROLE_SOURCE=on`, Settings › AWS offers **Connect with a role**. The owner creates
a role in their AWS account from Tandem's CloudFormation template. That role:

- trusts this server's identity, only with that workspace's external ID;
- may use CodeCommit only, and only in the repositories they choose.

They then paste the role's ARN. No keys change hands, and deleting the role cuts access.

For this, the server's own AWS identity (the instance or ECS task role) needs exactly one
permission:

```json
{ "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::*:role/TandemCodeCommit" }
```

That identity is used for nothing else. Tandem reads it at start and refuses to start if it can't.

For a one-click "quick create" link, save the template once and upload it to an S3 bucket readable
over HTTPS, then set `TANDEM_AWS_TEMPLATE_URL` to its URL. As a signed-in owner, save it from
Settings › AWS › Connect with a role › Download the template. It is the same for every workspace;
the principal and external ID are parameters.

## 6. Company runners

When a company does not want its code in the cloud, an owner moves the workspace to a computer of
the company's: Settings › Workspace › **Use a company computer**. That shows a runner key once,
and the commands to run there:

```sh
npm install -g https://app.[domain]/download/tandem.tgz
tandem runner --url https://app.[domain] --key tdr_…
```

The first line installs the `tandem` command from the web app itself; that computer needs Node.js
22.13 or later and git, and `tandem doctor` checks it. The package is built into the image
(`pnpm pack:cli` builds the same one). It bundles Tandem's own code and pins every library to the
versions Tandem was tested with (an `npm-shrinkwrap.json`), so each company computer gets the
same tree. Without `TANDEM_CLI_PACKAGE`, the app shows only the second line, and the company
installs the `tandem` command from a package you give it (`pnpm pack:cli` builds one).

The runner opens **one outbound WebSocket** to `wss://app.[domain]/runner/connect`. The web app
sends the workspace's API requests over it, after its own checks, and streams the answers back.
The workspace's data, repositories, Copilot sign-in and AWS or SSH access stay on that computer,
and nothing is stored in the cloud for it.

For the load balancer, this means:

- **Allow WebSocket upgrades** on `/runner/connect`.
- **Idle timeout of at least 120 seconds.** The web app pings every 25 seconds.
- **Sticky routing is not needed**, with one replica or several.

Answers from a runner are passed on only with safe content types, and are sandboxed (`CSP:
sandbox`), so a runner can never serve a page or a script on the app's address. A runner key is
stored as a hash. It stops working when an owner makes a new one, moves the workspace back to the
cloud, or deletes it.

## 7. Before going live

- [ ] Hosting, backups and logs are in an EU region, and the cloud provider's DPA is signed.
- [ ] The placeholders in [docs/legal](legal/README.md) are completed and the documents are
      reviewed by a lawyer: operator details, `[domain]`, `[privacy email]`, effective dates,
      subprocessors. They are served at `/legal/privacy`, `/legal/terms`, `/legal/dpa` and
      `/legal/subprocessors`.
- [ ] The GitHub App exists with the settings above, and its secret and `TANDEM_SECRET_KEY` are in
      the secret manager.
- [ ] `TANDEM_PUBLIC_URL` matches the address users open, and HTTPS works end to end.
- [ ] Tandem starts with `TANDEM_SANDBOX` on (the default). This means the startup self-test passed.
- [ ] Sign-up is invite-only (`TANDEM_SIGNUP=invite`) until you open it on purpose.
- [ ] `TANDEM_TRUST_PROXY` matches the proxies in front, and the load balancer sets `X-Forwarded-For`.
- [ ] Prometheus scrapes `/metrics` with `TANDEM_METRICS_TOKEN`, and the alerts in section 10 are set.
- [ ] Backups are taken daily, and one was restored into an empty volume and the app came back.
- [ ] An external penetration test has been done, and its findings fixed.
- [ ] The host and runtime around the container are in place: metadata endpoint blocked, egress
      restricted.
- [ ] The GitHub App's webhook points at `/hooks/github`, and its secret is set.
- [ ] Tandem's Atlassian app has sharing on and the callback `/auth/jira/callback`, and
      `TANDEM_JIRA_CLIENT_ID` and `TANDEM_JIRA_CLIENT_SECRET` are set. Connect a test Jira once.
- [ ] The load balancer passes WebSocket upgrades on `/runner/connect` (see section 6).
- [ ] Sign in, invite a second person, add a repository, run one small task to its pull request,
      then export and delete a test account. Then move a test workspace to a company runner and
      run a task there too.

## 8. More than one replica

A workspace is more than rows in a database: it has git mirrors, task folders, a dependency cache
and a running engine. So a workspace runs on one replica at a time, with its files on that
replica's volume, and the replicas share a Postgres directory. That is how a Kubernetes
StatefulSet runs things:

- **Postgres (EU, managed):** `TANDEM_DATABASE_URL=postgres://…`, the same for every replica. It
  holds what the SQLite `directory.db` holds on one replica, plus which replica runs each workspace
  and which replica each company runner is connected to.
- **One volume per replica**, mounted at `/data`, and a stable name: `TANDEM_REPLICA_ID` (the pod's
  name, e.g. `tandem-0`). A replica that restarts keeps its name and volume, so it runs the same
  workspaces again.
- **Each replica's address inside the cluster:** `TANDEM_REPLICA_URL`, e.g.
  `http://tandem-0.tandem.svc:8080` through a headless Service. The replicas reach each other there.
- **The same `TANDEM_SECRET_KEY`** on every replica. Replicas prove themselves to each other with a
  key derived from it, on `/internal/*`, which answers nothing without that key. You may keep
  `/internal/*` off the public load balancer.

How it behaves:

- **Any replica answers any request.** The load balancer needs no sticky sessions. If a request
  is for a workspace that runs elsewhere, the replica passes it to the one that runs it and
  streams the answer back, live updates included. Company runners can connect to any replica.
- **New workspaces go to the replica that runs the fewest.** Workspaces made while there was one
  replica stay where they are.
- **GitHub webhooks reach every replica.**
- **GitHub token renewal happens once,** even when two replicas need it at the same moment.
- **When a replica is down,** the workspaces it runs answer "restarting" until it is back. The
  others keep working.

Going from one replica to several:

1. Stop the one replica.
2. Copy its directory into Postgres with the same `TANDEM_HOME` and `TANDEM_SECRET_KEY`:
   `tandem migrate-directory --to postgres://…`.
3. Start it with `TANDEM_DATABASE_URL`, `TANDEM_REPLICA_ID` and `TANDEM_REPLICA_URL`.
4. Add replicas. The first replica to start takes the workspaces it had.

## 9. Abuse controls

- **Rate limits** apply per replica:

  | What | Limit |
  | --- | --- |
  | Sign-in and invitation links, per address | 30 a minute |
  | Webhooks, per address | 600 a minute |
  | Runner connections, per address | 20 a minute |
  | The API, per session | 900 reads and 180 changes a minute |
  | Chat messages, per session (each is a Copilot turn) | 20 a minute |

  Over a limit, Tandem answers `429` with `Retry-After`.
- **Quotas:** workspaces per person, members per workspace, and invitations per workspace per day.
  Copilot use has its own budget per workspace (Settings › Budget).
- **Sign-up:** at launch, `TANDEM_SIGNUP=invite` keeps Tandem to the people you let in.
- **Addresses people type** (a Jira site, a repository host) may only lead to public services
  over https. Private, loopback and link-local addresses, such as the metadata service, are
  refused, and so are GitHub hosts other than github.com and `*.ghe.com`.
- **Invitation links** show a confirmation page; joining needs the page's own token, so a link
  alone never moves anyone into a workspace.

## 10. Monitoring

With `TANDEM_METRICS_TOKEN`, `GET /metrics` serves Prometheus metrics:

- requests by route and status, and time per route;
- requests refused by rate limits, sign-ins (including those turned away), and webhooks;
- cloud workspaces running and company runners connected on each replica, and live replicas;
- tasks by state, and memory.

The alerts are ready in [deploy/monitoring/tandem-alerts.yml](../deploy/monitoring/tandem-alerts.yml),
with a scrape job example at its end:

| Alert | When | Severity |
| --- | --- | --- |
| `TandemReplicaDown` | a replica doesn't answer `/metrics` for 2 minutes | page |
| `TandemReplicaNotInDirectory` | fewer replicas in the shared directory than are running (its database) | page |
| `TandemServerErrors` | more than 2% of answers are 5xx for 10 minutes | page |
| `TandemNotReady` | a pod fails `/readyz` for 5 minutes (needs kube-state-metrics) | page |
| `TandemDiskFilling` | a replica's `/data` has less than 15% free (needs kubelet metrics) | page |
| `TandemTasksFailing` | more than 5 tasks failed in the last hour | ticket |
| `TandemRateLimited` | a rate limit refuses more than one request a second for 10 minutes | ticket |
| `TandemWebhooksRejected` | GitHub webhooks keep failing their signature | ticket |
| `TandemMemoryHigh` | a container near its memory limit (needs cAdvisor metrics) | ticket |

`promtool check rules` and `promtool test rules deploy/monitoring/tandem-alerts.test.yml` check
them; the test feeds sample series and expects the alerts to fire, or stay quiet.

A status page belongs outside this deployment, so it still answers when Tandem doesn't: point an
external uptime check at `https://app.[domain]/readyz`.

Logs are JSON on stdout, one line per event, with secrets removed. Collect them in the EU.
`pnpm audit` reports two moderate notes in `glob`/`minimatch` under `@fastify/static`. They don't
apply here: that code only reads the app's own files once at start. They go away with the next
`@fastify/static` update.
