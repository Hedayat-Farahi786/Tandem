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
- **Activity** page: everything people, Copilot and Tandem did, by day, with
  filters, details, audit verification, and CSV or JSON export.
- **Task › Trace**: request → criteria and their tests → spec versions and
  approvals → Copilot runs → checks and review → commits and pull requests
  → audit entries, with a Markdown report to download.
- **Search** (Ctrl K / ⌘K) for pages, tasks and projects.
- A project switcher at the top of the sidebar and a count of tasks that
  need you next to Tasks.
- **Project icons**: each project shows its website's real favicon, read
  from its repository (sandboxed), in its own colours, or its initials
  when there is none.
- **Logos** for the services and model makers Tandem works with: GitHub,
  GitHub Copilot, AWS, Jira, and Anthropic, OpenAI, Google, xAI, Mistral and
  Meta in the model menu. Bundled with the app; see THIRD_PARTY_NOTICES.md.

### Changed

- A new visual design: a neutral palette, Inter display headings, pages on
  a raised panel, grouped settings cards, a step indicator and icon
  timeline on tasks, richer empty states, and a "how it works" line on the
  chat start page. Contrast still passes axe (WCAG AA) in light and dark.

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
