# Spike c: CodeCommit pull requests (AWS SDK and console-link fallback)

- Result: **PASS** (14 passed, 0 failed, 0 skipped)
- Started: 2026-11-03T00:19:04.439Z
- os: linux 5.15.0-1084-aws (x64)
- node: v22.23.1
- git: 2.25.1

## Steps

| Step | Result | Time |
| --- | --- | --- |
| Default branch over SSH | PASS | 2556 ms |
| Push a branch agent/spike-xwz20b92-pr with one commit | PASS | 12120 ms |
| AWS credentials resolve (STS GetCallerIdentity) | PASS | 433 ms |
| GetRepository | PASS | 442 ms |
| Permission probe: CreatePullRequest with a non-existent source ref (creates nothing) | PASS | 68 ms |
| Permission: ListPullRequests / GetPullRequest (needed for status polling) | PASS | 233 ms |
| CreatePullRequest with clientRequestToken | PASS | 274 ms |
| Retry with the same token returns the same PR (no duplicate after a restart) | PASS | 256 ms |
| GetPullRequest reports status and merge state | PASS | 158 ms |
| UpdatePullRequestDescription (used to cross-link PRs) | PASS | 311 ms |
| Description length limit | PASS | 255 ms |
| Close the PR (UpdatePullRequestStatus CLOSED) | PASS | 564 ms |
| Console-link fallback: link opens the prefilled "Create pull request" page | PASS | 1 ms |
| Cleanup: delete spike branch, remove worktree | PASS | 2821 ms |

### AWS credentials resolve (STS GetCallerIdentity)

- account ****3860, arn:aws:sts::************:assumed-role/<role>/<session>

### GetRepository

- default branch per API: main

### Permission probe: CreatePullRequest with a non-existent source ref (creates nothing)

- probe result: ReferenceDoesNotExistException

### Permission: ListPullRequests / GetPullRequest (needed for status polling)

- ListPullRequests ok (0 returned)

### CreatePullRequest with clientRequestToken

- pull request 2 (OPEN)
- console: https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/tandem-sandbox-backend/pull-requests/2/details?region=eu-central-1

### GetPullRequest reports status and merge state

- status OPEN, merged false, source 3c2eecab10

### Description length limit

- 10,240 characters accepted
- 10,241 characters rejected: InvalidDescriptionException

### Console-link fallback: link opens the prefilled "Create pull request" page

- prefilled link: https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/tandem-sandbox-backend/pull-requests/new/refs/heads/main/.../refs/heads/agent/spike-xwz20b92-pr?region=eu-central-1
- fallback link (PR list): https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/tandem-sandbox-backend/pull-requests?region=eu-central-1

## Findings

| Key | Value |
| --- | --- |
| region | eu-central-1 |
| repo | tandem-sandbox-backend |
| aws.profile | hedayat |
| probe.errorName | ReferenceDoesNotExistException |
| canCreatePullRequest | true |
| canListPullRequests | true |
| idempotentCreate | true |
| description.maxLength | 10240 |
| console.prefilledLink.format | https://{region}.console.aws.amazon.com/codesuite/codecommit/repositories/{repo}/pull-requests/new/refs/heads/{dest}/.../refs/heads/{source}?region={region} |
| console.prefilledLink.confirmed | not checked (no terminal); open the link above and confirm |
