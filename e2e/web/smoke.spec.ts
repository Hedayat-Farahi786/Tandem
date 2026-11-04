import { expect, test, type Page } from '@playwright/test';
import { checkScreen, watchErrors } from './helpers.js';

/*
 * One story, in order, against one server: set up a project, turn a chat request into a task,
 * approve the spec, let the scripted agent build it, and follow the PR. Each screen is checked
 * for accessibility in light and dark mode on the way.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  errors = watchErrors(page);
});
test.afterAll(async () => {
  await page.context().close();
});
test.afterEach(() => {
  expect(errors, 'Errors in the browser console').toEqual([]);
});

test('first launch opens the setup wizard', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up Tandem' })).toBeVisible();
  await checkScreen(page, '01-setup-welcome');
});

test('setup: detect and add a repository', async () => {
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByLabel('Clone URL').fill('not a url');
  await page.getByRole('button', { name: 'Detect' }).click();
  await expect(page.getByText('That is not a CodeCommit or GitHub URL', { exact: false })).toBeVisible();
  await page.getByLabel('Clone URL').fill('codecommit::eu-central-1://tandem-sandbox-fullstack');
  await page.getByRole('button', { name: 'Detect' }).click();
  await expect(page.getByText('Confirm tandem-sandbox-fullstack')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Default branch')).toHaveValue('main');
  await expect(page.getByLabel('Test', { exact: true })).toHaveValue('npm test');
  await checkScreen(page, '02-setup-repository', { fullPage: true });
  await page.getByRole('button', { name: 'Add repository' }).click();
  await expect(page.getByText('Added (1)')).toBeVisible();
});

test('setup: project, connections and check', async () => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Project name').fill('Shop');
  await checkScreen(page, '03-setup-project', { fullPage: true });
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Your name').fill('Sam');
  await checkScreen(page, '04-setup-connect');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Run doctor' }).click();
  await expect(page.getByText(/Everything (required )?passes|need attention/)).toBeVisible({ timeout: 90_000 });
  await checkScreen(page, '05-setup-check', { fullPage: true });
  await page.getByRole('button', { name: 'Finish and open chat' }).click();
  await expect(page).toHaveURL(/\/chat/);
});

test('chat: a request becomes a ready task', async () => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await checkScreen(page, '06-chat-start');
  // Pick the model: prices and details, keyboard first.
  const picker = page.getByRole('combobox', { name: 'Model: Auto' });
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  const list = page.getByRole('listbox', { name: 'Copilot model' });
  await expect(list).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByText('AI credits per million tokens')).toBeVisible();
  await checkScreen(page, '06b-chat-model');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Model: Scripted Swift' })).toBeFocused();
  await page.getByLabel('Describe your request').fill('Add a GET /health endpoint returning {status: "ok"} and show the status on the main page.');
  await page.keyboard.press('Enter');
  // Copilot asks its questions as choices, one at a time; keys pick, Enter goes on.
  const card = page.getByRole('region', { name: 'Copilot needs you' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  const draft = page.getByRole('complementary', { name: 'Task draft' });
  await expect(draft.getByRole('button', { name: 'Create and start' })).toBeDisabled();
  await checkScreen(page, '06c-chat-question');
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(card.getByText('What should this change leave out for now?')).toBeVisible();
  await card.getByText('Authentication', { exact: true }).click();
  await card.getByText('Metrics', { exact: true }).click();
  await expect(card.getByRole('checkbox', { name: /Authentication/ })).toBeChecked();
  await expect(card.getByRole('checkbox', { name: /Metrics/ })).toBeChecked();
  await card.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByText('meets the Definition of Ready')).toBeVisible({ timeout: 60_000 });
  // Nothing left to ask: Copilot writes the full spec, and only then can the task be created.
  await expect(draft.getByText('Ready to create', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(draft.getByRole('heading', { name: 'Tests to add' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Conversations' }).getByText('Add a GET /health endpoint')).toBeVisible();
  await checkScreen(page, '07-chat-ready');
  await draft.getByRole('button', { name: 'Create and start' }).click();
  await expect(page).toHaveURL(/\/tasks\/[\w-]+$/);
});

test('task: the spec from the chat is approved by you; it waits only for the PM', async () => {
  // Creating the task from its chat approved the spec, so it isn't drafted again.
  await expect(page.getByText("Waiting for the PM's approval")).toBeVisible({ timeout: 90_000 });
  await checkScreen(page, '08-task-review');
  await page.getByRole('button', { name: 'Open the spec' }).click();
  await expect(page.getByRole('heading', { name: 'Problem and goal' })).toBeVisible();
  await expect(page.getByText(/Approved by creating and starting the task from the request chat/).first()).toBeVisible();
  await checkScreen(page, '09-task-spec');
  await page.getByRole('button', { name: 'Record PM approval' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record PM approval' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record approval' })).toBeDisabled();
  await dialog.getByLabel('PM name').fill('Pat Lee');
  await dialog.getByLabel('Evidence').fill('Approved in #shop-planning');
  await checkScreen(page, '10-task-pm-dialog');
  await dialog.getByRole('button', { name: 'Record approval' }).click();
  await expect(dialog).toBeHidden();
});

test('task: built, verified, reviewed, and a pull request to open', async () => {
  // The task opens as a conversation; its details open beside it.
  const panel = page.getByRole('complementary', { name: 'Task details' });
  const convo = page.getByRole('region', { name: 'Conversation' });
  await panel.getByRole('tab', { name: /Pull requests/ }).click();
  await expect(page.getByRole('link', { name: 'Open create page' })).toBeVisible({ timeout: 400_000 });
  const href = await page.getByRole('link', { name: 'Open create page' }).getAttribute('href');
  expect(href).toContain('console.aws.amazon.com/codesuite/codecommit/repositories/tandem-sandbox-fullstack/pull-requests/new/');
  await checkScreen(page, '11-task-prs');
  await panel.getByRole('tab', { name: /Checks/ }).click();
  await expect(panel.getByText('All checks pass')).toBeVisible();
  await expect(panel.getByRole('cell', { name: 'Pass' })).toHaveCount(2);
  await checkScreen(page, '12-task-checks', { fullPage: true });
  // The trace: request to PR, every Copilot run, decisions, exceptions and the verified audit log.
  await panel.getByRole('tab', { name: 'Trace' }).click();
  await expect(panel.getByRole('heading', { name: 'Copilot runs' })).toBeVisible();
  await expect(panel.getByText('Definition of Ready met')).toBeVisible();
  await checkScreen(page, '12b-task-trace');
  await panel.getByRole('tab', { name: 'Changes' }).click();
  await expect(panel.getByText(/\d+ files changed/)).toBeVisible({ timeout: 30_000 });
  await checkScreen(page, '13-task-changes');
  await panel.getByRole('tab', { name: 'Overview' }).click();
  // The task kept the model picked in chat, and shows its credits.
  await expect(panel.getByRole('combobox', { name: 'Model: Scripted Swift' })).toBeVisible();
  await expect(panel.getByRole('meter', { name: 'AI credits used by this task' })).toBeVisible();
  await checkScreen(page, '14-task-overview', { fullPage: true });
  // The conversation: the spec, checks and pull request in order, the composer at the end.
  await expect(convo.getByRole('button', { name: 'Open spec' })).toBeVisible();
  await expect(convo.getByRole('button', { name: 'View checks' }).first()).toBeVisible();
  await expect(convo.getByLabel('Message')).toBeVisible();
  await checkScreen(page, '15-task-chat');
});

test('task: paste the PR link, then mark it merged', async () => {
  const panel = page.getByRole('complementary', { name: 'Task details' });
  await panel.getByRole('tab', { name: /Pull requests/ }).click();
  await page.getByLabel('Link to the new pull request').fill('https://eu-central-1.console.aws.amazon.com/codesuite/codecommit/repositories/tandem-sandbox-fullstack/pull-requests/1/details');
  await page.getByRole('button', { name: 'Save link' }).click();
  await expect(page.getByRole('link', { name: 'Open pull request' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as merged' }).click();
  await expect(panel.getByText('Merged', { exact: true })).toBeVisible();
  // Every PR merged: the task finishes and can no longer be cancelled.
  await expect(page.getByRole('button', { name: 'Cancel task' })).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('[aria-current="step"]')).toHaveCount(0);
});

test('tasks, projects, settings and doctor screens', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.locator('#main').getByRole('link', { name: /Add a GET \/health endpoint/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Done\s*1$/ })).toBeVisible();
  await checkScreen(page, '16-tasks');
  await page.getByRole('button', { name: 'New task' }).click();
  await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
  await checkScreen(page, '17-tasks-new');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'New task' })).toBeHidden();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByText('tandem-sandbox-fullstack').first()).toBeVisible();
  await checkScreen(page, '18-projects');

  await page.getByRole('navigation', { name: 'Tandem' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Copilot budget' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeHidden();
  await page.getByLabel('Prompts per task').fill('12');
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeVisible();
  await checkScreen(page, '19-settings');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeHidden();

  await page.getByRole('navigation', { name: 'Tandem' }).getByRole('link', { name: 'Doctor' }).click();
  await page.getByRole('button', { name: 'Run checks' }).first().click();
  await expect(page.getByRole('button', { name: 'Running checks…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run checks' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/checks pass · last run just now/)).toBeVisible();
  await expect(page.getByText(/Everything (required )?passes|need attention/)).toBeVisible();
  await checkScreen(page, '20-doctor', { fullPage: true });
});

test('keyboard: skip link, custom select and theme toggle', async () => {
  await page.goto('/settings');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  const model = page.getByRole('combobox', { name: 'Model for chat, specs and reviews' });
  await model.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(model).toBeFocused();
  await page.getByRole('button', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Light mode' }).click();
});
