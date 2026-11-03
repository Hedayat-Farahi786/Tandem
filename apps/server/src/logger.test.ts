import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneLogs } from './logger.js';

describe('logs', () => {
  it('keeps 14 days of daily logs and leaves other files alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tandem-logs-'));
    for (const n of ['tandem-2026-10-01.log', 'tandem-2026-10-19.log', 'tandem-2026-10-20.log', 'tandem-2026-11-03.log', 'notes.txt']) writeFileSync(join(dir, n), 'x');
    expect(pruneLogs(dir, 14, new Date('2026-11-03T09:00:00Z'))).toEqual(['tandem-2026-10-01.log', 'tandem-2026-10-19.log']);
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'tandem-2026-10-20.log', 'tandem-2026-11-03.log']);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});
