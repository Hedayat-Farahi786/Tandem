# Adapters

Tandem's workflow (`packages/core`) talks to the outside world only through
the interfaces in `packages/core/src/ports.ts`. The implementations live in
`packages/adapters`, and `packages/adapters/src/compose.ts` wires them
together (`createTandem`). Core never imports an adapter, so each one can be
replaced or tested on its own.

```
packages/core            workflow, state machine, policies, chat  ── uses ports only
packages/adapters        one folder per port implementation
  compose.ts             builds everything from TANDEM_HOME and Settings
apps/server              HTTP API, CLI, doctor  ── uses createTandem()
```

| Port | Implementations | Notes |
| --- | --- | --- |
| `SourceHost` | `source-codecommit`, `source-github` | clone, worktrees, rebase, push, pull requests |
| `GitOps` | `git/repo-git.ts` | local git on worktrees and mirrors, shared by both hosts |
| `Tracker` | `tracker-local`, `tracker-jira` | Jira when a URL and token exist, else local |
| `AgentRuntime` | `agent-copilot`, `agent-scripted` | Copilot SDK in production, a deterministic script in tests |
| `Store` | `storage-sqlite` | `node:sqlite`, one database file, migrations on open |
| `ProcessRunner` | `process/process-runner.ts` | runs the repo's commands with timeouts and output streaming |
| `SecretStore` | `secrets/keychain.ts` | OS keychain through `@napi-rs/keyring`, service `tandem` |

`packages/core/src/testing` has in-memory fakes for every port. They're what
the workflow tests run on.

## Source hosts

```ts
interface SourceHost {
  readonly kind: 'codecommit' | 'github';
  detect(url: string): DetectedRepo | undefined;      // does this host handle the URL?
  preflight(repo: Repo): Promise<PreflightCheck[]>;   // read access, PR permission (doctor)
  mirror(repo: Repo): Promise<MirrorInfo>;           // clone once or fetch; default branch
  createWorktree(repo, { path, branch, base?, detach? }): Promise<Worktree>;
  rebase(repo, worktree): Promise<RebaseResult>;     // onto origin/<default>: ok | conflict(files)
  push(repo, worktree, { forceWithLease? }): Promise<PushResult>;
  openPullRequest(req): Promise<PullRequestResult>;  // created | manual(link to fill in)
  updatePullRequestDescription(repo, pr, body): Promise<void>;
  getPullRequestStatus(repo, pr): Promise<'open' | 'merged' | 'closed' | 'manual-pending'>;
  readonly descriptionLimit: number;                 // characters the host accepts
}
```

Both hosts share the git layer in `git/repo-git.ts`:

- **Mirror**: a bare clone per repository with remote-tracking refs, under
  `TANDEM_HOME/mirrors`. It is deliberately not `clone --mirror`, which
  would make a plain push mirror every ref.
- **Access**: `RemoteAccess` holds the URL plus the `-c` options git needs:
  `aws codecommit credential-helper` for CodeCommit over HTTPS,
  `gh auth git-credential` for GitHub over HTTPS, nothing for SSH. They're
  written into Tandem's own mirror config only; the user's git config is
  never changed.
- **Safety**: `assertAgentBranch` refuses any push outside `agent/*`.
  `pushBranch` never uses `--force`, only `--force-with-lease=<ref>:<sha>`
  after Tandem's own rebase.
- **Concurrency**: `withMirror` runs one git operation per mirror at a time;
  `repairWorktrees` removes worktrees a crash left half-made.

What differs per host:

| | CodeCommit | GitHub |
| --- | --- | --- |
| URLs | `codecommit::<region>://[profile@]<name>`, SSH, HTTPS | SSH, HTTPS |
| Credentials | AWS profile from the URL, else Settings, else default chain | token from the keychain, else `gh auth token` |
| Pull requests | AWS SDK; `clientRequestToken` makes a retry after a restart safe | REST API |
| No permission | console link with the branches preselected | compare link with title and body to paste |
| Merged detection | PR status via API | PR status via API |

