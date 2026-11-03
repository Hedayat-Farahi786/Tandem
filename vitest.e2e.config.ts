import { defineConfig } from 'vitest/config';

/** Phase 4 flows: the built server as a child process, one scenario after another. */
export default defineConfig({
  test: {
    name: 'flows',
    include: ['e2e/flows/**/*.e2e.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 300_000,
    reporters: ['verbose'],
  },
});
