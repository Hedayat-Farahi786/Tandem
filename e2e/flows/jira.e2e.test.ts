/**
 * Jira flows, end to end: import an issue, draft the spec, post it to the issue, and take the
 * PM's "approve" reply from Jira. Skipped unless TANDEM_E2E_JIRA=1, because it needs a Jira Cloud
 * site and an OS keychain for the token (see docs/ENABLE_JIRA.md):
 *
 *   TANDEM_E2E_JIRA=1 TANDEM_E2E_JIRA_URL=https://<site>.atlassian.net TANDEM_E2E_JIRA_EMAIL=<email> \
 *   TANDEM_E2E_JIRA_TOKEN=<api token> TANDEM_E2E_JIRA_ISSUE=<KEY-1> pnpm test:flows e2e/flows/jira.e2e.test.ts
 *
 * The test account posts the "approve" reply itself, so it is also the project's PM. It comments on
 * the issue and leaves the comments; it never changes the issue's status (the task is cancelled
 * before its PRs open).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './harness.js';

const ON = process.env.TANDEM_E2E_JIRA === '1';
const URL = (process.env.TANDEM_E2E_JIRA_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.TANDEM_E2E_JIRA_EMAIL ?? '';
const TOKEN = process.env.TANDEM_E2E_JIRA_TOKEN ?? '';
const ISSUE = process.env.TANDEM_E2E_JIRA_ISSUE ?? '';

const jira = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Jira ${method} ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
};
const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

describe.skipIf(!ON)('Jira flows (real Jira, scripted agent)', () => {
  const h = new Harness();
  let projectId = '';
  let accountId = '';

  beforeAll(async () => {
    if (!URL || !EMAIL || !TOKEN || !ISSUE) throw new Error('Set TANDEM_E2E_JIRA_URL, _EMAIL, _TOKEN and _ISSUE.');
    accountId = (await jira<{ accountId: string }>('GET', '/rest/api/3/myself')).accountId;
    await h.prepareRemotes(['fullstack']);
    await h.start();
    const settings = await h.api<{ jira: Record<string, unknown> }>('GET', '/api/settings');
    await h.api('PUT', '/api/settings', { ...settings, jira: { ...settings.jira, pollIntervalMin: 1 } });
    // As a person would: Settings › Jira › Connect Jira, with a token.
    await h.api('POST', '/api/jira/token', { site: URL, email: EMAIL, token: TOKEN });
    const repo = await h.addRepo('fullstack');
    const project = await h.api<{ id: string }>('POST', '/api/projects', { name: 'Jira shop', repoIds: [repo.id], pmGate: 'jira', jiraPmAccountIds: [accountId], jiraProjectKey: ISSUE.split('-')[0], keyPrefix: 'JSHOP' });
    projectId = project.id;
  }, 300_000);

  afterAll(async () => {
    await h.api('DELETE', '/api/jira').catch(() => undefined);
    await h.stop();
    h.cleanup();
  });

  it('imports an issue, posts the spec to it, and builds after the PM replies "approve"', async () => {
    const r = await h.api<{ imported: Array<{ id: string; key: string }> }>('POST', `/api/projects/${projectId}/import`, { keys: [ISSUE] });
    expect(r.imported).toHaveLength(1);
    const id = r.imported[0]!.id;
    let d = await h.waitFor(id, 'spec review', (x) => x.task.state === 'SPEC_REVIEW' && Boolean(x.spec));
    expect(d.task.source).toBe('jira');

    const comments = await jira<{ comments: Array<{ id: string; body: unknown }> }>('GET', `/rest/api/3/issue/${ISSUE}/comment?orderBy=-created&maxResults=5`);
    expect(JSON.stringify(comments.comments[0]?.body)).toContain('Reply "approve"');

    await h.api('POST', `/api/tasks/${id}/approve`, {});
    await jira('POST', `/rest/api/3/issue/${ISSUE}/comment`, { body: adf('approve') });
    d = await h.waitFor(id, 'the PM approval from Jira', (x) => ['BUILDING', 'VERIFYING'].includes(x.task.state), { ms: 240_000 });
    expect(d.approvalState).toMatchObject({ pm: { role: 'pm' }, complete: true });
    await h.api('POST', `/api/tasks/${id}/cancel`, {});
  });

  it('importing the same issue again creates nothing', async () => {
    const r = await h.api<{ imported: Array<{ id: string }> }>('POST', `/api/projects/${projectId}/import`, { keys: [ISSUE] });
    expect(r.imported).toHaveLength(0);
  });
});
