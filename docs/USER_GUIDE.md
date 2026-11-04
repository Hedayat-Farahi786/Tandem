# Tandem user guide

This guide covers everyday use: from a request in chat to merged pull
requests. To install Tandem, see the [README](../README.md).

## The flow

```
Request ─▶ Readiness ─▶ Spec ─▶ Approvals ─▶ Build ─▶ Checks ─▶ Self-review ─▶ Pull requests ─▶ Done
```

1. **You ask for a change in chat.** Tandem asks questions until the request
   meets the Definition of Ready.
2. **Tandem writes a spec.** You approve it, and so does your PM (if your
   project uses PM approval).
3. **Copilot builds it** in a separate folder per task, on a new
   `agent/<key>-<title>` branch.
4. **Tandem runs your repo's checks**: install, lint, type-check, build,
   tests, and one test per acceptance criterion. If they fail, the agent
   gets two attempts to fix them.
5. **A separate review** compares the change with the spec, the criteria,
   your repo rules and a security checklist; the agent fixes what it finds.
6. **Tandem opens one pull request per repository**, with the spec, the
   criteria and their tests, and every check in the description.
7. **A person reviews and merges.** When every pull request is merged,
   Tandem marks the task done and cleans up.

## First-time setup

`pnpm tandem` opens the setup wizard on the first launch:

1. **Repositories**: paste each repository's URL. CodeCommit accepts the
   `codecommit::<region>://<profile>@<name>` form your clones use, SSH and
   HTTPS URLs; GitHub accepts SSH and HTTPS. Tandem clones it once and
   detects the language, the role (frontend, backend, full-stack) and the
   commands for install, lint, type-check, build and test. Check and edit
   the commands: Tandem runs exactly these.
2. **Project**: group the repositories that change together, for example
   one full-stack repo, or a frontend and a backend repo. Choose the task
   key prefix (`TND` gives `TND-1`, `TND-2`…) and how PMs approve specs:
   - **In Tandem**: you record the PM's approval (name, date, evidence).
   - **In Jira**: Tandem posts the spec to the issue and reads the PM's
     reply (needs [Jira](ENABLE_JIRA.md)).
   - **Off**: only your approval is needed.
3. **Copilot and AWS**: your name (used on approvals), the Copilot host if
   your Copilot comes from a GitHub Enterprise host, and the AWS profile for
   CodeCommit.
4. **Jira (optional)**: skip it, or see [Enable Jira](ENABLE_JIRA.md).
5. **Check**: the doctor checks the tools, Copilot access and every
   repository. Fix anything marked red, then open chat.

## Chat

The sidebar has **New chat**, your **Tasks** and **Projects**, and
**Recents**, your conversations for the current project. Settings and the
doctor are at the bottom.

A new chat starts in one of two modes:

- **Request**: describe a change. When Copilot needs to know something, a
  **Copilot needs you** card asks it: one short question at a time, with
  likely answers to pick (one, or any that apply) and **Other** for your own
  words. Number keys pick an answer and Enter goes on; **Answer in chat**,
  or simply typing a reply, works too.

  Beside the chat, the **spec draft** writes itself as Copilot reads the
  code and learns from your answers: the title, problem and goal, user story,
  acceptance criteria (Given / When / Then), example data, affected areas and
  what is out of scope. New text types in with a cursor; the header shows
  what Copilot is looking at, and a section still missing says what it
  needs. It tracks the Definition of Ready:
  - a clear goal
  - at least 2 acceptance criteria in Given / When / Then form
  - example data
  - the affected areas
  - what is out of scope
  - no open questions

  At the bottom:
  - **Create and start** (once the spec is ready) creates the task and moves
    straight into its live run. Copilot writes the full spec next, and no
    code is written before you approve it.
  - **Save for later** keeps it as a draft task that doesn't run, even if
    the spec isn't finished. Its page says **Saved, not started yet**;
    choose **Start task** when you're ready.
- **Ask**: questions about the code. Answers are read-only and cite files
  and lines.

Chat never changes code. Enter sends, Shift+Enter starts a new line.

### Choosing a Copilot model

The model menu in the composer lists the models your Copilot account offers,
grouped by vendor. For each model you see:

- its price in AI credits per million tokens (input, cached input, output)
- its context and output size, and whether it reads images
- an estimate for a typical task

A warning appears when a model is likely to go over the task's credit limit.

**Auto** uses the defaults from Settings: a light model for chat, specs and
reviews, and Copilot's own choice for code. A model picked in a request
chat carries over to its task. On a task, the model can be changed on its
Overview tab; the change applies from the next step.

## Tasks

**Tasks** lists everything Tandem is working on, filtered by **Needs you**,
**In progress** and **Finished**. A task opens as a conversation: your
request, each step and what Copilot did, the spec, approvals, checks and
pull requests, in the order they happened. What needs you sits at the end,
above the message box. While Tandem itself works (installing, building,
running the tests) a live line shows the step, how long it has run and its
latest output.

