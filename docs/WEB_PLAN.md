# Tandem as a web app: architecture and plan

Status: **proposal**, agreed direction (November 2026): Tandem hosted in the EU,
anyone can sign up, and an optional runner lets a company keep its code on its
own laptops or network. The local app stays usable while the web version is
built, and both share the same core.

## 1. What changes, in one picture

```
 Browser ──HTTPS──▶  Tandem cloud (EU, eu-central-1)                     GitHub / AWS
                     ┌──────────────────────────────────────┐
                     │ Web app + API   (stateless, 2+ nodes) │──OAuth──▶ GitHub App (sign-in,
                     │ Postgres        (per-tenant rows, RLS)│           Copilot token, repos)
                     │ Object storage  (logs, artifacts)     │
                     │ Job queue       (tasks → runners)     │──STS───▶ customer IAM role
                     └───────────────┬──────────────────────┘           (CodeCommit)
                                     │ jobs (outbound only from runners)
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
   Hosted runner (Tandem's EU cloud)        Company runner (laptop, VM or VPC)
   one short-lived sandbox per task          `tandem runner`, uses the machine's
   (no code kept after the task)             own git, SSH and AWS sign-in; code
                                             never leaves the company
```

* The **control plane** (web app, API, database) never builds code. It keeps
  tasks, specs, approvals, conversations and the audit log.
* A **runner** does what Tandem does today on one machine: clone or reuse a
  checkout, run Copilot sessions, run the checks, push the branch. The engine
  in `packages/core` is reused as it is; the runner is a new entry point.
