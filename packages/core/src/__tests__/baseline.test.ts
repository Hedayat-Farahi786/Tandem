import { describe, expect, it } from 'vitest';
import { compactOutput, newFailures, summarizeFailures } from '../workflow/baseline.js';

describe('reading check output', () => {
  it('counts and names failures from the usual runners', () => {
    expect(summarizeFailures('Chrome Headless 1 (Linux 0.0.0) Auth guard redirects FAILED\n\tError\nTOTAL: 1 FAILED, 9 SUCCESS')).toEqual({ failures: 1, names: ['Auth guard redirects'] });
    expect(summarizeFailures('Tests:       2 failed, 10 passed, 12 total')).toEqual({ failures: 2 });
    expect(summarizeFailures(' ✕ shows the status (4 ms)\n Tests  1 failed | 3 passed')).toEqual({ failures: 1, names: ['shows the status'] });
    expect(summarizeFailures('=== 3 failed, 5 passed in 0.2s ===')).toEqual({ failures: 3 });
    expect(summarizeFailures('--- FAIL: TestHealth (0.00s)\nFAIL')).toEqual({ failures: 1, names: ['TestHealth'] });
    expect(summarizeFailures('all good')).toEqual({});
    // The same failing test with a different duration is the same test.
    expect(summarizeFailures(' × test/a.test.ts > keeps ok 12ms').names).toEqual(['test/a.test.ts > keeps ok']);
    expect(summarizeFailures(' × test/a.test.ts > keeps ok 1.4s').names).toEqual(['test/a.test.ts > keeps ok']);
    // A progress line right before a failure doesn't swallow its name.
    expect(summarizeFailures('Chrome 1 (Linux): Executed 3 of 9 (1 FAILED) (0 secs)\nChrome 1 (Linux) Guard redirects FAILED\nTOTAL: 1 FAILED').names).toEqual(['Guard redirects']);
  });

  it('keeps what people read: no colour codes, no repeated progress lines', () => {
    const out = compactOutput('\x1b[32mok\x1b[39m\nChrome Headless 1 (Linux): Executed 1 of 3 (0 FAILED)\nChrome Headless 1 (Linux): Executed 2 of 3 (1 FAILED)\nsame\nsame\nChrome Headless 1 (Linux) Suite fails FAILED');
    expect(out).toBe('ok\nsame\nChrome Headless 1 (Linux) Suite fails FAILED\nChrome Headless 1 (Linux): Executed 2 of 3 (1 FAILED)');
  });

  it('tells new failures from ones the base branch already has', () => {
    const base = { failed: true, timedOut: false, failures: 2, names: ['a', 'b'] };
    expect(newFailures({ failures: 2, names: ['a', 'b'] }, base)).toEqual({ isNew: false, names: [], count: 0 });
    expect(newFailures({ failures: 3, names: ['a', 'b', 'c'] }, base)).toEqual({ isNew: true, names: ['c'], count: 1 });
    expect(newFailures({ failures: 3 }, { failed: true, timedOut: false, failures: 2 })).toEqual({ isNew: true, count: 1 });
    expect(newFailures({ failures: 1 }, { failed: false, timedOut: false })).toEqual({ isNew: true });
  });
});
