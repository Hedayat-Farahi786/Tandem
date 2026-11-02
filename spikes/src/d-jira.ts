/**
 * Spike d (Jira): written now, skipped until a token exists.
 *
 *   JIRA_BASE_URL=https://<site>.atlassian.net JIRA_EMAIL=<you@work> JIRA_API_TOKEN=<token> \
 *   JIRA_SPIKE_ISSUE=<KEY-1> pnpm spike:d-jira
 *
 * Jira Cloud uses email + API token (Basic). Data Center uses a personal access token
 * (Bearer): leave JIRA_EMAIL empty. The spike token is read from the environment only;
 * Tandem itself stores the token in the OS keychain.
 */
import { spikeEnv } from './lib/env.js';
import { Report, check } from './lib/report.js';

const env = spikeEnv();
const report = new Report('d-jira', 'Spike d (Jira): REST endpoints Tandem relies on');

/** Minimal Markdown-ish text to Atlassian Document Format (paragraphs only; the real adapter handles more). */
export function textToAdf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  };
}

if (!env.jiraBaseUrl || !env.jiraToken) {
  report.skip('All steps', 'Jira is not configured (optional). Set JIRA_BASE_URL, JIRA_API_TOKEN and, for Jira Cloud, JIRA_EMAIL.');
  await report.finish();
} else {
  const base = env.jiraBaseUrl.replace(/\/+$/, '');
  const cloud = Boolean(env.jiraEmail);
  const api = cloud ? '/rest/api/3' : '/rest/api/2';
  const auth = cloud ? `Basic ${Buffer.from(`${env.jiraEmail}:${env.jiraToken}`).toString('base64')}` : `Bearer ${env.jiraToken}`;
  report.fact('flavour', cloud ? 'Jira Cloud (REST v3, Basic)' : 'Jira Data Center (REST v2, Bearer PAT)');

  async function jira<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const me = await report.step('Authenticate (GET /myself)', async (ctx) => {
    const r = await jira<{ accountId?: string; name?: string; displayName: string }>('GET', `${api}/myself`);
    ctx.detail(`signed in as ${r.displayName}`);
    return r;
  });

  if (me) {
    await report.step(`Find ready tasks by JQL (${env.jiraJql})`, async (ctx) => {
      const r = cloud
        ? await jira<{ issues: Array<{ key: string }>; nextPageToken?: string }>('POST', `${api}/search/jql`, { jql: env.jiraJql, maxResults: 5, fields: ['summary', 'status'] })
        : await jira<{ issues: Array<{ key: string }> }>('POST', `${api}/search`, { jql: env.jiraJql, maxResults: 5, fields: ['summary', 'status'] });
      ctx.detail(`${r.issues.length} issue(s): ${r.issues.map((i) => i.key).join(', ') || 'none'}`);
      ctx.fact('search.endpoint', cloud ? 'POST /rest/api/3/search/jql' : 'POST /rest/api/2/search');
    });

    if (!env.jiraIssue) {
      report.skip('Issue steps', 'Set JIRA_SPIKE_ISSUE to a sandbox issue key to test get/comment/replies/transitions.');
    } else {
      const issueKey = env.jiraIssue;
      await report.step(`Get issue ${issueKey}`, async (ctx) => {
        const r = await jira<{ key: string; fields: { summary: string; status: { name: string } } }>('GET', `${api}/issue/${encodeURIComponent(issueKey)}?fields=summary,status,description`);
        ctx.detail(`${r.key}: ${r.fields.summary} [${r.fields.status.name}]`);
      });
      const posted = await report.step('Post a comment', async (ctx) => {
        const body = cloud ? { body: textToAdf('Tandem spike comment. Safe to delete.') } : { body: 'Tandem spike comment. Safe to delete.' };
        const r = await jira<{ id: string; created: string }>('POST', `${api}/issue/${encodeURIComponent(issueKey)}/comment`, body);
        ctx.detail(`comment ${r.id}`);
        return r;
      });
      await report.step('Read replies (comments ordered by created)', async (ctx) => {
        const r = await jira<{ comments: Array<{ id: string; author: { accountId?: string; name?: string }; created: string }> }>(
          'GET',
          `${api}/issue/${encodeURIComponent(issueKey)}/comment?orderBy=created&maxResults=50`,
        );
        check(posted && r.comments.some((c) => c.id === posted.id), 'posted comment not found');
        ctx.detail(`${r.comments.length} comment(s); author ids available: ${r.comments.every((c) => c.author.accountId ?? c.author.name) ? 'yes' : 'no'}`);
      });
      await report.step('List transitions (for "In Review")', async (ctx) => {
        const r = await jira<{ transitions: Array<{ id: string; name: string; to: { name: string } }> }>('GET', `${api}/issue/${encodeURIComponent(issueKey)}/transitions`);
        ctx.detail(r.transitions.map((t) => `${t.name} -> ${t.to.name}`).join('; ') || 'none');
        ctx.fact('inReviewAvailable', r.transitions.some((t) => /in review/i.test(t.to.name)));
      });
      if (posted) {
        await report.step('Delete the spike comment', async () => {
          await jira('DELETE', `${api}/issue/${encodeURIComponent(issueKey)}/comment/${posted.id}`);
        });
      }
    }
  }
  await report.finish();
}
