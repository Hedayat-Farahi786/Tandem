import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Script, ScriptCall, ScriptReply } from '@tandem/core/testing';

/**
 * The scripted agent's default behaviour (TANDEM_AGENT=scripted): deterministic answers and real,
 * check-passing edits for the sandbox apps in spikes/sandbox (backend, frontend, fullstack). Used by
 * the Playwright smoke tests and the scripted end-to-end runs; never by real users.
 */

function section(prompt: string, heading: string): string {
  const m = new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?:\\n\\n## |$)`).exec(prompt);
  return m?.[1] ?? '';
}

function specFrom(prompt: string): string {
  const req = section(prompt, 'Requirement');
  const title = /^# (.+)$/m.exec(req)?.[1] ?? 'Task';
  const criteria = [...req.matchAll(/^\d+\. (Given .+)$/gm)].map((m) => m[1]!);
  const repos = /Affected repos: ([^\n]+)\./.exec(prompt)?.[1] ?? 'app';
  const multi = /"API contract" section is mandatory/.test(prompt);
  const feedback = section(prompt, 'Requested changes \\(apply these\\)').trim();
  return `# ${title}

| Task | Version | Status |
| --- | --- | --- |
| KEY | 1 | In review |

## Problem and goal

${/\*\*Goal:\*\* (.+)/.exec(req)?.[1] ?? title}

## User story

${/\*\*User story:\*\* (.+)/.exec(req)?.[1] ?? 'As a user I want this change.'}

## Acceptance criteria

${(criteria.length ? criteria : ['Given the service runs, when GET /health is called, then it returns 200 {"status":"ok"}.', 'Given the main page loads, when health is ok, then it shows "Status: ok".']).map((c, i) => `${i + 1}. ${c}`).join('\n')}

## In scope

- What the criteria describe.${feedback ? `\n- ${feedback}` : ''}

## Out of scope

- ${/\*\*Out of scope:\*\* (.+)/.exec(req)?.[1] ?? 'Anything else.'}

## Affected repos and changes

- ${repos}

## API contract

${multi ? 'Request:\n\n```http\nGET /health\n```\n\nResponse (200):\n\n```json\n{ "status": "ok" }\n```\n\nError (503):\n\n```json\n{ "status": "error" }\n```' : 'None.'}

## Data and database changes

None.

## UI changes and states

Loading shows "Checking status…"; error shows "Status unavailable".

## Edge cases and errors

The backend is down: the page shows the error state.

## Security and permissions

Public endpoint; no data exposed.

## Tests to add

- One test per criterion (criteria ${criteria.map((_, i) => i + 1).join(', ') || '1, 2'}).

## Rollout notes

No flags needed.

## Open questions

None.

## Approvals
`;
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);

/**
 * The scripted size estimate grows with the number of features a request lists: two parts ("an
 * endpoint and a status line") is one change; three or more is too big and comes with a split,
 * one part per feature.
 */
export function scriptedSize(goal: string) {
  const features = goal
    .replace(/[.!]\s*$/, '')
    .split(/,\s*(?:and\s+)?|;\s*|\s+and\s+(?:also\s+)?/i)
    .map((f) => f.trim())
    .filter((f) => f.length > 3);
  if (features.length < 3) return { estimatedLines: 90, perRepo: [], features: ['health status'], proposedSplit: [], rationale: 'One endpoint and one status line.' };
  return {
    estimatedLines: features.length * 220,
    perRepo: [],
    features,
    proposedSplit: features.map((f, i) => ({ title: f.charAt(0).toUpperCase() + f.slice(1), criteria: i === 0 ? [1, 2] : [] })),
    rationale: `${features.length} separate features in one request.`,
  };
}
const goalOf = (text: string) => /\*\*Goal:\*\* (.+)/.exec(text)?.[1] ?? '';

const BACKEND_TEST = (rel: string) => `import { describe, expect, it } from 'vitest';
import { buildApp } from '${rel}';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
`;

const HEALTH_COMPONENT = `import { useEffect, useState } from 'react';

export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl('/health');
  if (!res.ok) throw new Error(\`Health request failed with \${res.status}\`);
  return ((await res.json()) as { status: string }).status;
}

export function HealthStatus({ load = fetchHealth }: { load?: () => Promise<string> }) {
  const [status, setStatus] = useState<string>('Checking status…');
  useEffect(() => {
    let active = true;
    load()
      .then((s) => active && setStatus(\`Status: \${s}\`))
      .catch(() => active && setStatus('Status unavailable'));
    return () => {
      active = false;
    };
  }, [load]);
  return <p data-testid="health">{status}</p>;
}
`;

