# Changelog

All notable changes to Tandem. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Hosted mode, first step.** `TANDEM_MODE=hosted` runs Tandem as a web
  app (see `docs/WEB_PLAN.md`):
  - **Sign-in:** "Continue with GitHub" through a GitHub App, with a state
    check. Each person's GitHub tokens are sealed with AES-256-GCM.
    Sessions use host-only, HttpOnly, Secure, SameSite=Lax cookies; only a
    hash of each session is stored, and each session has its own CSRF token
    for changes.
  - **Workspaces:** each has its own database and engine (a "cell"), reached
    only through the front server after a membership check. People can
    create workspaces and switch between them.
  - **Your data (GDPR):** export your account, or delete it. Deleting it
    removes the workspaces only you owned, with all their data.
  - **Security:** a sign-in page with no external requests; strict host and
    origin checks, HSTS, security headers and a CSP.
  - **Settings:** every address comes from the environment
    (`TANDEM_PUBLIC_URL` and the GitHub App credentials); none is in the code.

  The local app is unchanged: it now runs one cell.

- **Hosted mode, working end to end.**
  - **Teams:**
    - Owners invite people with a link that is valid for 7 days. Joining
      needs a GitHub sign-in first.
    - Each person is an owner or a member. Only owners rename, invite or
      delete the workspace, and a workspace always keeps at least one owner.
    - People leave, or owners remove them. Someone removed from their last
      workspace gets a new one of their own.
  - **Copilot on a member's plan:** a workspace runs Copilot and GitHub on the
    plan of the member who chose "Use my Copilot plan". Their GitHub token is
    renewed before it expires.
  - **Who did what:** approvals and the audit log name the member who acted.
    A PM approval says who recorded it.
  - **Only the workspace's own connections:**
    - Hosted workspaces never use the server's AWS profiles or credentials,
      its SSH keys or its folders.
    - Connections and tokens are sealed per workspace.
    - The repository importer links to installing the GitHub App.
  - **Settings › Workspace:** name, members, roles, invitations, leaving, and
    deleting the workspace.
  - **Legal pages:** the privacy policy, terms, DPA and subprocessors are
    served at `/legal/*`.
  - **Deployment:**
    - A `Dockerfile` with a health check, a non-root user and a data volume.
    - `docs/DEPLOYMENT.md` for the team that hosts it: the GitHub App, the
      settings, backups, build isolation and a go-live checklist.
    - Operator limits and default models (`TANDEM_MODEL`,
      `TANDEM_MAX_CONCURRENT_BUILDS`, budgets) apply to every workspace.
  - **Tested end to end** against a pretend GitHub, with the scripted agent
    and local copies of the CodeCommit sandbox repos.

- **The plan for Tandem as a web app, legal drafts and a website.**
  `docs/WEB_PLAN.md` sets out the agreed direction:
  - Tandem hosted in the EU (Frankfurt), with sign-in through a GitHub App.
    Each user's own Copilot plan is used through their token.
  - GitHub repositories through the app installation; CodeCommit through a
    role the customer creates in their own AWS account.
  - Isolated hosted runners, plus a company runner so code can stay on a
    company's own machines.
  - Postgres with per-workspace isolation and KMS encryption.
  - GDPR built in, and the order to build it in.

  `docs/legal/` has drafts for a lawyer to review: privacy policy, terms of
  service, data processing agreement, subprocessors and the record of
  processing. `apps/site/` is the landing page: static and no-tracking,
  working in light and dark mode and at phone width.

- **Add repositories without the command line.** The setup wizard now
  starts with Copilot, then shows four ways to add a repository:
  - **GitHub:** a searchable list of the repositories your connected
    GitHub account can work in. The Copilot sign-in also covers your
    repositories, so there is one sign-in for both.
  - **AWS CodeCommit:** a list per region, once AWS is connected.
  - **On this computer:** clones Tandem finds in your usual folders, or a
    folder you name. Tandem works in that clone with your own SSH key or
    git sign-in, without cloning it again or changing its settings, so
    company code stays where it already is.
  - **Clone URL:** paste one, as before.

  AWS is connected in the app (Settings › AWS or the CodeCommit tab):
  - Your company's IAM Identity Center sign-in: enter the access portal
    URL, approve a code in the browser, then choose the account and role.
    The access renews itself until your company's limit.
  - An access key (temporary `ASIA…` keys are refused).
  - A profile already on this computer.

  Tandem signs CodeCommit's git passwords itself and passes the connected
  GitHub account's token to git through its own credential helper. The
  AWS CLI and the GitHub CLI are no longer needed, and the helper's key is
  never given to the web page. Secrets stay in the system keychain. Error
  messages point to Settings instead of `aws sso login` or
  `gh auth login`. The API address of GitHub Enterprise Cloud
  (`api.<tenant>.ghe.com`) is now right.

