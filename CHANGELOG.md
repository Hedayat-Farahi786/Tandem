# Changelog

All notable changes to Tandem. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **One view for a task, and a fuller trace.** The task page is the
  conversation with the details beside it; the separate Details view is
  gone. The Checks tab opens with criteria proven, checks passing and
  findings open, and shows criteria as cards with their tests, each check
  with its own icon, and findings by severity. The trace now covers who
  asked and whether it was ready, every Copilot run on its own (role, mode,
  model, time, actions, files changed, refused actions, credits, an
  instructions fingerprint), every commit with its files, SHA-256
  fingerprints of each spec version, decisions by people, exceptions and
  the full lifecycle, in the screen and the Markdown report. Tandem now
  records every commit it makes in the audit log.
- **A task page that fits one screen.** On wide screens the task opens as
  an app-style page: a compact one-line bar (back, key, title, status,
  view, details toggle, cancel) with a slim stage strip, then the
  conversation and the details side by side, each scrolling on its own,
  with the message box always in view. Cards in the conversation are
  tighter, long notes stay to two lines, and the details panel no longer
  repeats the progress steps or the history.
- **The spec stays in Tandem.** Tasks no longer commit
  `specs/<KEY>-<slug>.md` to the repository; the pull request carries only
  the change. Tandem keeps every spec version with its approvals and trace,
  and the pull request names the approved version.
- **A spec that writes itself beside a request.** The request chat shows
  the spec draft on the right, filling in live with a typing cursor as
  Copilot reads the code and takes your answers, with what it is looking at
  in the header and what each missing section needs. **Create and start**
  turns it into a running task and moves into the live run; **Save for
  later** keeps it as a draft task that doesn't run until **Start task**.
- **Knowing where a repo starts.** A failing check is compared with the
  same check on the base branch (once per base commit, cached). Failures
  that were already there no longer cost Copilot fix rounds or mark the PR
  "needs attention"; new failures get a fix round that names just them.
  Check output is cleaned of colour codes and progress lines, so Copilot
  sees the actual failures. Low self-review findings are listed on the PR
  instead of triggering a fix run and another round of checks. Copilot may
  run the repo's own configured commands even when they set a variable
  (`CHROME_BIN=… npx ng test`), and `npx ng` for tests, lint and builds.
- **Skip a check for one task.** A check that fails or hangs for reasons
  outside the change (a test runner that can't start on this machine) can
  be skipped from the Checks panel, from the live "Running the checks" line,
  or by asking in the task chat. Tandem stops it if it's running, carries on
  without it, and the pull request lists it as skipped, with the reason.

### Fixed

- Verification read a repository's commands once per step, so a corrected
  test command only applied to the next task. It now reads them every round.
- A Copilot run stopped mid-fix (credit limit, restart) left its edits
  uncommitted, and the next rebase failed with "You have unstaged changes".
  Tandem now commits and checks those edits first.
- Settings fixed by environment variables at start (such as
  `TANDEM_CREDITS_PER_TASK`) looked editable, but changes did nothing. They
  now show as locked, naming the variable, and saving a change is refused
  with an explanation.
- Checks that change files themselves (a lint script with `--fix`, a
  formatter) left the task's folder modified, so the next rebase failed.
  Tandem now commits what a repository's own checks changed. Special check
  rounds say what they are ("after the rebase") instead of "attempt 151".
- Pull request titles are the change's short name only: no task number and
  no "[needs attention]" (that is in the description), cut cleanly at 72
  characters. Open pull requests with an old-style title are renamed on the
  next status check. Copilot names requests in 3 to 8 words.
- The task chat can rename a task: its open pull requests take the new name
  at once. It knows each pull request's title and status, no longer claims
  to "submit a handoff", and says plainly when a message has no step left
  to act on. When a problem it asked for help with resolves itself, the
  chat says so instead of leaving the alarm as the last word.
- Leaving or reloading the page while Copilot answers no longer loses track
  of it: the chat opens straight into the live view and the answer appears
  when it's done. A second message waits until the first is answered (it's
  refused with a plain note instead of competing for the session). A failed
  answer leaves a note in the chat, a restart clears any chat left
  answering, and an unsent message is kept per chat in this browser.
- Saying the same thing twice in the task chat no longer repeats it in every
  later Copilot prompt.
- The task chat no longer answers "this session can't create a PR": it says
  what Tandem will do next.

- **Questions you can answer with a click.** In a request chat, Copilot
  asks through a "Copilot needs you" card: short questions, one at a time,
  with likely answers to pick (single or multiple choice) and "Other" for
  your own. Number keys and Enter work. Your answers show as a tidy
  question-and-answer message, and Copilot gets them in plain words.
- **A live task draft.** The Definition of Ready beside a request chat
  fills in while Copilot works (the item it's on shimmers, done ones tick
  and show what was filled in), then becomes the task to create with a
  short summary. Creating it moves smoothly into the task's conversation,
  and a task's side panel follows it to what needs you: the spec to review,
  failing checks, the pull requests.

