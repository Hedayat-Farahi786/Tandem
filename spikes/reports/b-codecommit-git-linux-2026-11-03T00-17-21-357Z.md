# Spike b: CodeCommit over SSH

- Result: **PASS** (16 passed, 0 failed, 0 skipped)
- Started: 2026-11-03T00:17:21.357Z
- os: linux 5.15.0-1084-aws (x64)
- node: v22.23.1
- git: 2.25.1
- mode: CodeCommit over SSH

## Steps

| Step | Result | Time |
| --- | --- | --- |
| URL is a CodeCommit URL (SSH or git-remote-codecommit) | PASS | 5 ms |
| Read access and default branch (ls-remote --symref) | PASS | 2684 ms |
| Bare clone with remote-tracking refspec ("mirror") | PASS | 11216 ms |
| Create spike base branch agent/spike-xurim2r2-base from main (stands in for the default branch) | PASS | 5411 ms |
| Worktree on agent/spike-xurim2r2-work from origin/agent/spike-xurim2r2-base | PASS | 25 ms |
| Commit in the worktree | PASS | 27 ms |
| Push guard refuses anything outside agent/* | PASS | 2578 ms |
| Push with explicit refspec | PASS | 6222 ms |
| Base branch moves (non-conflicting commit from another clone) | PASS | 9628 ms |
| Clean rebase onto the moved base | PASS | 5069 ms |
| Re-push after rebase with --force-with-lease (lease = last pushed sha) | PASS | 6059 ms |
| Stale lease is rejected (someone else pushed to the agent branch) | PASS | 15504 ms |
| Conflicting rebase is detected and aborted cleanly | PASS | 10272 ms |
| Conflict resolved (as the agent would), rebase continued, re-pushed with lease | PASS | 6293 ms |
| Default branch untouched | PASS | 2660 ms |
| Cleanup: delete spike branches on the remote, remove worktree | PASS | 8415 ms |

### URL is a CodeCommit URL (SSH or git-remote-codecommit)

- git uses: https+aws-cli (AWS profile hedayat)
- region eu-central-1, repo tandem-sandbox-backend, transport grc, AWS profile hedayat
- AWS CLI found; git signs CodeCommit requests with it, using your AWS sign-in

### Read access and default branch (ls-remote --symref)

- default branch: main

### Bare clone with remote-tracking refspec ("mirror")

- origin/main = bbcbb62c0d

### Create spike base branch agent/spike-xurim2r2-base from main (stands in for the default branch)

- origin/agent/spike-xurim2r2-base = bbcbb62c0d

### Worktree on agent/spike-xurim2r2-work from origin/agent/spike-xurim2r2-base

- worktree: /tmp/tandem-spike-b-lYPfgG/tasks/xurim2r2/sandbox

### Commit in the worktree

- commit 4c2846895e

### Push guard refuses anything outside agent/*

- refused: main, refs/heads/main, master, agent, feature/x, refs/tags/v1, agent/../main

### Push with explicit refspec

- remote agent/spike-xurim2r2-work = 4c2846895e

### Base branch moves (non-conflicting commit from another clone)

- origin/agent/spike-xurim2r2-base moved to b4d5639be4

### Clean rebase onto the moved base

- history now:
  test: spike xurim2r2 change
  test: upstream change xurim2r2
  chore: seed backend sandbox from Tandem template

### Stale lease is rejected (someone else pushed to the agent branch)

- rejected as expected: !	refs/heads/agent/spike-xurim2r2-work:refs/heads/agent/spike-xurim2r2-work	[rejected] (stale info)

### Conflicting rebase is detected and aborted cleanly

- conflicting files: README.md
- abort restored the branch and left a clean worktree

### Conflict resolved (as the agent would), rebase continued, re-pushed with lease

- resolved and pushed b3424133f8

### Cleanup: delete spike branches on the remote, remove worktree

- deleted agent/spike-xurim2r2-base
- deleted agent/spike-xurim2r2-work

## Findings

| Key | Value |
| --- | --- |
| git.transport | https+aws-cli |
| transport | grc |
| lsRemote.ms | 2684 |
| defaultBranch | main |
| clone.ms | 8595 |
| fetch.noop.ms | 2606 |
| push.ms | 3496 |