* **Local mode** (`TANDEM_MODE=local`, today's app) is the control plane and a
  runner in one process on `127.0.0.1`, with the keychain for secrets.

## 2. Decisions

| Area | Decision | Why |
| --- | --- | --- |
| Region | AWS eu-central-1 (Frankfurt), backups in eu-central-2 (Zurich) or eu-west-1 | EU processing for GDPR; same region as most CodeCommit users here |
| Sign-in | "Continue with GitHub" through a **GitHub App** registered by Tandem (web flow with an https callback). Optional later: Microsoft Entra | Everyone using Tandem has a GitHub account for Copilot; one sign-in gives identity, the Copilot token and repository access |
| Copilot | The signed-in user's GitHub App user token (`ghu_…`) is passed to each Copilot SDK session as `gitHubToken` | The SDK's documented way for multi-user apps; each person uses their own Copilot plan, so Tandem never resells or pools Copilot |
| GitHub repos | The same GitHub App, **installed** on the user's account or org with the repositories they choose. Installation tokens for clone, push and pull requests; webhooks for merges and reviews instead of polling | The standard pattern (Vercel, Netlify); least privilege; admins control access |
| CodeCommit | A **cross-account IAM role** the customer creates with one click (CloudFormation quick-create link with an External ID), assumed with STS. The in-app IAM Identity Center sign-in stays for individuals | The AWS-recommended way for SaaS to reach a customer account: no long-lived keys, revocable by the customer |
| Company code stays home | The **company runner**: `npx tandem runner --token …` on a laptop, VM or Kubernetes. Outbound HTTPS only (no inbound ports), enrolled per workspace, uses the machine's own git, SSH and AWS sign-in | Meets "don't copy company code elsewhere": the code is built where it already lives |
| Hosted runner | One sandbox per task: a container on ECS Fargate (Firecracker microVMs later), 2 vCPU and 8 GB, network limited to GitHub, CodeCommit and package registries, deleted when the task ends | Isolation between customers; nothing kept after the task |
| Database | Postgres (RDS, encrypted), every row carries `workspace_id`, enforced with row-level security; a new `PostgresStore` beside `SqliteStore` | Multi-tenant isolation in depth |
| Secrets | Envelope encryption with AWS KMS, one data key per workspace; tokens never sent to the browser | Contains a breach to one workspace |
| Audit | The existing hash-chained audit log, per workspace, exportable | Already built; customers can prove who approved what |
| Billing | Not in the first version; each user brings their own Copilot plan | Launch faster; add Stripe (EU entity) later |

## 3. GDPR, by design

What Tandem processes: account data (GitHub login, name, email, avatar),
workspace data (tasks, specs, approvals, conversations with Copilot, check
results, audit log), and **customer source code** while a hosted runner works on
it (not kept afterwards; not processed at all with a company runner).

Technical measures:

* **EU only** for Tandem's own storage and processing. The one transfer out of
  the EU is Copilot itself (GitHub/Microsoft), which the customer already uses
  under their own GitHub agreement; it is disclosed as a subprocessor, with the
  EU-US Data Privacy Framework and Standard Contractual Clauses. Customers on
  GitHub Enterprise Cloud with EU data residency (`*.ghe.com`) keep Copilot in
  the EU.
* **Data minimisation:** no tracking or advertising cookies, no analytics that
  identify people. Only a strictly necessary session cookie, so no consent
  banner is needed. If product analytics are ever added, they are opt-in.
* **Retention defaults**, shown in Settings and changeable per workspace:
  runner logs 30 days, finished tasks and conversations until deleted, audit
  log 1 year, deleted workspaces purged after 30 days, backups rotate in 35.
* **Rights of the person**, self-service:
  * Export: a ZIP of everything about the person and their workspaces (JSON
    and Markdown) from Settings › Privacy.
  * Delete account: removes the person, anonymises their name in shared
    history (audit entries keep a pseudonymous id), revokes GitHub and AWS
    access; workspace owners can delete a whole workspace.
  * Correct: profile data comes from GitHub and can be edited.
* **Security:** TLS 1.2+, HSTS, encryption at rest (RDS, S3, KMS), per-tenant
  keys, least-privilege IAM, MFA for Tandem staff, access to production logged,
  dependency and container scanning, a penetration test before launch.
* **Breach process:** detection and paging, a runbook to notify the
  supervisory authority within 72 hours and customers without undue delay.
* **Records:** a record of processing activities, subprocessor list with change
  notice (30 days), DPA accepted in-app by workspace owners.

Legal drafts are in [`docs/legal/`](legal/): privacy policy, terms of service,
data processing agreement, subprocessors and the record of processing. They
are **drafts for a lawyer** and need the operator's company details.

## 4. Build order

Each phase ends with something usable and all tests green. Local mode keeps
working throughout.

### Where it stands (2026-11-04)

Built and tested end to end (`e2e/flows/hosted.e2e.test.ts`). The test signs in with GitHub,
invites a colleague, adds a repository, turns a chat request into a task, and lets Copilot build
it and the checks run until the pull request is open. It also checks that workspaces stay apart
and that a member can be removed and an account deleted.

Phase 1 runs on SQLite, one database per workspace, in a single container
([DEPLOYMENT.md](DEPLOYMENT.md)), instead of Postgres. GitHub repositories are listed through
the App installation. Hosted workspaces connect CodeCommit with IAM Identity Center or an access
key, never with the server's own credentials. The legal drafts are served at `/legal/*`, and
account export and deletion work.

The company runner is built (`tandem runner`). Instead of a job queue, it holds the whole
workspace on the company's computer, so data and code never reach the cloud, and the web app
passes requests to it over one outbound WebSocket. Workspace data export (Settings › Audit log ›
All data) is built too.

Also built since then:

* **Isolated builds in the cloud.** Every command runs in its own Linux namespaces with only its
  workspace visible. This is per workspace rather than a container per task, and gVisor or Kata
  around the container add a second wall.
* **CodeCommit through a role** in the customer's account, made from a CloudFormation template,
  with their external ID.
* **GitHub webhooks.**
* **Several replicas:** a shared Postgres directory, workspaces spread over replicas with their
  own volumes (a StatefulSet), and requests passed to the replica that runs each workspace.

Phase 5's hardening in the app is built: rate limits, quotas, invite-only sign-up, public-only
outbound addresses, invitation links that ask before joining, readiness and Prometheus metrics,
and `tandem backup` and `tandem restore` with a restore drill in the tests.

Left for the launch itself:

* an external penetration test;
* the monitoring stack and alerts (EU-hosted);
* a status page;
* the legal review.

1. **Foundations (≈3 weeks)**
   * `TANDEM_MODE=hosted|local`; hosted listens behind a load balancer with
     https, secure cookies, CSRF protection and CSP.
   * GitHub App: sign-in (web flow), sessions, the user's Copilot token passed
     per session.
   * Workspaces, members and roles (owner, member, PM approver); invitations.
   * `PostgresStore` with `workspace_id` and row-level security; migrations.
   * Infrastructure as code (Terraform) for eu-central-1: VPC, RDS, S3, KMS,
     ECS, ALB, WAF; CI/CD with staging and production.
2. **Repositories and hosted runner (≈3 weeks)**
   * GitHub App installation, repository picker, installation tokens,
     webhooks (merged, closed, reviews).
   * CodeCommit: "Connect AWS account" with the CloudFormation quick-create
     role and External ID; STS AssumeRole; IAM Identity Center for individuals.
   * Job queue and the hosted runner on ECS Fargate: one sandbox per task,
     egress allowlist, logs to S3 with retention, workspace wiped at the end.
3. **Company runner (≈2 weeks)**
   * `tandem runner` (same package): enrolment token, outbound WebSocket,
     job protocol, heartbeats, cancel; runs the existing engine with the
     machine's own git, SSH and AWS sign-in; works with a clone already on the
     machine.
   * Workspace setting: run tasks on hosted runners, on company runners, or
     per project.
4. **Privacy and legal (≈1–2 weeks, partly alongside)**
   * Settings › Privacy: export, account and workspace deletion, retention.
   * Public pages: privacy policy, terms, subprocessors, security; DPA
     acceptance for owners; legal review and the operator's details.
5. **Hardening and launch (≈2 weeks)**
   * Rate limits, abuse controls, quotas, status page, EU-hosted monitoring and
     alerting, backups and a restore drill, penetration test, launch checklist.

## 5. What carries over from today

* The whole engine (`packages/core`): workflow, runner, policies, prompts,
  safety rules, the spec and approval flow.
* Copilot accounts code: hosted mode replaces the local loopback sign-in with
  the GitHub App token; local mode keeps it.
* Repository pickers, CodeCommit SigV4 signing, the git credential helper (the
  runner uses it), the AWS Identity Center sign-in, working in an existing
  clone (the company runner's default).
* The web UI: screens stay; sign-in, workspace switcher, members and privacy
  pages are added.

## 6. Names and addresses

* **Operator:** CHD Labs (chdlabs.com). Still needed for the legal texts: the
  legal form, address, registration number, VAT ID; whether a DPO is required.
* **Domain:** not chosen yet (`[domain]`). The website goes on `[domain]`
  and the app on `app.[domain]`: the app keeps its paths at the root, and
  its session cookie stays on its own host. Every address is configuration
  (`TANDEM_PUBLIC_URL`), never in the code. Email from `tandem@[domain]`,
  privacy questions to `[privacy email]`.
* **GitHub App:** "Tandem by CHD Labs" (app names are unique on GitHub),
  callback `https://app.[domain]/auth/github/callback`, webhook
  `https://app.[domain]/hooks/github`.
* **AWS:** a new AWS organization for the hosted service, separate from any
  company account used for testing (being created by the operator).