- **A task as a conversation.** A task now opens in a Chat view: the
  request, every step, what Copilot did, the spec, approvals, checks and
  pull requests in one stream, with what needs you right above the message
  box. Details (spec, changes, checks, pull requests, trace) open beside it.
  The tabbed page is still one click away as Details, and Tandem remembers
  the choice. While Tandem runs checks itself, a live line shows the step,
  its time and latest output, so a long step never looks stuck.
- **Angular tests finish.** A repository whose test script is `ng test`
  (watch mode by default) is now set up to run its tests once, in headless
  Chrome, so verification ends instead of waiting until it times out.
- **Runs cut off by a restart** are marked stopped on the next start, so
  they no longer show as working forever.

- **Clearer visual hierarchy.** Text has three distinct steps (primary for
  names and content, secondary for descriptions, tertiary for times, IDs and
  captions), each tied to one size, and every step meets WCAG AA on every
  surface in both themes. Surfaces and hairlines step more clearly, so cards
  and dividers read crisply, especially in dark mode. The type scale went
  from 17 sizes to 11. Blue "info" is now the teal accent, so one color
  leads. The selected tab shows its underline again, the Activity tab lines
  up with the tabs, and sidebar links stand above the Recents list.

- A new visual design: a deep teal accent (#0E3B3B, a lighter teal in dark
  mode), a neutral palette, Inter display headings, pages on
  a raised panel, grouped settings cards, a step indicator and icon
  timeline on tasks, and richer empty states. Contrast still passes axe (WCAG AA) in light and dark.

## [1.0.0] - 2026-11-03

The first release: from a chat request to tested, reviewed pull requests, on
your machine.

### Added

- **Chat.** Request mode asks until a change meets the Definition of Ready
  (goal, 2+ Given/When/Then criteria, example data, affected areas, out of
  scope, no open questions), then creates the task. Ask mode answers
  questions about the code with file and line references. Recent
  conversations are in the main sidebar.
- **Specs and approvals.** Specs from the project's template, versioned;
  owner approval plus PM approval (recorded in Tandem, taken from Jira
  replies, or off). Approvals belong to a version; editing or redrafting
  resets them. Copy as Markdown, Export as PDF.
- **Size check.** Too-big tasks get a proposed split into smaller tasks, or
  stay one task with a stated reason.
- **Build and checks.** Copilot builds in a separate worktree per task and
  repository, on an `agent/*` branch. Tandem runs the repository's own
  install, lint, type-check, build and test commands and one test per
  acceptance criterion, and gives the agent two attempts to fix failures.
- **Self-review.** A separate read-only review against the spec, the
  criteria, the repository's rules and a security checklist; findings are
  fixed by the agent and can be saved as rules for later tasks.
- **Pull requests.** One per repository, cross-linked, with the criteria
  and their tests, every check and any open findings in the description.
  Without permission to create them, a prefilled link. **[needs attention]**
  marks a pull request whose checks still fail.
- **Open pull requests stay mergeable.** When the default branch changes
  and conflicts with an open pull request, Tandem merges it in, resolves the
  conflicts, runs every check and pushes, never with force. Branches
  someone else pushed to wait for a person, or for **Fix conflicts**.
- **Hosts and trackers.** AWS CodeCommit (any `aws login` or SSO profile,
  over HTTPS or SSH) and GitHub. Optional Jira Cloud or Data Center: import
  by key or query, spec and report comments, PM approval by reply, status
  transition.
- **Copilot model picker.** Every model your account offers, with prices in
  AI credits per million tokens, context size and an estimate per task;
  per chat and per task.
- **Copilot limits.** AI credits and prompts per task and per day, model
  calls per run. A run that reaches a limit stops at once and the task
  waits.
- **Shared dependencies.** Each repository is cloned once; installed
  dependencies are shared between tasks with the same lockfile through hard
  links. Tasks pause on low disk space instead of failing.
- **Resilience.** Every step is saved; a restart (or a crash) resumes each
  task where it was. Cancel removes the task folder and pushes nothing.
- **Doctor** in the app and as `pnpm tandem doctor`: tools, disk, keychain,
  Copilot sign-in and access (without using the budget), repositories, AWS,
  Jira.
- **Safety.** Read-only chat and spec work; build commands from an
  allowlist with a denylist that wins (no cloud CLIs, network tools, push,
  publish or deploy); writes only inside the task folder; pushes only to
  `agent/*` branches; never merges. Secrets only in the OS keychain;
  redacted logs and output. Loopback only, host and origin checks, a
  per-launch API token.
- **Web app.** Light and dark themes, custom components throughout,
  keyboard support and WCAG AA contrast checked with axe in both themes.
- **`pnpm tandem`** builds when the source changed, starts, opens the
  browser and runs the doctor on the first launch. Logs are kept 14 days.

[1.0.0]: https://github.com/Hedayat-Farahi786/Tandem/releases/tag/v1.0.0
