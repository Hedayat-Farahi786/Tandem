# Spike d: local tracker survives restarts

- Result: **PASS** (5 passed, 0 failed, 0 skipped)
- Started: 2026-11-02T23:53:31.241Z
- os: linux 5.15.0-1084-aws (x64)
- node: v22.23.1
- sqlite: node:sqlite

## Steps

| Step | Result | Time |
| --- | --- | --- |
| Process 1: create task, add two comments, change status, exit | PASS | 214 ms |
| Process 2: commit a comment, then hard kill (SIGKILL) | PASS | 146 ms |
| Process 3: hard kill in the middle of a transaction | PASS | 129 ms |
| Process 4: data intact after restarts, partial transaction rolled back | PASS | 147 ms |
| Same process: create a second task after restart (key sequence continues) | PASS | 12 ms |

### Process 1: create task, add two comments, change status, exit

- created TND-1

### Process 2: commit a comment, then hard kill (SIGKILL)

- child ended with SIGKILL

### Process 3: hard kill in the middle of a transaction

- child ended with SIGKILL

### Process 4: data intact after restarts, partial transaction rolled back

- status READINESS, 3 comments, 1 transition, integrity ok, journal wal

## Findings

| Key | Value |
| --- | --- |
| sqlite.journal | wal |