The details open beside the conversation (the panel button at the top right
shows or hides them); cards such as **Open spec** or **View checks** open
the right one, and a task waiting for your review opens its spec there:

| Tab | What's there |
| --- | --- |
| Overview | requirement, Definition of Ready, Copilot model and credits used |
| Spec | the spec, its versions and approvals; Copy as Markdown, Export as PDF |
| Changes | the diff per repository |
| Checks | criteria proven, checks passing and findings open at a glance; each criterion with its tests; each check with its output; review findings by severity |
| Pull requests | links, status, and whether each one still merges cleanly |
| Trace | the full chain from request to pull request (below) |

You can also create a task without chat: **Tasks › New task**.

### When Tandem needs you

| You see | What to do |
| --- | --- |
| **Not ready yet** | Answer the missing items, or edit the requirement, then check again. |
| **Too big for one reviewable change** | Accept the proposed split into smaller tasks, or keep it as one task and say why. |
| **Your review is needed** | Read the spec. **Approve spec**, or **Request changes** with what to change. |
| **Record PM approval** | Enter who approved, when, and the evidence (a link or a note). |
| **Copilot limit reached** | Raise the limit in Settings, then **Resume**. |
| **Low disk space** | Free space on the disk with Tandem's data, then **Resume**. |
| **Rebase conflict**, or a rejected push | Tell Copilot how to resolve it (below), or resolve it on the branch named in the message and **Resume**. |
| **Something failed** | Tell Copilot how to go on (below), or **Retry** to run the failed step again. |
| **Needs attention** (checks still fail on the pull request) | Tell Copilot how to fix it (below): it gets another round of fixes, and the pull request updates when the checks pass. |

Approvals belong to a spec version. Editing the spec, or redrafting it
after a change request, creates a new version, and earlier approvals stop
counting. Code is written only after both approvals of the current version.

**Cancel task** stops the work, removes the task folder and pushes nothing.

### Getting a stuck task moving

When a task stops, Tandem says so in the task's **Chat**, in plain words,
and asks how to go on. You can:

- **Answer under the message** on the task page and choose **Continue with
  this**.
- **Ask Copilot first** in the chat: "why did the test fail?". Copilot reads
  the failing checks and the code. When you agree on a way forward it
  proposes it, and **Continue with this** starts it.
- **Continue with this** in the chat sends what you typed as guidance.

Your guidance stays with the task: every later Copilot step includes it
(you can see it in the instructions on the **Activity** tab), and it is in
the audit log. While a task is working, **Tell Copilot** passes a note to
its next step.

