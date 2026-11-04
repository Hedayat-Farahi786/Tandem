import type { CommandResult, CriterionTest, Criterion, ReviewFinding } from '@tandem/shared';

export interface PrDescriptionInput {
  taskKey: string;
  title: string;
  summary: string;
  specPath: string;
  specVersion: number;
  repoName: string;
  criteria: readonly Criterion[];
  tests: readonly CriterionTest[];
  /** Verification results for this repo (and the project's integration run, if any). */
  verification: readonly CommandResult[];
  openFindings: readonly ReviewFinding[];
  otherPrs: ReadonlyArray<{ repoName: string; url: string }>;
  trackerUrl?: string;
  needsAttention: boolean;
  attentionNotes: readonly string[];
  limit: number;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const icon = (r: string) => (r === 'pass' ? '✅ pass' : r === 'fail' ? '❌ fail' : '⏭️ not run');

export function prTitle(taskKey: string, title: string, needsAttention: boolean): string {
  return `${needsAttention ? '[needs attention] ' : ''}${taskKey}: ${title}`.slice(0, 150);
}

/** PR description: summary, spec, other PRs, criterion -> test -> result, verification, open findings. */
export function buildPrDescription(i: PrDescriptionInput): string {
  const parts: string[] = [];
  if (i.needsAttention) {
    parts.push(`> **Needs attention.** Tandem could not get everything green:\n${i.attentionNotes.map((n) => `> - ${esc(n)}`).join('\n')}`);
  }
  parts.push(`## Summary\n\n${i.summary.trim() || i.title}`);
  const links = [`- Spec: \`${i.specPath}\` (version ${i.specVersion})`];
  if (i.trackerUrl) links.push(`- Ticket: ${i.trackerUrl}`);
  for (const pr of i.otherPrs) links.push(`- ${pr.repoName}: ${pr.url}`);
  parts.push(`## Links\n\n${links.join('\n')}`);

  const rows = i.criteria.map((c, idx) => {
    const n = idx + 1;
    const tests = i.tests.filter((t) => t.criterion === n);
    const testCell = tests.length ? tests.map((t) => `\`${esc(t.file)}\` › ${esc(t.name)}${t.scope === 'suite' ? ' (suite)' : ''}`).join('<br>') : '_no test recorded_';
    const result = tests.length ? (tests.some((t) => t.result === 'fail') ? icon('fail') : tests.every((t) => t.result === 'pass') ? icon('pass') : icon('not-run')) : icon('not-run');
    return `| ${n}. ${esc(short(`Given ${c.given}, when ${c.when}, then ${c.then}`, 160))} | ${testCell} | ${result} |`;
  });
  parts.push(`## Acceptance criteria\n\n| Criterion | Test | Result |\n| --- | --- | --- |\n${rows.join('\n') || '| - | - | - |'}`);

  const ver = i.verification.map((r) => `| ${r.kind} | \`${esc(short(r.command, 80))}\` | ${r.skipped ? `⏭️ skipped by the owner${r.outputTail.startsWith('Skipped by the owner:') ? ` (${esc(short(r.outputTail.replace(/^Skipped by the owner:\s*/, ''), 100))})` : ''}` : r.exitCode === 0 && !r.timedOut ? '✅ pass' : r.timedOut ? '⏱️ timed out' : '❌ fail'} | ${(r.durationMs / 1000).toFixed(1)} s |`);
  parts.push(`## Verification\n\n| Check | Command | Result | Time |\n| --- | --- | --- | --- |\n${ver.join('\n') || '| - | - | - | - |'}`);

  if (i.openFindings.length) {
    const f = i.openFindings.map((x) => `- **${x.severity}** (${x.category}) ${esc(x.title)}${x.file ? ` — \`${esc(x.file)}${x.line ? `:${x.line}` : ''}\`` : ''}: ${esc(short(x.detail, 300))}`);
    parts.push(`## Open review findings\n\n${f.join('\n')}`);
  } else {
    parts.push('## Open review findings\n\nNone.');
  }
  parts.push('_Opened by Tandem. Agents never merge; a person reviews and merges this PR._');
  return fit(parts, i.limit, i.specPath);
}

/** Drops detail from the bottom up until the description fits the host's limit. */
function fit(parts: string[], limit: number, specPath: string): string {
  let out = parts.join('\n\n');
  if (out.length <= limit) return out;
  const note = `\n\n_Trimmed to fit the ${limit}-character limit. The full details are in \`${specPath}\` and in Tandem._`;
  out = out.slice(0, Math.max(0, limit - note.length));
  const cut = out.lastIndexOf('\n');
  return `${out.slice(0, cut > 0 ? cut : out.length)}${note}`;
}
