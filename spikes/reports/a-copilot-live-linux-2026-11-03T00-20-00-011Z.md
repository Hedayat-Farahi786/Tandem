# Spike a (live): Copilot SDK, two real prompts

- Result: **PASS** (15 passed, 0 failed, 0 skipped)
- Started: 2026-11-03T00:20:00.011Z
- os: linux 5.15.0-1084-aws (x64)
- node: v22.23.1
- sdk: 1.0.28
- copilotRuntime: bundled
- copilotHost: <company>.ghe.com
- mode: live (2 prompts max)

## Steps

| Step | Result | Time |
| --- | --- | --- |
| Runtime starts (SDK bundled runtime) | PASS | 72 ms |
| Signed in with the existing Copilot CLI login (no token passed) | PASS | 111 ms |
| Models, policy access and cost (listModels, no model call) | PASS | 897 ms |
| Built-in tools on this OS | PASS | 4 ms |
| Sandbox worktree with dependencies installed (by Tandem, not the agent) | PASS | 14875 ms |
| Read-only session: writes, shell and web are denied in the runtime (no model call) | PASS | 76 ms |
| Build session: push, commit, cloud CLI, network and outside writes are denied (no model call) | PASS | 2879 ms |
| Restart before the first turn: Tandem re-creates the session with the same enforcement (no model call) | PASS | 533 ms |
| Unavailable model is reported clearly (no model call) | PASS | 31 ms |
| Confirm spending 2 prompts on gpt-6-luna (cap: 30 model calls) | PASS | 0 ms |
| Live 1: streaming answer with structured output in a read-only session | PASS | 11146 ms |
| Live 2: build session edits code and tests; denied actions stay denied | PASS | 26135 ms |
| Live: session with history resumes after the runtime is killed (no extra prompt) | PASS | 335 ms |
| Usage stayed within the budget | PASS | 0 ms |
| Sessions end cleanly | PASS | 36 ms |

### Runtime starts (SDK bundled runtime)

- runtime 1.0.105, protocol 3

### Signed in with the existing Copilot CLI login (no token passed)

- bundled runtime: authenticated=true type=gh-cli <work-account> (via gh)
- signed in as <work-account> on https://<company>.ghe.com (COPILOT_GH_HOST)

### Models, policy access and cost (listModels, no model call)

- auto: cost unknown
- claude-sonnet-5.5: in 200 / out 1000
- claude-sonnet-5: in 200 / out 1000
- claude-fable-5.1: in 1000 / out 5000
- claude-fable-5: in 1000 / out 5000
- claude-opus-5.5: in 400 / out 2000
- claude-opus-5: in 500 / out 2500
- claude-opus-4.8: in 500 / out 2500
- claude-haiku-4.5: in 100 / out 500
- gpt-6.1-sol: in 200 / out 1000
- gpt-6-sol: in 200 / out 1000
- gpt-6-luna: in 10 / out 50
- gpt-6-astra: in 1000 / out 5000
- gpt-5.6-sol: in 400 / out 2000
- gpt-5.6-terra: in 200 / out 1200
- gpt-5.6-luna: in 20 / out 120
- gpt-5.3-codex: in 175 / out 1400
- mai-code-1.1-flash: in 20 / out 120

### Built-in tools on this OS

- bash, read_bash, stop_bash, list_bash, glob, grep, create, edit, skill, view, web_fetch, task, read_agent, list_agents, write_agent

### Sandbox worktree with dependencies installed (by Tandem, not the agent)

- sandbox: CodeCommit

### Read-only session: writes, shell and web are denied in the runtime (no model call)

- create: denied - Denied by preToolUse hook: Blocked by Tandem: create is not available in read-only sessions
- edit: denied - Denied by preToolUse hook: Blocked by Tandem: edit is not available in read-only sessions
- bash: denied - Denied by preToolUse hook: Blocked by Tandem: bash is not available in read-only sessions
- web_fetch: denied - Denied by preToolUse hook: Blocked by Tandem: web_fetch is not available in read-only sessions
- view: denied - Denied by preToolUse hook: Blocked by Tandem: /tmp/tandem-spike-a-v8hmzD/outside-xy5xqpz1.txt is outside the workspace
- view inside the workspace: failure
- decisions:
  hook:DENY create (create is not available in read-only sessions)
  hook:DENY edit (edit is not available in read-only sessions)
  hook:DENY bash (bash is not available in read-only sessions)
  hook:DENY web_fetch (web_fetch is not available in read-only sessions)
  hook:DENY view /tmp/tandem-spike-a-v8hmzD/outside-xy5xqpz1.txt (/tmp/tandem-spike-a-v8hmzD/outside-xy5xqpz1.txt is outside the workspace)
  hook:allow view /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/README.md

### Build session: push, commit, cloud CLI, network and outside writes are denied (no model call)