const HEALTH_TEST = (rel: string) => `import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthStatus } from '${rel}';

afterEach(cleanup);

describe('HealthStatus', () => {
  it('shows the status from the API', async () => {
    render(<HealthStatus load={() => Promise.resolve('ok')} />);
    expect(await screen.findByText('Status: ok')).toBeTruthy();
  });

  it('shows an error state when the API fails', async () => {
    render(<HealthStatus load={() => Promise.reject(new Error('down'))} />);
    expect(await screen.findByText('Status unavailable')).toBeTruthy();
  });
});
`;

function implement(call: ScriptCall): ScriptReply {
  const repo = /in the `([^`]+)` repo/.exec(call.prompt)?.[1] ?? 'app';
  const root = join(call.opts.workspace, repo);
  const edits: ScriptReply['edits'] = [];
  const tests: Array<{ criterion: number; file: string; name: string }> = [];
  const addRoute = (file: string) => {
    const src = read(join(root, file));
    if (src && !src.includes("'/health'")) edits.push({ path: `${repo}/${file}`, content: src.replace(/\n(\s*)return app;/, "\n$1app.get('/health', async () => ({ status: 'ok' as const }));\n\n$1return app;") });
  };
  const addUi = (dir: string, testDir: string, rel: string) => {
    edits.push({ path: `${repo}/${dir}/HealthStatus.tsx`, content: HEALTH_COMPONENT });
    edits.push({ path: `${repo}/${testDir}/HealthStatus.test.tsx`, content: `${testDir.includes('web') ? '// @vitest-environment jsdom\n' : ''}${HEALTH_TEST(rel)}` });
    const main = read(join(root, dir, 'main.tsx'));
    if (main && !main.includes('HealthStatus')) {
      edits.push({ path: `${repo}/${dir}/main.tsx`, content: main.replace("import { App } from './App';", "import { App } from './App';\nimport { HealthStatus } from './HealthStatus';").replace('<App />', '<App />\n    <HealthStatus />') });
    }
    tests.push({ criterion: 2, file: `${testDir}/HealthStatus.test.tsx`, name: 'shows the status from the API' });
  };
  if (existsSync(join(root, 'src', 'server', 'app.ts'))) {
    addRoute('src/server/app.ts');
    edits.push({ path: `${repo}/test/server/health.test.ts`, content: BACKEND_TEST('../../src/server/app.js') });
    tests.push({ criterion: 1, file: 'test/server/health.test.ts', name: 'returns ok' });
    addUi('src/web', 'test/web', '../../src/web/HealthStatus');
  } else if (existsSync(join(root, 'src', 'app.ts'))) {
    addRoute('src/app.ts');
    edits.push({ path: `${repo}/test/health.test.ts`, content: BACKEND_TEST('../src/app.js') });
    tests.push({ criterion: 1, file: 'test/health.test.ts', name: 'returns ok' }, { criterion: 2, file: 'test/health.test.ts', name: 'returns ok' });
  } else if (existsSync(join(root, 'src', 'App.tsx'))) {
    addUi('src', 'test', '../src/HealthStatus');
    tests.push({ criterion: 1, file: 'test/HealthStatus.test.tsx', name: 'shows the status from the API' });
  } else {
    edits.push({ path: `${repo}/HEALTH.md`, content: 'GET /health returns {"status":"ok"}.\n' });
  }
  return {
    intent: `Implementing the change in ${repo}`,
    reasoning: `The spec asks for a health endpoint and a status on the main page. I'll add the route, a small component that calls it, and one test per acceptance criterion so each criterion is proven.`,
    text: `Implemented ${repo}: ${edits.map((e) => e.path).join(', ')}.`,
    edits,
    tools: tests.map((t) => ({ name: 'tandem_record_test', args: { ...t, repo } })),
  };
}

function resolveConflicts(call: ScriptCall): ScriptReply {
  const files = /(?:hit conflicts in|and it conflicts in): ([^\n]+)\./.exec(call.prompt)?.[1]?.split(', ') ?? [];
  const repo = /^(?:Rebasing|The pull request branch in) (\S+?)(?: onto| no longer)/.exec(call.prompt)?.[1] ?? 'app';
  const edits = files
    .map((f) => ({ f, src: read(join(call.opts.workspace, repo, f)) }))
    .filter((x): x is { f: string; src: string } => Boolean(x.src))
    .map(({ f, src }) => ({ path: `${repo}/${f}`, content: src.replace(/^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm, '$1$2') }));
  return { intent: 'Resolving the merge conflict', reasoning: `Both branches changed ${files.join(', ')}. The changes don't contradict each other, so I'll keep both.`, text: `Kept both sides in ${files.join(', ')}.`, edits };
}

