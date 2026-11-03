import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@tandem/shared';
import { CopilotRuntime } from './copilot-runtime.js';

/**
 * Real Copilot runtime (bundled with the SDK), zero model calls: forbidden tool calls are run
 * through the runtime's own pipeline and must be denied by Tandem's hook. Works signed in or not.
 */
describe('CopilotRuntime against the real runtime (no model calls)', () => {
  const rt = new CopilotRuntime({ settings: async () => DEFAULT_SETTINGS });
  afterAll(() => rt.stop());

  it('denies every forbidden action in the self-test', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'tandem-selftest-'));
    const r = await rt.selfTest(ws);
    expect(r.failures).toEqual([]);
    expect(r.denied).toBe(r.total);
    expect(r.total).toBe(8);
  });
});