### Adding a host

1. Add the kind to `HostKind` and its fields to `HostRef` in
   `packages/shared/src/domain.ts`.
2. Create `packages/adapters/src/source-<name>/<name>-host.ts` implementing
   `SourceHost`. Reuse `ensureMirror`, `addWorktree`, `rebaseOnto` and
   `pushBranch` from `git/repo-git.ts` with a `RemoteAccess` for your
   host, and add a `mirrorPath(repo)` method (the git ops use it).
3. Make `openPullRequest` idempotent: the same `idempotencyKey` (task and
   repo) must never create a second pull request. When the API refuses for
   lack of permission, return `{ kind: 'manual', url }` instead of failing.
4. Register it in `compose.ts` (`hosts` and `hostFor`).
5. Tests: URL detection and PR calls against a mocked HTTP layer (see
   `source-github/github-host.test.ts`), and the git paths against a local
   bare repository (see `git/git.it.test.ts`).

## Trackers

```ts
interface Tracker {
  readonly kind: 'local' | 'jira';
  getTask(key): Promise<TrackerTask | undefined>;
  findReadyTasks(query?): Promise<TrackerTask[]>;
  comment(key, markdown): Promise<{ id; createdAt }>;
  transition(key, statusName): Promise<'moved' | 'not-available'>;
  readReplies(key, since, authorIds?): Promise<TrackerComment[]>;   // PM approval replies
  link(key): string | undefined;
}
```

`compose.ts` returns the Jira tracker when Settings has a Jira URL and the
keychain has `jira-token`, and the local tracker otherwise; it is resolved
per use, so turning Jira on needs no restart. The Jira adapter handles Cloud
(email + API token, `/rest/api/3`, the paged `search/jql` endpoint,
Markdown converted to Atlassian Document Format in `adf.ts`) and Data Center
(personal access token, Bearer). 429 and 5xx answers become
`RetryableError` so the runner retries with backoff.

## Agent runtime

```ts
interface AgentRuntime {
  readonly name: string;
  startSession(opts: AgentSessionOptions): Promise<AgentSession>;
  models?(): Promise<ModelOption[]>;                     // for the model picker
  defaultModel?(tier: 'light' | 'build'): Promise<string | undefined>;
}
```

`AgentSessionOptions` carries the mode (`read-only` or `build`), the
workspace folder, the allowed commands, Tandem's custom tools, the model,
and `maxNanoAiu`, the credit budget left for the run.

`agent-copilot` implements it with `@github/copilot-sdk`. Enforcement is in
`enforce.ts` and works in three layers: the tool filter, the permission
handler and a pre-tool-use hook; see ARCHITECTURE.md §7. It stops a run as
soon as its usage reaches `maxNanoAiu` and throws `BudgetError` with the
usage so far. Structured output goes through `strict-schema.ts`, because
OpenAI models reject non-strict JSON schemas.

`agent-scripted` replays a deterministic script: no network, no credits.
The tests, the browser tests and the end-to-end flows use it. It writes real
files, so the repos' real checks run on its output.

A new runtime must:

- refuse tools outside the mode's filter
- keep reads and writes inside the workspace
- run only allowed commands
- report usage in `AgentTurn`
- honour `maxNanoAiu`

The policies it must apply are data in `packages/core/src/policies/`
(`commands.ts`, `paths.ts`, `tools.ts`), with table-driven tests to reuse.

## Storage

`storage-sqlite` stores each record as a JSON document validated by the zod
schemas in `packages/shared`, with a few indexed columns. Migrations are a
numbered list in `migrations.ts`, applied in a transaction on open. The same
contract test (`store.contract.test.ts`) runs against SQLite and the
in-memory store; run it against any new `Store`.

## Secrets

`SecretStore` has `get`, `set`, `delete` and an availability check. The
keychain adapter stores under service `tandem`; when no keychain is usable it
refuses to store rather than falling back to a file.
