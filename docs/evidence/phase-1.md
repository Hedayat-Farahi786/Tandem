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
| a: Copilot SDK, live mode (2 prompts) | not run, waiting for the owner's go-ahead | – | – |
| b: CodeCommit for real | blocked: no valid AWS credentials on the machine | 0 | – |
| c: CodeCommit PRs | blocked: same | 0 | – |
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

## Waiting on the owner

- Sign in to AWS on the machine (the profile used for CodeCommit), so that
  `aws sts get-caller-identity` works.
- Sandbox repos in CodeCommit: create three empty ones, or approve Tandem
  creating them.
- Go-ahead for spike a live: 2 prompts on `gpt-6-luna`, hard-capped.