function chatReply(call: ScriptCall): ScriptReply {
  const p = call.prompt;
  const owner = /Owner: ([\s\S]*)$/.exec(p)?.[1]?.trim() ?? '';
  if (/^Question: /m.test(p)) {
    const repo = /Repos in the workspace: ([\w.-]+)\//.exec(p)?.[1] ?? 'app';
    // Say plainly that this is not a real answer: the test agent does not read the code.
    return {
      intent: 'Answering as the test agent',
      text: `I'm Tandem's **test agent**, so I don't read your code and can't really answer this. Tandem is running in test mode, which keeps Copilot (and its credits) out of the loop.\n\nWith Copilot on, this chat reads the code in ${repo} and answers with file and line references, like \`${repo}/src/app.ts:16\`. To turn it on, start Tandem without \`TANDEM_AGENT=scripted\`.`,
    };
  }
  if (p.includes('Draft so far:')) {
    const repos = [...p.matchAll(/([\w.-]+)\/ \(/g)].map((m) => m[1]!);
    const draft = /Draft so far:\n([\s\S]*?)\n\n(?:Still missing|The draft meets)/.exec(p)?.[1] ?? '';
    // The scripted agent can only build the health endpoint, but it talks about what was asked.
    const health = /health/i.test(`${owner} ${draft}`);
    if (/Still missing/.test(p) && !/^1\. Given/m.test(draft)) {
      if (!health)
        return {
          intent: 'Shaping the request',
          text: 'A couple of questions before I write this up.',
          tools: [
            { name: 'tandem_update_draft', args: { title: titleFrom(owner), goal: owner.slice(0, 300), criteria: [{ given: 'someone uses the app', when: 'they do what this request describes', then: firstSentence(owner) }] } },
            {
              name: 'tandem_ask_owner',
              args: {
                questions: [
                  { header: 'While waiting', question: 'What should people see while it loads, or if something goes wrong?', options: [{ label: 'Text messages', description: 'A short loading line, then a clear error message if it fails' }, { label: 'Spinner and banner', description: 'A small spinner while loading, an error banner if it fails' }, { label: 'Nothing special', description: 'Keep the page as it is while it loads' }] },
                  { header: 'Out of scope', question: 'What should this change leave out for now?', multiSelect: true, options: [{ label: 'Authentication', description: 'No sign-in changes' }, { label: 'Mobile layout', description: 'Desktop only for now' }, { label: 'Analytics', description: 'No tracking events' }] },
                ],
              },
            },
          ],
        };
      return {
        intent: 'Shaping the request',
        text: 'A couple of questions before I write this up.',
        tools: [
          { name: 'tandem_update_draft', args: { title: 'Add a GET /health endpoint', goal: owner.slice(0, 300) || 'Expose service health', criteria: [{ given: 'the backend is running', when: 'GET /health is called', then: 'it returns 200 {"status":"ok"}' }] } },
          {
            name: 'tandem_ask_owner',
            args: {
              questions: [
                { header: 'Loading & errors', question: 'What should the page show while the status loads, or if the backend is down?', options: [{ label: 'Text status', description: 'Show "Checking status…" while loading and "Status unavailable" if it fails' }, { label: 'Spinner and banner', description: 'A small spinner while loading, an error banner if it fails' }, { label: 'Hide until ready', description: 'Show nothing until the status arrives' }] },
                { header: 'Out of scope', question: 'What should this change leave out for now?', multiSelect: true, options: [{ label: 'Authentication', description: 'The endpoint stays public' }, { label: 'Metrics', description: 'No uptime history or charts' }, { label: 'Alerting', description: 'No notifications when it goes down' }] },
              ],
            },
          },
        ],
      };
    }
    if (!health)
      return {
        text: 'That covers everything: the spec on the right meets the Definition of Ready. Choose Create and start, or Save for later.',
        tools: [
          {
            name: 'tandem_update_draft',
            args: {
              userStory: `As a user I want this: ${goalOf(draft) || 'the change described above'}`,
              criteria: [
                { given: 'someone uses the app', when: 'they do what this request describes', then: 'it works as described' },
                { given: 'something goes wrong', when: 'the change cannot finish', then: owner ? firstSentence(owner) : 'they see a clear message' },
              ],
              exampleData: 'As described in the request',
              affectedAreas: 'The pages and API this change touches',
              outOfScope: /out of scope/i.test(owner) ? firstSentence(owner.slice(owner.toLowerCase().indexOf('out of scope') - 40 > 0 ? owner.toLowerCase().indexOf('out of scope') - 40 : 0)) : 'Anything not described in the request',
              openQuestions: [],
              affectedRepos: repos,
              size: scriptedSize(goalOf(draft)),
            },
          },
        ],
      };
    return {
      text: 'That covers everything: the spec on the right meets the Definition of Ready. Choose Create and start, or Save for later.',
      tools: [
        {
          name: 'tandem_update_draft',
          args: {
            userStory: 'As an operator I want to see whether the service is up',
            criteria: [
              { given: 'the backend is running', when: 'GET /health is called', then: 'it returns 200 {"status":"ok"}' },
              { given: 'the main page loads', when: 'the health call succeeds', then: 'the page shows "Status: ok"' },
            ],
            exampleData: 'GET /health -> 200 {"status":"ok"}',
            affectedAreas: 'Backend routes; main page',
            outOfScope: 'Authentication, metrics',
            openQuestions: [],
            affectedRepos: repos,
            size: scriptedSize(goalOf(draft)),
          },
        },
      ],
    };
  }
  if (/\b(change|also|instead|add)\b/i.test(owner)) {
    return { text: 'I proposed that change to the spec; confirm it to redraft.', tools: [{ name: 'tandem_request_spec_change', args: { kind: 'redraft', summary: owner.slice(0, 80), feedback: owner } }] };
  }
  // A task whose checks fail: explain, and propose how to go on (the owner confirms).
  const failing = /Latest failing checks:\n- (\w[\w-]*) `([^`]+)` failed/.exec(p);
  if (failing && /\b(why|fail|wrong|help|fix)/i.test(owner)) {
    const repo = /Repos in the workspace: ([\w.-]+)\//.exec(p)?.[1] ?? 'app';
    return {
      intent: 'Reading the failing check',
      reasoning: `The ${failing[1]} check (\`${failing[2]}\`) fails. I'll compare its output with the spec and the code it tests before suggesting a fix.`,
      searches: ['describe('],
      reads: [`${repo}/test/server/health.test.ts`, `${repo}/src/server/app.ts`],
      text: `The **${failing[1]}** check fails: \`${failing[2]}\` exits with an error in ${repo}. The output points at a test that doesn't match the current code. I suggest fixing the code so the test passes, without changing the spec. If that sounds right, choose **Continue with this**.`,
      tools: [{ name: 'tandem_continue_task', args: { summary: 'Fix the code so the failing test passes, then run the checks again', guidance: `Read the output of \`${failing[2]}\`, fix the cause in the code (change the test only if it contradicts the spec), and run the checks again.` } }],
    };
  }
  return { text: `This task is described in the spec. ${owner ? 'Ask me about the build, the diff or failing checks.' : ''}`.trim() };
}

