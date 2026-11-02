/**
 * Runs every spike in order, each in its own process, and prints a summary.
 *   pnpm spike:all
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const spikes = ['d-local-tracker.ts', 'b-codecommit-git.ts', 'c-codecommit-pr.ts', 'a-copilot.ts', 'd-jira.ts'];
const results: Array<[string, number | null]> = [];
for (const s of spikes) {
  const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(new URL(`./${s}`, import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
  results.push([s, r.status]);
}
console.log('\nSummary');
for (const [s, code] of results) console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${s}`);
process.exitCode = results.some(([, c]) => c !== 0) ? 1 : 0;