- **Connect any Copilot account from the browser.** The setup wizard and
  Settings › Copilot now sign you in through Copilot's own GitHub sign-in:
  "GitHub.com" for a personal plan (Free, Pro, Pro+) or a Business or
  Enterprise seat on github.com, "Your company's GitHub" for GitHub
  Enterprise Cloud on its own address (it asks for `yourcompany.ghe.com`
  first), and Microsoft Entra where the runtime offers it. A dialog walks
  through approving in GitHub and comes back on its own. If the browser runs
  on another computer and can't reach the local return address, you paste
  that address and Tandem finishes the sign-in. On a computer without a
  browser, a fine-grained token (`github_pat_…`, Copilot Requests
  permission) works too; classic tokens are refused with an explanation.
  Settings shows the connected account and how it was connected (in the
  browser or with a token). Every other signed-in account can be made active
  with "Use this account", and you can add another account or sign out.
  The Copilot address follows the account, so there is no host field to fill
  in. Connecting happens only here: Tandem keeps its own sign-ins (in its
  data folder and the keychain), never uses a Copilot CLI or GitHub CLI
  login on the computer, and no environment variable connects an account
  (`COPILOT_GH_HOST` is gone). The sign-in stays in the system
  keychain: Tandem never sees a password, no route returns a token, and
  without a keychain the sign-in isn't saved in plain text. Changing the
  account waits until no task or chat is using Copilot. Each sign-in, switch
  and sign-out is in the audit log, and the doctor's fixes point to this
  screen.

- **A Projects page that reads like one.** Projects are cards in a grid:
  the name and task key, how specs get approved, three counts (in
  progress, in review, done), the repositories with their stack, role and
  build order, and a "New chat" shortcut. A "New project" card leads to
  setup. "Rules for Copilot" is its own section below, with the note
  about the repositories' own instruction files under it.

- **A review of the recent tasks, and what it fixed.**
  - *Copilot can run your tests while it builds.* In every recent task
    Copilot tried to run the repo's tests and was blocked. The workspace
    holds one folder per repo, and the guard refused `cd <repo>`,
    `git -C <repo>`, `npm --prefix <repo>` and the `CHROME_BIN=…` the repo's
    own test command sets. Copilot wrote tests blind, which cost fix rounds,
    and one task merged tests that fail. Now commands may run in a folder
    inside the workspace (never outside it, never with `..`), and Copilot
    may set the same variables your repo commands set. The prompts say how
    to run each check, and the reviewer is told where each repo's files are.
  - *Short commit and pull request titles, without the task number.*
    Copilot names its change when it finishes ("Bump version to 1.7.13",
    at most 50 characters). The pushed commit and the pull request take
    that title, with a few lines on what changed. Without a name, the task
    title in sentence case is used.
  - *Changes stay visible after the merge.* A merged task's Changes tab was
    empty: once the branch is part of the default branch, comparing the two
    shows nothing. Tandem now records where each branch starts when it
    pushes, and finds the start of older tasks from their merge or their
    commits.
  - *Faster version bumps.* The project's own version number no longer
    counts toward the dependency cache, so a version bump reuses the
    installed dependencies.
  - *No more failed rebases over files a formatter left behind.* Before a
    rebase, changes to tracked files are kept first.
  - *Tandem's instructions stay private.* The task conversation and the
    activity API no longer include the prompt Tandem sends Copilot; the
    Trace still shows its fingerprint.
  - *A cleaner conversation.* Routine stage changes are left out (the bar
    shows them); stops, resumes and the end remain. An approval appears
    after the spec it approves.
  - *A clearer sidebar.* "Open tasks" lists the project's tasks still in
    progress, each with a status dot and its status in words, separate from
    "Chats". Chat rows have no task icons, and the list scrolls without a
    visible bar.
  - *The model picker is always fully visible.* It opens on top of the page,
    anchored to its button and kept inside the window, instead of being cut
    off by the sidebar.
  - *The page never scrolls into empty space.* Hidden screen-reader text
    deep in a long diff or spec made the whole page taller than the window.
    Scroll areas now hold everything they contain.
  - "Ready, and about 1 lines" now reads "Ready: a small, reviewable change
    (about 1 line)".

