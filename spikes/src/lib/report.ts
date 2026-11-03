import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform, release, arch } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './redact.js';

export type StepStatus = 'pass' | 'fail' | 'skip';

export interface StepRecord {
  name: string;
  status: StepStatus;
  durationMs: number;
  details: string[];
  error?: string;
}

export interface StepContext {
  /** Add a line of evidence to this step. */
  detail(text: string): void;
  /** Record a fact that later phases depend on (shown in the "Findings" table). */
  fact(key: string, value: unknown): void;
  /** Fail the step with a clear message when the condition does not hold. */
  expect(condition: unknown, message: string): void;
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPORTS_DIR = join(here, '..', '..', 'reports');

export class Report {
  private readonly steps: StepRecord[] = [];
  private readonly facts = new Map<string, string>();
  private readonly startedAt = new Date();

  constructor(
    private readonly id: string,
    private readonly title: string,
  ) {
    console.log(`\n=== ${title} ===\n`);
  }

  fact(key: string, value: unknown): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.facts.set(key, redact(text));
  }

  skip(name: string, reason: string): void {
    this.steps.push({ name, status: 'skip', durationMs: 0, details: [redact(reason)] });
    console.log(`SKIP  ${name} - ${reason}`);
  }

  /** Runs one step. Errors are caught and recorded; the step result is returned or undefined on failure. */
  async step<T>(name: string, fn: (ctx: StepContext) => Promise<T>): Promise<T | undefined> {
    const details: string[] = [];
    const started = performance.now();
    const ctx: StepContext = {
      detail: (text) => {
        details.push(redact(text));
      },
      fact: (key, value) => {
        this.fact(key, value);
      },
      expect(condition, message) {
        if (!condition) throw new Error(message);
      },
    };
    try {
      const result = await fn(ctx);
      const durationMs = Math.round(performance.now() - started);
      this.steps.push({ name, status: 'pass', durationMs, details });
      console.log(`PASS  ${name} (${durationMs} ms)`);
      for (const d of details) console.log(`      ${d}`);
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      const message = redact(err instanceof Error ? err.message : String(err));
      this.steps.push({ name, status: 'fail', durationMs, details, error: message });
      console.log(`FAIL  ${name} (${durationMs} ms)\n      ${message}`);
      for (const d of details) console.log(`      ${d}`);
      return undefined;
    }
  }

  get failed(): boolean {
    return this.steps.some((s) => s.status === 'fail');
  }

  async finish(env: Record<string, string> = {}): Promise<string> {
    await mkdir(REPORTS_DIR, { recursive: true });
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
    const base = `${this.id}-${platform()}-${stamp}`;
    const counts = {
      pass: this.steps.filter((s) => s.status === 'pass').length,
      fail: this.steps.filter((s) => s.status === 'fail').length,
      skip: this.steps.filter((s) => s.status === 'skip').length,
    };
    const machine = Object.fromEntries(
      Object.entries({ os: `${platform()} ${release()} (${arch()})`, node: process.version, ...env }).map(([k, v]) => [k, redact(String(v))]),
    );
    const lines: string[] = [];
    lines.push(`# ${this.title}`, '');
    lines.push(`- Result: **${counts.fail === 0 ? 'PASS' : 'FAIL'}** (${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped)`);
    lines.push(`- Started: ${this.startedAt.toISOString()}`);
    for (const [k, v] of Object.entries(machine)) lines.push(`- ${k}: ${redact(String(v))}`);
    lines.push('', '## Steps', '', '| Step | Result | Time |', '| --- | --- | --- |');
    for (const s of this.steps) lines.push(`| ${s.name} | ${s.status.toUpperCase()} | ${s.durationMs} ms |`);
    lines.push('');
    for (const s of this.steps) {
      if (s.details.length === 0 && !s.error) continue;
      lines.push(`### ${s.name}`, '');
      if (s.error) lines.push(`**Error:** ${s.error}`, '');
      for (const d of s.details) lines.push(`- ${d.replace(/\n/g, '\n  ')}`);
      lines.push('');
    }
    if (this.facts.size > 0) {
      lines.push('## Findings', '', '| Key | Value |', '| --- | --- |');
      for (const [k, v] of this.facts) lines.push(`| ${k} | ${v.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
      lines.push('');
    }
    const md = lines.join('\n');
    const mdPath = join(REPORTS_DIR, `${base}.md`);
    await writeFile(mdPath, md, 'utf8');
    await writeFile(
      join(REPORTS_DIR, `${base}.json`),
      JSON.stringify({ id: this.id, title: this.title, startedAt: this.startedAt, machine, counts, steps: this.steps, facts: Object.fromEntries(this.facts) }, null, 2),
      'utf8',
    );
    console.log(`\n${counts.fail === 0 ? 'PASS' : 'FAIL'}: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`);
    console.log(`Report: ${mdPath.replace(homedir(), '~')}\n`);
    if (counts.fail > 0) process.exitCode = 1;
    return mdPath;
  }
}

/** Fails the current step with a clear message when the condition does not hold. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