Chat answers show what Copilot did to write them ("Read 3 files · searched
twice"); open the line to see each step.

### Failures that were there before

When a check fails on a task, Tandem runs the same check once on the base
branch (in a scratch copy, using the dependency cache) and compares:

- **Nothing new failing**: the failures were already there, so they aren't
  this task's. Copilot gets no fix round for them; the check shows
  "fails on development too" and the pull request says so.
- **New failures**: Copilot gets a fix round that names just the tests the
  change broke, and is told to leave the old ones alone.

The base branch result is remembered per commit, so this costs one run at
most. Check output is cleaned before Copilot or the pull request see it (no
colour codes or progress lines), so the failures themselves are in view.

Self-review fixes what matters: medium and high findings get a fix round;
low ones are listed on the pull request for the reviewer instead.

### Skipping a check for one task

Sometimes a check fails or never ends for a reason that has nothing to do
with the change: the browser tests need Chrome and this machine has none,
say. Copilot can't fix that, and more fix rounds only cost credits. Skip it
for this task instead:

- On **Checks**, a failing or timed-out check has **Skip for this task**.
- While a check runs for more than a minute, the live line in the task's
  conversation offers **Skip** for it.
- Or say so in the task chat ("ignore the Chrome tests and open the PR"):
  Copilot proposes the skip and **Continue with this** applies it.

Tandem stops the check if it is running, carries on without it, and lists
it on the pull request as skipped by you, with your reason. It's in the
audit log too. Other tasks still run the check.

### Spec changes from the task chat

Ask for a change in the task's chat ("also return the version"). Tandem
proposes either an edit or a redraft and shows it as a card; you confirm it
or dismiss it. Either way it becomes a new spec version that needs approval
again.

## Pull requests

Tandem opens one pull request per repository from the task's branch into
the repository's default branch. Their descriptions include:

- the summary and a link to the spec
- each acceptance criterion with its test and result
- every check that ran, with its result and time
- any open review findings
- links to the task's other pull requests

If your AWS profile may not create pull requests, Tandem prepares one
instead: **Open create page** (the branches are preselected), paste the
copied title and description, then paste the new pull request's link into
Tandem so it can follow it.

A pull request titled **[needs attention]** was opened even though checks
still failed after the fix attempts, so a reviewer can see why; the reasons
are at the top of its description.

### Keeping pull requests mergeable

While a pull request waits for review, Tandem checks it every few minutes
(Settings › Limits › PR check interval). When the default branch changes:

- If the pull request still merges cleanly, nothing changes.
- If they now conflict, Tandem merges the default branch into the pull
  request branch, has the agent resolve the conflicts, runs every check
  again, and pushes only if they pass. This is a merge commit on top: no
  history is rewritten, nothing is force-pushed, and review comments stay
  where they are. The description gets the new check results, and the task
  shows **Updated from the base branch**.
- If someone else has pushed to the branch, Tandem leaves it to them and
  shows **Conflicts with the base branch**. **Fix conflicts** lets Tandem do
  it anyway, on top of their commits.
- If the agent can't resolve a conflict, or checks fail afterwards, nothing
  is pushed and the task says so; **Fix conflicts** tries again.
- A branch someone rewrote with a force push is never touched again.

To have a person handle every conflict, turn off **Fix conflicts in open
pull requests** in Settings › Limits.

Tandem never merges. Merge in CodeCommit or GitHub as usual; Tandem notices
within a few minutes, or use **Mark as merged**. When every pull request is
merged, the task is done and its folder is removed.

### Review findings become rules

On the Checks tab, a review finding can be saved as a rule for its
repository. Rules are added to `docs/agent-rules.md` on the next task's
branch, where every later build and review reads them.

## Copilot limits

Copilot plans are often shared, so Tandem limits its own use. The limits are
set in Settings › Copilot budget, which also shows today's use:

| Limit | Default |
| --- | --- |
| AI credits per task | 25 |
| AI credits per day | 75 |
| Prompts per task | 15 |
| Prompts per day | 40 |
| Model calls per run | 60 |

A run that reaches a limit stops at once and the task waits with a
message. Raise the limit, then **Resume**. A typical task uses about 1–2
credits on a light model; the model menu shows an estimate per model.

## What Copilot did: the Activity tab

Every task has an **Activity** tab that tells, step by step, what Copilot
did: reading the request, writing the spec, building, fixing failing checks,
reviewing its own work, resolving conflicts. Each step shows the model, how
long it took and what it cost, and opens to show:

- **Tandem's instructions**: the exact prompt Copilot got
- **Thinking**: the model's reasoning, when the model shares it
- every **action**: files it read and edited, searches, the commands it ran,
  with their output and whether they worked
- anything **Tandem blocked**, and why
- what Copilot **said**

The step Copilot is working on updates live. Secrets are removed before
anything is stored, and long output is shortened.

## Traceability and audit

- **Task › Trace** shows one task's full chain, in order:
  - **Request**: who asked, their words, whether it met the Definition of
    Ready, and the size estimate.
  - **Acceptance criteria and tests**: each criterion with the tests that
    prove it and their result.
  - **Spec and approvals**: each version with who approved it, how and
    when, and a SHA-256 fingerprint of its text, so an approval is tied to
    exactly what was approved. The spec is kept in Tandem, not in the repo.
  - **Copilot runs**: every run on its own, with its role, whether it could
    write code, the model, how long it took, its actions, the files it
    changed, anything a guardrail refused, its credits, a fingerprint of
    Tandem's instructions and whether your guidance was included.
  - **Code changes**: every commit Tandem made, with its message and files.
  - **Checks and review**, **decisions by people** (approvals, guidance,
    skipped checks, resumes, renames, cancels), and **exceptions** (failed
    or stopped runs, refused actions, credit limits, skipped checks and
    failures that were already on the base branch).
  - **Pushes and pull requests**, the **lifecycle** (every state change,
    who made it and why), and the task's **audit entries**, with the audit
    chain's verification.

  **Download report** saves it all as Markdown, ready to attach to a change
  record; **JSON** for tools.
- **Settings › Audit log**: Tandem records every change to settings,
  tokens (never their values), repositories, projects, rules, approvals,
  commits and pull requests, with who made it. Each entry carries a SHA-256
  hash that also covers the entry before it, so changing or deleting an
  entry later breaks the chain and Settings says so. Copy the head hash now
  and then (for example into a ticket). **CSV** and **JSON** export
  everything, Copilot runs and checks included.

## Project icons

Each project shows its website's own icon: the one its `index.html` links
to, or a favicon in the usual places (`public/`, `static/`, the root, or
Next.js `app/`), read from the default branch of its repositories, in its own
colours. Projects without one show their initials. The icon is served with a sandbox policy,
so an SVG from a repository can never run script in Tandem.

## Search

Press **Ctrl K** (**⌘K** on a Mac) to jump to any page, task (by title or
key) or project, or to switch the theme.

## Light and dark

The moon / sun button at the top of the sidebar switches the theme;
Tandem follows your system setting until you choose.
