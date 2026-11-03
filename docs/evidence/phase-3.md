# Phase 3 evidence: web UI

Run on the owner's machine (Ubuntu 20.04, Node 22.23.1, git 2.25.1, Chromium 153 headless).
No Copilot prompts were used: the UI runs against the real server in test mode with the
scripted agent, local bare git remotes standing in for CodeCommit, and the PR API answering
"access denied" so the console-link fallback is exercised.

## Results

| Check | Result |
| --- | --- |
| `pnpm check` (build incl. web, type-check incl. tests and web, lint, all tests with coverage) | exit 0 |
| Vitest: unit, web (jsdom) and integration | 22 files, 246 tests passed (2 real-CodeCommit tests skipped without `TANDEM_REAL=1`) |
| Playwright smoke (`pnpm test:e2e`) | 9/9 passed, 1.4 min |
| axe-core, WCAG 2.0/2.1 A and AA | 0 violations on 20 screens × light and dark |
| Line coverage | core 97.8 % (gate 85 %), adapters 84.3 %, server 69.9 %, web 70.5 %, all 84.1 % |

## What is tested

- **Server API** (`apps/server/src/__tests__/app.test.ts`, `fastify.inject`): Host must be
  `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise: DNS rebinding); a foreign `Origin` is
  refused; every write needs the per-launch token; hardening headers; the web app is served with
  the token injected, a strict CSP and history fallback; plain 404s; settings validation; tokens
  stored only in the secret store and never echoed; repository URL checks and duplicates; a
  repository in use can't be deleted; project validation; task create, detail, patch, cancel;
  domain errors mapped to plain messages; SSE replay buffer.
- **Server end to end over HTTP** (`server.it.test.ts`): first-launch doctor; setup through the
  API; a task from readiness to a console-link PR with both approvals; spec export as Markdown
  and PDF; the diff; the branch pushed to the remote; every transition streamed over SSE.
- **Web components** (Testing Library, jsdom): every screen and its loading, empty, error and
  blocked states. Task detail: review and both approvals, open questions blocking approval,
  request changes, not-ready (edit requirement, then re-check), split proposal (accept, or keep
  with a reason), failed (retry), cancel with confirmation, the manual PR flow, criteria → tests →
  results, verification output, a finding turned into a rule, load errors. Chat: start, streamed
  reply with file references, readiness gating, create task. Tasks list filters and the new-task
  form with live readiness. Settings save bar, discard, number fields, missing keychain. Doctor
  summaries. Projects and rules. Setup detect, error and add. Kit: the select (keyboard,
  disabled options, type-ahead, Escape), tabs (arrow keys), and the diff parser.
- **Browser smoke** (`e2e/web/smoke.spec.ts`): one story in order on the real server and built UI:
  setup wizard → chat request → task → spec review → owner and PM approval → build, verify and
  self-review by the scripted agent (the sandbox's real `npm ci`, lint, type-check, build and
  tests run) → console-link PR (URL checked) → paste the PR link → mark merged → task done. Then
  Tasks, the new-task dialog, Projects, Settings (save bar) and Doctor. Keyboard pass: skip link,
  select by keyboard with Escape returning focus, theme toggle persisted across reload. Every
  screen is checked with axe in both themes and the console must stay free of errors.

## Problems found and fixed in this phase

1. **Chat crashed in Chromium 153**: `scrollIntoView()` now returns a Promise; an effect with an
   expression body handed it to React as a "cleanup" (`destroy is not a function`). Effects now
   use block bodies.
2. **PATCH on a task cleared fields it didn't name**: Zod 4 applies defaults inside `.partial()`.
   The route now keeps only the fields the client sent (with a test).
3. **Number fields snapped to their minimum when cleared**, so typing "8" gave "18". They now
   keep the typed text, show an error while invalid and restore the last value on blur.
4. **Contrast**: the faint text colour was 3.0–3.6:1. Muted and faint text now reach at least
   4.57:1 on every surface in both themes.
5. **Accessibility markup**: "Optional" was part of field labels; a definition list contained
   bare `div`s; links wrapped buttons (nested interactive elements); the project filter had an
   empty label; the custom select put `aria-activedescendant` on an unfocused list (now the
   APG select-only combobox pattern, and Escape no longer closes a surrounding dialog).
6. **Dialogs focused the close button** (its tooltip popped up clipped); they now start on the
   first field, or on the safe footer button for confirmations.
7. **Thread titles**: the conversation list didn't refresh after a turn, and Ask threads stayed
   "Question"; they now take the first question as their title.
8. **Retries**: 4xx answers were retried before the error showed; only network and 5xx errors are
   retried now.
9. A task reaching spec review while open stayed on Overview; the banner now has "Read the spec".
   Doctor's summary no longer shows a warning tone with "Everything required passes" (it counts
   warnings), and the setup check shows the same summary. Toasts are shorter-lived; Settings'
   save bar only appears with unsaved changes; verification output is grouped per repository;
   criteria show "Pending" until verification has run.

## Running it

```sh
pnpm build
npx playwright install chromium        # or PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome
pnpm test:e2e                          # TANDEM_SCREENSHOTS=1 also writes the images below
```

## Screens

| Screen | Light | Dark |
| --- | --- | --- |
| Setup: welcome | ![Setup: welcome, light](phase-3/01-setup-welcome-light.jpg) | ![Setup: welcome, dark](phase-3/01-setup-welcome-dark.jpg) |
| Setup: detected repository to confirm | ![Setup: detected repository to confirm, light](phase-3/02-setup-repository-light.jpg) | ![Setup: detected repository to confirm, dark](phase-3/02-setup-repository-dark.jpg) |
| Setup: project and PM gate | ![Setup: project and PM gate, light](phase-3/03-setup-project-light.jpg) | ![Setup: project and PM gate, dark](phase-3/03-setup-project-dark.jpg) |
| Setup: Copilot and AWS | ![Setup: Copilot and AWS, light](phase-3/04-setup-connect-light.jpg) | ![Setup: Copilot and AWS, dark](phase-3/04-setup-connect-dark.jpg) |
| Setup: doctor check | ![Setup: doctor check, light](phase-3/05-setup-check-light.jpg) | ![Setup: doctor check, dark](phase-3/05-setup-check-dark.jpg) |
| Chat: start (Request or Ask) | ![Chat: start (Request or Ask), light](phase-3/06-chat-start-light.jpg) | ![Chat: start (Request or Ask), dark](phase-3/06-chat-start-dark.jpg) |
| Chat: request meets the Definition of Ready | ![Chat: request meets the Definition of Ready, light](phase-3/07-chat-ready-light.jpg) | ![Chat: request meets the Definition of Ready, dark](phase-3/07-chat-ready-dark.jpg) |
| Task: review needed | ![Task: review needed, light](phase-3/08-task-review-light.jpg) | ![Task: review needed, dark](phase-3/08-task-review-dark.jpg) |
| Task: spec and approvals | ![Task: spec and approvals, light](phase-3/09-task-spec-light.jpg) | ![Task: spec and approvals, dark](phase-3/09-task-spec-dark.jpg) |
| Task: record PM approval | ![Task: record PM approval, light](phase-3/10-task-pm-dialog-light.jpg) | ![Task: record PM approval, dark](phase-3/10-task-pm-dialog-dark.jpg) |
| Task: console-link pull request | ![Task: console-link pull request, light](phase-3/11-task-prs-light.jpg) | ![Task: console-link pull request, dark](phase-3/11-task-prs-dark.jpg) |
| Task: criteria, verification, self-review | ![Task: criteria, verification, self-review, light](phase-3/12-task-checks-light.jpg) | ![Task: criteria, verification, self-review, dark](phase-3/12-task-checks-dark.jpg) |
| Task: diff | ![Task: diff, light](phase-3/13-task-changes-light.jpg) | ![Task: diff, dark](phase-3/13-task-changes-dark.jpg) |
| Task: overview and timeline | ![Task: overview and timeline, light](phase-3/14-task-overview-light.jpg) | ![Task: overview and timeline, dark](phase-3/14-task-overview-dark.jpg) |
| Task: task chat | ![Task: task chat, light](phase-3/15-task-chat-light.jpg) | ![Task: task chat, dark](phase-3/15-task-chat-dark.jpg) |
| Tasks list | ![Tasks list, light](phase-3/16-tasks-light.jpg) | ![Tasks list, dark](phase-3/16-tasks-dark.jpg) |
| Tasks: new task form | ![Tasks: new task form, light](phase-3/17-tasks-new-light.jpg) | ![Tasks: new task form, dark](phase-3/17-tasks-new-dark.jpg) |
| Projects and learned rules | ![Projects and learned rules, light](phase-3/18-projects-light.jpg) | ![Projects and learned rules, dark](phase-3/18-projects-dark.jpg) |
| Settings with unsaved changes | ![Settings with unsaved changes, light](phase-3/19-settings-light.jpg) | ![Settings with unsaved changes, dark](phase-3/19-settings-dark.jpg) |
| Doctor | ![Doctor, light](phase-3/20-doctor-light.jpg) | ![Doctor, dark](phase-3/20-doctor-dark.jpg) |
