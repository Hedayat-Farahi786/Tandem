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

- **Request**: describe a change. Tandem asks until the request is clear
  and testable. The panel beside the chat shows the Definition of Ready:
  - a clear goal
  - at least 2 acceptance criteria in Given / When / Then form
  - example data
  - the affected areas
  - what is out of scope
  - no open questions

  When every item is checked, **Create task**.
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
**In progress** and **Finished**. A task's page has a progress bar, the actions it is waiting for,
and these tabs:

| Tab | What's there |
| --- | --- |
| Overview | requirement, timeline, Copilot model and credits used |
| Spec | the spec, its versions and approvals; Copy as Markdown, Export as PDF |
| Changes | the diff per repository |
| Checks | each criterion and its test, every check's output, review findings |
| Pull requests | links, status, and whether each one still merges cleanly |
| Chat | questions about this task; ask for a spec change here |

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
| **Rebase conflict**, or a rejected push | Resolve it on the branch named in the message, then **Resume**. |
| **Something failed** | Read the message; **Retry** runs the failed step again. |

Approvals belong to a spec version. Editing the spec, or redrafting it
after a change request, creates a new version, and earlier approvals stop
counting. Code is written only after both approvals of the current version.

**Cancel task** stops the work, removes the task folder and pushes nothing.

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

## Traceability and audit

Tandem records who did what, and when, so a change can be followed from the
request to the merged code.

- **Activity** (sidebar) lists everything newest first: tasks created,
  state changes, spec edits, approvals (with the spec version and the
  evidence), commits pushed, pull requests opened or linked, every Copilot
  run (model, prompts, AI credits), every check run, and every change to
  Settings, tokens, repositories, projects and rules. Filter by kind,
  project and time range; open a row for its details. **Export CSV** or
  **JSON** downloads what the filters show.
- **The audit log** behind it is append-only, and each entry carries a
  SHA-256 hash that also covers the entry before it. Changing or deleting
  an entry later breaks the chain, and Activity says so instead of "Audit
  log verified". Copy the head hash now and then (for example into a
  ticket): if an earlier entry is ever changed, that hash no longer
  matches. Token values are never recorded, only that a token was saved
  or removed.
- **Task › Trace** shows one task's chain: the request, each acceptance
  criterion with the tests that prove it, each spec version with who
  approved it, Copilot use per step, checks and review findings, the
  commits pushed and the pull requests, and the task's audit entries.
  **Download report** saves it as Markdown, ready to attach to a change
  record; **JSON** for tools.

Entries are kept in Tandem's database in `~/.tandem`. Tasks from before
this version show their history, but their audit entries start at the
upgrade.

## Project icons

Each project shows its website's own icon: the one its `index.html` links
to, or a favicon in the usual places (`public/`, `static/`, the root, or
Next.js `app/`), read from the default branch of its repositories and shown in
grayscale to match the rest of Tandem. Projects without one show their
initials. The icon is served with a sandbox policy,
so an SVG from a repository can never run script in Tandem.

## Search

Press **Ctrl K** (**⌘K** on a Mac), or click **Search** in the sidebar, to
jump to any page, task (by title or key) or project, or to switch the
theme.

## Light and dark

The moon / sun button at the top of the sidebar switches the theme;
Tandem follows your system setting until you choose.