export const defaultScript: Script = (call) => {
  const p = call.prompt;
  if (p.startsWith('Estimate the size')) return { intent: 'Estimating the size of the change', value: scriptedSize(goalOf(p)) };
  if (p.startsWith('Turn this ticket')) {
    return {
      value: {
        title: 'Imported task',
        goal: 'Do what the ticket asks',
        userStory: 'As a user I want the ticket done',
        criteria: [
          { given: 'the ticket', when: 'it is implemented', then: 'its first outcome holds' },
          { given: 'the ticket', when: 'it is tested', then: 'its second outcome holds' },
        ],
        exampleData: 'See the ticket',
        affectedAreas: 'See the ticket',
        outOfScope: 'Anything not in the ticket',
        openQuestions: [],
        affectedRepos: [],
        size: { estimatedLines: 60, perRepo: [], features: ['ticket'], proposedSplit: [], rationale: 'small' },
      },
    };
  }
  // The request chat writes the full spec once the request is complete (same prompt, after a lead-in).
  if (p.startsWith('Write the implementation spec') || p.startsWith('The request is complete')) return { intent: 'Writing the spec', reasoning: 'The request is clear and small: one endpoint and one status line. I will describe the API contract first, then the UI states, then how each criterion is tested.', text: specFrom(p) };
  if (p.startsWith('Review this change')) return { intent: 'Reviewing the change against the spec', reasoning: 'I compared the diff with the spec, each acceptance criterion and the security checklist. Every criterion has a passing test and nothing outside the scope changed.', value: { findings: [] } };
  if (p.startsWith('Implement the approved spec')) return implement(call);
  if (p.startsWith('Verification failed')) return { text: 'Looked at the failures; no change.' };
  if (p.startsWith('These acceptance criteria have no recorded test')) return { text: 'Covered by existing tests.' };
  if (p.startsWith('A separate reviewer')) return { text: 'Nothing to fix.' };
  if (p.startsWith('Rebasing') || p.startsWith('The pull request branch')) return resolveConflicts(call);
  if (p.startsWith('Repos in the workspace')) return chatReply(call);
  return { text: 'OK.' };
};

/** A short task title from what the owner wrote: the first sentence, up to 60 characters. */
export function titleFrom(text: string): string {
  const first = firstSentence(text).replace(/^(please|can you|could you|i want to|we need to|let'?s)\s+/i, '');
  const t = first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}…` : first;
  return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/[.!?]$/, '') : 'New request';
}

function firstSentence(text: string): string {
  return (text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? '').trim();
}