- bash "git push origin HEAD": denied
- bash "git commit -am x": denied
- bash "git -c core.hooksPath=/tmp status": denied
- bash "aws sts get-caller-identity": denied
- bash "curl https://example.com": denied
- bash "npm test; git push": denied
- bash "echo $(cat ~/.ssh/id_rsa)": denied
- create "/tmp/tandem-spike-a-v8hmzD/outside-xy5xqpz1.txt": denied
- create "/tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/.git/hooks/pre-commit": denied
- web_fetch "https://example.com": denied
- allowed create: failure; allowed npm test: failure
- decisions:
  hook:DENY bash: git push origin HEAD (git push is not allowed; Tandem commits, rebases and pushes for you)
  hook:DENY bash: git commit -am x (git commit is not allowed; Tandem commits, rebases and pushes for you)
  hook:DENY bash: git -c core.hooksPath=/tmp status (git options before the subcommand (like -c or -C) are not allowed)
  hook:DENY bash: aws sts get-caller-identity ("aws" is not allowed in Tandem build sessions)
  hook:DENY bash: curl https://example.com ("curl" is not allowed in Tandem build sessions)
  hook:DENY bash: npm test; git push (git push is not allowed; Tandem commits, rebases and pushes for you)
  hook:DENY bash: echo $(cat ~/.ssh/id_rsa) (command substitution, process substitution and heredocs are not allowed)
  hook:DENY create /tmp/tandem-spike-a-v8hmzD/outside-xy5xqpz1.txt (/tmp/tandem-spike-a-v8hmzD/outside-xy5xqpz1.txt is outside the workspace)
  hook:DENY create /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/.git/hooks/pre-commit (writing inside .git is not allowed)
  hook:DENY web_fetch (web_fetch is not available in build sessions)
  hook:allow create /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/allowed-xy5xqpz1.txt
  hook:allow bash: npm test

### Restart before the first turn: Tandem re-creates the session with the same enforcement (no model call)

- child created a session, used a tool, and was killed with SIGKILL before any model turn
- resume: Request session.resume failed with message: Failed to load session events: Session not found: tandem-spike-xy5xqpz1
- re-created session has the same enforcement

### Unavailable model is reported clearly (no model call)

- createSession accepted the unknown model; the error appears on the first prompt

### Confirm spending 2 prompts on gpt-6-luna (cap: 30 model calls)

- model: gpt-6-luna (cheapest enabled: input 10 / output 50 per batch)

### Live 1: streaming answer with structured output in a read-only session

- {"summary":"This Fastify service returns a personalized greeting as JSON, using “world” when no name is provided.","routes":[{"method":"GET","path":"/api/greeting","file":"src/app.ts","line":15}]}
- 49 deltas, first after 10899 ms

### Live 2: build session edits code and tests; denied actions stay denied

- answer: Changed the default greeting from “Hello, world” to “Hello, Tandem” and updated its test. `npm test` passed (3 tests).
  
  I did not attempt `git push origin HEAD` or create the file in `/tmp`: this session prohibits pushes and restricts file edits to the workspace.
- decisions:
  hook:allow glob
  hook:DENY rg (rg is not available in build sessions)
  hook:DENY bash: git status --short && printf '\n--- package.json ---\n' && cat package.json ("printf \n--- package.json ---\n" is not on the allowlist (configured repo commands, package installs, read-only helpers, safe git))
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox
  hook:allow glob
  hook:allow glob
  hook:allow glob
  hook:allow bash: git status --short
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox
  permission:allow git status --short
  hook:allow view /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/src/app.ts
  hook:allow view /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/test/app.test.ts
  hook:allow view /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/package.json
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/src/app.ts
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/test/app.test.ts
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/package.json
  hook:allow apply_patch /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/src/app.ts, /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/test/app.test.ts
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/src/app.ts
  permission:allow /tmp/tandem-spike-a-v8hmzD/tasks/xy5xqpz1/sandbox/test/app.test.ts
  hook:allow bash: npm test
  permission:allow npm test
  hook:allow bash: git diff -- src/app.ts test/app.test.ts
  permission:allow git diff -- src/app.ts test/app.test.ts
- diff:
  src/app.ts       | 2 +-
   test/app.test.ts | 4 ++--
   2 files changed, 3 insertions(+), 3 deletions(-)
- Tandem ran npm test: exit 0

### Live: session with history resumes after the runtime is killed (no extra prompt)

- restored 121 events (1 user messages) after forceStop and a new runtime

### Usage stayed within the budget

- prompts sent: 2; model calls: 11; cost units: 11; nano-AIU: 507231500; models: gpt-6-luna

### Sessions end cleanly

- deleted 7 spike sessions from ~/.copilot

## Findings

| Key | Value |
| --- | --- |
| sdk | @github/copilot-sdk 1.0.28 (bundled runtime 1.0.105) |
| tokenEnvVarsRemoved | JIRA_API_TOKEN |
| runtime.version | 1.0.105 |
| auth.type | gh-cli |
| auth.login | <work-account> |
| auth.host | https://<company>.ghe.com |
| auth.runtime | SDK bundled runtime (reads the same ~/.copilot login) |
| models.enabled | auto, claude-sonnet-5.5, claude-sonnet-5, claude-fable-5.1, claude-fable-5, claude-opus-5.5, claude-opus-5, claude-opus-4.8, claude-haiku-4.5, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.3-codex, mai-code-1.1-flash |
| models.cheapest | gpt-6-luna (input 10 / output 50 per batch) |
| models.zeroCost | none reported |
| tools.builtin | bash,read_bash,stop_bash,list_bash,glob,grep,create,edit,skill,view,web_fetch,task,read_agent,list_agents,write_agent |
| tools.shell | bash |
| tools.execute.beforeFirstTurn | not available (Tool 'view' does not exist. Available tools that can be call) |
| enforcement.allowedCallsWithoutModel | not run before first turn (failure) |
| enforcement.layer | preToolUse hook denies before the tool runs |
| resume.beforeFirstTurn | not stored until the first turn; Tandem re-creates it |
| error.unavailableModel | createSession accepted the unknown model; the error appears on the first prompt |
| live.streaming.firstDeltaMs | 10899 |
| live.structuredOutput | works |
| live.hookSawShell | 4 |
| live.permissionSawShell | 3 |
| resume.afterCrash | works (121 events restored, enforcement re-applied) |
| usage.prompts | 2 |
| usage.modelCalls | 11 |
| usage.cost | 11 |
