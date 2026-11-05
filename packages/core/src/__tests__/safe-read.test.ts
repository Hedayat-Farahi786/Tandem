import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readInside } from '../safe-read.js';

const root = mkdtempSync(join(tmpdir(), 'tandem-read-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('reading files of a checkout', () => {
  it('reads files inside it, never through a link that leads outside', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(root, 'secret.db'), 'SECRET');
    writeFileSync(join(repo, 'docs', 'rules.md'), 'Use tabs.');
    symlinkSync(join(root, 'secret.db'), join(repo, 'docs', 'agent-rules.md'));
    symlinkSync('rules.md', join(repo, 'docs', 'alias.md'));
    symlinkSync(root, join(repo, 'up'));
    expect(await readInside(repo, 'docs/rules.md')).toBe('Use tabs.');
    expect(await readInside(repo, 'docs/alias.md')).toBe('Use tabs.');
    expect(await readInside(repo, 'docs/agent-rules.md')).toBeUndefined();
    expect(await readInside(repo, 'up/secret.db')).toBeUndefined();
    expect(await readInside(repo, '../secret.db')).toBeUndefined();
    expect(await readInside(repo, 'missing.md')).toBeUndefined();
  });
});