- **See every stage of a task while it runs.** Under the task's title, one
  quiet line and a thin bar show where the task is: the stage, what is
  happening now and for how long ("Build · Copilot coding 4m 02s", "Checks ·
  Running tests", "Approval · Waiting for you"), and "4 of 8". Click it to
  see every stage with its time and outcome ("4 of 5 passed · 1 already
  failing", "Approved by …"). The current stage lists its steps as done,
  running or next. The running step says what Copilot is doing, and each
  check is ticked off as it runs. The self-review shows its fix and
  re-check, and a blocked or failed task shows why at the stage where it
  stopped. In the conversation, what Copilot says between its steps now
  appears in order with those steps, and its closing message comes last as
  its answer. A fix run after the self-review is called "Fixed review
  findings". The line that shows what Tandem is doing uses the same words as
  the bar. Run cards hide the model name, then the credits, before cutting
  their titles short, and the task composer's hints fit on one line.

- **Branches and commits that look like a person's.** A task's branch is
  now `feature/<key>-<title>` instead of `agent/…`, and before it is pushed
  its commits (the build, each fix round, formatter passes) fold into one
  commit, `SHOP-12: Add a health endpoint`, with the goal as a
  short body. Later commits read plainly, for example "Merge branch
  'development' into …". Tasks not built yet take the new branch name on
  start; tasks already pushed keep theirs, so their pull requests keep
  working. The push guard still allows only Tandem's own task branches:
  `feature/<KEY>-…`, never someone's `feature/login`, and never a default
  branch.

- **A polish pass over every screen.** Chats are named from their first
  message at once (a request still takes Copilot's short name for the change
  unless you renamed it), so a chat whose first message went unanswered no
  longer sits in Recents as "New request"; existing ones are named on start.
  The task list says why a task failed in plain words ("AWS sign-in
  expired"), lines its columns up, and no longer marks cancelled tasks as
  needing attention. Once a request becomes a task, its spec panel says so
  and offers Open task instead of two disabled buttons. In a task: the
  requirement's example data, affected areas and out of scope read full
  width; tracker comments show as one line; check cards say "All 5 commands
  passed" or "4 of 5 passed · 1 already failing"; the pull request's status
  sits with its repository; file paths keep their file name when space runs
  short; review findings read "1 open" or "All resolved"; the spec toolbar
  fits on one line, and while a spec awaits approval, Approve comes before
  the spec on a narrow panel (with "Your approval is all it needs" when no PM
  approval is required). Criteria in the requirement editor are one growing
  line per Given, When and Then. Settings shows locked fields as read-only,
  aligns every row, explains the prompt limits and adds the 30-day cost. A
  task waiting for review no longer looks updated "just now" after a restart.
- **The plan for Tandem as a web app, legal drafts and a website.**
  `docs/WEB_PLAN.md` sets out the agreed direction:
  - Tandem hosted in the EU (Frankfurt), with sign-in through a GitHub App.
    Each user's own Copilot plan is used through their token.
  - GitHub repositories through the app installation; CodeCommit through a
    role the customer creates in their own AWS account.
  - Isolated hosted runners, plus a company runner so code can stay on a
    company's own machines.
  - Postgres with per-workspace isolation and KMS encryption.
  - GDPR built in, and the order to build it in.

  `docs/legal/` has drafts for a lawyer to review: privacy policy, terms of
  service, data processing agreement, subprocessors and the record of
  processing. `apps/site/` is the landing page: static and no-tracking,
  working in light and dark mode and at phone width.

- **Add repositories without the command line.** The setup wizard now
  starts with Copilot, then shows four ways to add a repository:
  - **GitHub:** a searchable list of the repositories your connected
    GitHub account can work in. The Copilot sign-in also covers your
    repositories, so there is one sign-in for both.
  - **AWS CodeCommit:** a list per region, once AWS is connected.
  - **On this computer:** clones Tandem finds in your usual folders, or a
    folder you name. Tandem works in that clone with your own SSH key or
    git sign-in, without cloning it again or changing its settings, so
    company code stays where it already is.
  - **Clone URL:** paste one, as before.

  AWS is connected in the app (Settings › AWS or the CodeCommit tab):
  - Your company's IAM Identity Center sign-in: enter the access portal
    URL, approve a code in the browser, then choose the account and role.
    The access renews itself until your company's limit.
  - An access key (temporary `ASIA…` keys are refused).
  - A profile already on this computer.

  Tandem signs CodeCommit's git passwords itself and passes the connected
  GitHub account's token to git through its own credential helper. The
  AWS CLI and the GitHub CLI are no longer needed, and the helper's key is
  never given to the web page. Secrets stay in the system keychain. Error
  messages point to Settings instead of `aws sso login` or
  `gh auth login`. The API address of GitHub Enterprise Cloud
  (`api.<tenant>.ghe.com`) is now right.

- **Connect any Copilot account from the browser.** The setup wizard and
  Settings › Copilot now sign you in through Copilot's own GitHub sign-in:
  "GitHub.com" for a personal plan (Free, Pro, Pro+) or a Business or
  Enterprise seat on github.com, "Your company's GitHub" for GitHub
  Enterprise Cloud on its own address (it asks for `yourcompany.ghe.com`
  first), and Microsoft Entra where the runtime offers it. A dialog walks
  through approving in GitHub and comes back on its own. If the browser runs
  on another computer and can't reach the local return address, you paste
  that address and Tandem finishes the sign-in. On a computer without a
  browser, a fine-grained token (`github_pat_…`, Copilot Requests
  permission) works too; classic tokens are refused with an explanation.
  Settings shows the connected account and how it was connected (in the
  browser or with a token). Every other signed-in account can be made active
  with "Use this account", and you can add another account or sign out.
  The Copilot address follows the account, so there is no host field to fill
  in. Connecting happens only here: Tandem keeps its own sign-ins (in its
  data folder and the keychain), never uses a Copilot CLI or GitHub CLI
  login on the computer, and no environment variable connects an account
  (`COPILOT_GH_HOST` is gone). The sign-in stays in the system
  keychain: Tandem never sees a password, no route returns a token, and
  without a keychain the sign-in isn't saved in plain text. Changing the
  account waits until no task or chat is using Copilot. Each sign-in, switch
  and sign-out is in the audit log, and the doctor's fixes point to this
  screen.

- **A Projects page that reads like one.** Projects are cards in a grid:
  the name and task key, how specs get approved, three counts (in
  progress, in review, done), the repositories with their stack, role and
  build order, and a "New chat" shortcut. A "New project" card leads to
  setup. "Rules for Copilot" is its own section below, with the note
  about the repositories' own instruction files under it.

- **A review of the recent tasks, and what it fixed.**
  - *Copilot can run your tests while it builds.* In every recent task
    Copilot tried to run the repo's tests and was blocked. The workspace
    holds one folder per repo, and the guard refused `cd <repo>`,
    `git -C <repo>`, `npm --prefix <repo>` and the `CHROME_BIN=…` the repo's
    own test command sets. Copilot wrote tests blind, which cost fix rounds,
    and one task merged tests that fail. Now commands may run in a folder
    inside the workspace (never outside it, never with `..`), and Copilot
    may set the same variables your repo commands set. The prompts say how
    to run each check, and the reviewer is told where each repo's files are.
  - *Short commit and pull request titles, without the task number.*
    Copilot names its change when it finishes ("Bump version to 1.7.13",
    at most 50 characters). The pushed commit and the pull request take
    that title, with a few lines on what changed. Without a name, the task
    title in sentence case is used.
  - *Changes stay visible after the merge.* A merged task's Changes tab was
    empty: once the branch is part of the default branch, comparing the two
    shows nothing. Tandem now records where each branch starts when it
    pushes, and finds the start of older tasks from their merge or their
    commits.
  - *Faster version bumps.* The project's own version number no longer
    counts toward the dependency cache, so a version bump reuses the
    installed dependencies.
  - *No more failed rebases over files a formatter left behind.* Before a
    rebase, changes to tracked files are kept first.
  - *Tandem's instructions stay private.* The task conversation and the
    activity API no longer include the prompt Tandem sends Copilot; the
    Trace still shows its fingerprint.
  - *A cleaner conversation.* Routine stage changes are left out (the bar
    shows them); stops, resumes and the end remain. An approval appears
    after the spec it approves.
  - *A clearer sidebar.* "Open tasks" lists the project's tasks still in
    progress, each with a status dot and its status in words, separate from
    "Chats". Chat rows have no task icons, and the list scrolls without a
    visible bar.
  - *The model picker is always fully visible.* It opens on top of the page,
    anchored to its button and kept inside the window, instead of being cut
    off by the sidebar.
  - *The page never scrolls into empty space.* Hidden screen-reader text
    deep in a long diff or spec made the whole page taller than the window.
    Scroll areas now hold everything they contain.
  - "Ready, and about 1 lines" now reads "Ready: a small, reviewable change
    (about 1 line)".

- **See every stage of a task while it runs.** Under the task's title, one
  quiet line and a thin bar show where the task is: the stage, what is
  happening now and for how long ("Build · Copilot coding 4m 02s", "Checks ·
  Running tests", "Approval · Waiting for you"), and "4 of 8". Click it to
  see every stage with its time and outcome ("4 of 5 passed · 1 already
  failing", "Approved by …"). The current stage lists its steps as done,
  running or next. The running step says what Copilot is doing, and each
  check is ticked off as it runs. The self-review shows its fix and
  re-check, and a blocked or failed task shows why at the stage where it
  stopped. In the conversation, what Copilot says between its steps now
  appears in order with those steps, and its closing message comes last as
  its answer. A fix run after the self-review is called "Fixed review
  findings". The line that shows what Tandem is doing uses the same words as
  the bar. Run cards hide the model name, then the credits, before cutting
  their titles short, and the task composer's hints fit on one line.

- **Branches and commits that look like a person's.** A task's branch is
  now `feature/<key>-<title>` instead of `agent/…`, and before it is pushed
  its commits (the build, each fix round, formatter passes) fold into one
  commit, `SHOP-12: Add a health endpoint`, with the goal as a
  short body. Later commits read plainly, for example "Merge branch
  'development' into …". Tasks not built yet take the new branch name on
  start; tasks already pushed keep theirs, so their pull requests keep
  working. The push guard still allows only Tandem's own task branches:
  `feature/<KEY>-…`, never someone's `feature/login`, and never a default
  branch.

- **A polish pass over every screen.** Chats are named from their first
  message at once (a request still takes Copilot's short name for the change
  unless you renamed it), so a chat whose first message went unanswered no
  longer sits in Recents as "New request"; existing ones are named on start.
  The task list says why a task failed in plain words ("AWS sign-in
  expired"), lines its columns up, and no longer marks cancelled tasks as
  needing attention. Once a request becomes a task, its spec panel says so
  and offers Open task instead of two disabled buttons. In a task: the
  requirement's example data, affected areas and out of scope read full
  width; tracker comments show as one line; check cards say "All 5 commands
  passed" or "4 of 5 passed · 1 already failing"; the pull request's status
  sits with its repository; file paths keep their file name when space runs
  short; review findings read "1 open" or "All resolved"; the spec toolbar
  fits on one line, and while a spec awaits approval, Approve comes before
  the spec on a narrow panel (with "Your approval is all it needs" when no PM
  approval is required). Criteria in the requirement editor are one growing
  line per Given, When and Then. Settings shows locked fields as read-only,
  aligns every row, explains the prompt limits and adds the 30-day cost. A
  task waiting for review no longer looks updated "just now" after a restart.
- **Copilot limits are yours to change in Settings.** The AI credit and
  prompt limits are no longer locked by `TANDEM_CREDITS_*` /
  `TANDEM_BUDGET_*`: those only seed a new install, and Settings decides from
  then on (a restart keeps your change). Settings shows each limit in
  dollars, and an ⓘ next to AI credits (Settings, a task's credit meter, the
  "Copilot limit reached" banner, the trace and the activity) explains what
  a credit is, its price (1 credit = $0.01), what uses credits and what is
  free, with today's use, your limits and a link to change them.
- **A request is created once, from a finished spec.** "Create and start"
  waits until Copilot has nothing left to ask and has written the full spec
  in the request chat (in the same session, from the code it already read).
  Creating the task adopts that spec as version 1 and approves it, so the
  task no longer drafts the spec a second time: no extra Copilot run and no
  empty Spec tab. Copilot's run cards in a task show the project's avatar,
  a status mark, a present-tense title and a ticking timer while working,
  and one flat list of steps.
- **Rename, pin and delete chats.** Every conversation in Recents, and the
  open chat's title, has a menu: Pin to top, Rename (or double-click the
  name), Open the task, and Delete. Delete asks first, says the task made
  from the chat stays as it is, and is recorded in the audit log; it waits
  while Copilot is still answering.
- **The task page reads cleanly when something stops.** The reason is said
  once, in the card at the bottom of the conversation, and an expired AWS
  sign-in says so in plain words ("Sign-in expired … sign in again, then
  Retry"). In Checks and the trace, criteria whose tests you skipped read
  "Skipped", not "Pending", and each test shows its name with the file
  underneath instead of a wrapped path.
- **An open pull request no longer fails its task** when Tandem can't
  reach the host to check it (an expired AWS sign-in, the network). The task
  stays open with a plain note in the conversation, Tandem tries again every
  few minutes, and the note clears once it works. The task conversation
  says each problem once (the card and the timeline; Tandem's repeated
  "I need your help" notes are left out of view), and failure reasons read
  in plain words ("Checking the pull requests failed: …").
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
