# Phase 1 evidence

Spikes run on the owner's machine: Ubuntu 20.04.6 (x86_64, an EC2 host used
over VS Code Remote-SSH), Node 22.23.1, git 2.25.1, Copilot CLI 1.0.105,
AWS CLI 2.33.7. Reports are in `spikes/reports/`; company host and work
account names are masked in them.

## Results

| Spike | Result | Model calls | Report |
| --- | --- | --- | --- |
| d: local tracker survives restarts | **PASS** 5/5 | 0 | `d-local-tracker-linux-2026-11-02T23-53-31-241Z.md` |
| b: git workflow (local stand-in remote) | **PASS** 16/16 after a git 2.25 fix | 0 | `b-git-local-linux-2026-11-02T23-58-23-075Z.md` (first run, failing on `init --initial-branch`: `…23-53-33-194Z.md`) |
| a: Copilot SDK, free mode | **PASS** 11/11 with `COPILOT_GH_HOST` set | 0 | `a-copilot-linux-2026-11-02T23-59-35-493Z.md` (first run, 403 on the default host: `…23-53-59-278Z.md`) |
| a: Copilot SDK, live mode (2 prompts on `gpt-6-luna`) | **PASS** 15/15 | 11 (cap 30), about 0.5 AI credits | `a-copilot-live-linux-2026-11-03T00-20-00-011Z.md` |
| b: CodeCommit for real (`tandem-sandbox-backend`) | **PASS** 16/16 over HTTPS with the AWS CLI credential helper | 0 | `b-codecommit-git-linux-2026-11-03T00-17-21-357Z.md` |
| c: CodeCommit PRs | **PASS** 14/14 (PR created, retried, updated, closed); console link waiting for a click | 0 | `c-codecommit-pr-linux-2026-11-03T00-19-04-439Z.md` |
| d: Jira | skipped (not configured, optional) | 0 | – |

## Findings that changed the design

1. **Copilot host.** The Copilot CLI here has no login of its own. The
   runtime uses the GitHub CLI's tokens (`authType: gh-cli`). `gh` is signed
   in to two accounts: github.com (personal) and the company's GitHub
   Enterprise Cloud data-residency host (`<company>.ghe.com`). On the default
   host, `listModels` returned `403 unauthorized: not authorized to use this
   Copilot feature`. With `COPILOT_GH_HOST=<company>.ghe.com` it signed in as
   the work account with 18 models. Tandem gets a `copilot.host` setting;
   doctor suggests it on a 403.
2. **Billing is per token (AI credits).** Every model reports token prices.
   The cheapest is `gpt-6-luna` (input 10 / output 50 per batch), against 200
   / 1000 for `claude-sonnet-5.5`. It is the default for light steps and the
   live spike.
3. **Enforcement works in the real runtime with zero cost.** Through
   `session.rpc.tools.execute`, all forbidden actions were denied by the
   `onPreToolUse` hook: 5 read-only and 10 build-mode, including `git push`,
   `git commit`, `git -c`, `aws`, `curl`, chained push, command substitution,
   writes outside the worktree and into `.git`, and `web_fetch`.
   `assistant.usage` events: 0.
4. **Allowed tools only run after the first model turn.** Even signed in,
   the runtime offers no tools to `tools.execute` before a turn, so the
   allowed path (edit + test) is proven only in the live run.
5. **No session is stored before its first turn.** `resumeSession` fails
   with "Session not found"; Tandem re-creates the session with the same
   enforcement (verified).
6. **git 2.25.** `git init --initial-branch` needs 2.28; replaced. Everything
   else in the git workflow works on 2.25. Doctor minimum is now 2.25.
7. **CodeCommit access is through git-remote-codecommit, not SSH.** All 19
   existing CodeCommit clones on the machine use `codecommit::<region>://`
   URLs (AWS credentials, default chain). The SSH key configured for
   CodeCommit is rejected (`Permission denied (publickey)`). Tandem supports
   `codecommit::`, SSH and HTTPS URLs, and spikes b and c accept all three.
8. **AWS credentials expire.** None of the three profiles had working
   credentials at test time (`InvalidClientTokenId`, an expired `aws login`
   session, none). Doctor and preflight report this as "sign in again"
   with the exact command.

9. **git-remote-codecommit can't read `aws login` sessions.** The working
   profile uses `login_session` (AWS CLI 2.32+). git-remote-codecommit's
   bundled botocore 1.37 reports "profile does not have credentials". Tandem
   uses CodeCommit HTTPS with `aws codecommit credential-helper --profile <p>`
   instead, passed per command, so the user's git config is untouched. The
   AWS JS SDK (credential-provider-ini 3.973) reads `login_session` directly.
10. **CodeCommit HTTPS doesn't advertise the HEAD symref.** `ls-remote
    --symref` returns only HEAD's commit. Default branch: CodeCommit API
    `GetRepository` first, then a branch matching HEAD's commit (main/master
    preferred).
11. **CodeCommit PR API.** Permission probe confirmed:
    `ReferenceDoesNotExistException` means allowed, and nothing is created.
    `clientRequestToken` makes create idempotent (a retry returned the same
    PR). Descriptions are limited to 10,240 characters
    (`InvalidDescriptionException` at 10,241). Each network git operation
    takes 2–6 s (credential helper plus network).
12. **Live Copilot run.** Streaming with structured output found `GET
    /api/greeting` at `src/app.ts:15`. The build turn edited code and test
    with `apply_patch`, ran `npm test` (allowed by both layers), and Tandem's
    own test run passed. The model declined to try the forbidden actions,
    which were already proven denied. After `forceStop` and a new runtime,
    the session resumed with 121 events. This model uses a search tool named
    `rg` and `printf`; both are now allowed (read-only). First token arrived
    after about 11 s. Event streams are saved, sanitized, as
    `spikes/reports/fixtures/copilot-events-1.0.28.json`.

## Sandbox repos (CodeCommit, eu-central-1)

`tandem-sandbox-fullstack`, `tandem-sandbox-backend` and
`tandem-sandbox-frontend`, tagged `purpose=tandem-sandbox`, seeded from
`spikes/sandbox/*` on `main`.

## Waiting on the owner

- Open the console link for `agent/console-link-check` and confirm the
  "Create pull request" page shows main ← agent/console-link-check.
