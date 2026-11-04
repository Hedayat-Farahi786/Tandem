# Changelog

All notable changes to Tandem. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Traceability.** An append-only audit log in which every entry is sealed
  with a SHA-256 hash chain: state changes, approvals, spec edits, commits
  pushed, pull requests, and every change to settings, tokens (name only),
  repositories, projects and rules, with who made it. Changing or removing
  an entry is detected.
- **Task › Activity**: what Copilot did on the task, step by step and live:
  the instructions it got, its thinking, the files it read and edited, the
  commands it ran with their output, what Tandem blocked, and its answers,
  with the model, time and credits of each step.
- **Getting stuck tasks moving**: when a task is blocked, fails or its pull
  request needs attention, Tandem asks for help in the task chat. Answer
  under the message or in the chat with **Continue with this**, or let
  Copilot propose a way forward to confirm. The guidance goes with every
  later Copilot step; a pull request that needs attention gets another round
  of fixes and is updated when checks pass.
- **Chat like a chat app**: while Copilot works, a live card shows what it is
  doing now in plain words ("Reading app.routes.ts"), a timer and its latest
  steps; afterwards they fold into one line ("Worked for 25s · read 10 files ·
  9 searches") that opens into a grouped timeline with Copilot's thinking. The
  view follows new content while you are at the bottom, glides down when you
  send, and offers a "jump to latest" button when you scroll up; answers have
  a copy action; a slim title bar and a centred column.
- **Settings › Audit log**: verification of the audit log, its head hash, and
  CSV or JSON export of everything recorded.
- **Task › Trace**: request → criteria and their tests → spec versions and
  approvals → Copilot runs → checks and review → commits and pull requests
  → audit entries, with a Markdown report to download.
- **Search** (Ctrl K / ⌘K) for pages, tasks and projects.
- **Rules for Copilot** in plain words, with examples to start from, a
  choice of repository (or all of them), and removal before a task saves a
  rule to the repository.
- **Tasks** as one list, most recent first, with All / Needs you / In
  progress / Done filters.
- A project switcher at the top of the sidebar and a count of tasks that
  need you next to Tasks.
- **Project icons**: each project shows its website's real favicon, read
  from its repository (sandboxed), in its own colours, or its initials
  when there is none.
- **Logos** for the services and model makers Tandem works with: GitHub,
  GitHub Copilot, AWS, Jira, and Anthropic, OpenAI, Google, xAI, Mistral,
  Meta and Microsoft in the model menu. Bundled with the app; see THIRD_PARTY_NOTICES.md.
- **Language and framework logos** next to each repository (TypeScript,
  React, Fastify, Next.js, Python and about 50 more).
- Everything clickable shows the pointer cursor.

### Changed

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
