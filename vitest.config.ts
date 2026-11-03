import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  '@tandem/core/testing': src('./packages/core/src/testing/index.ts'),
  '@tandem/shared': src('./packages/shared/src/index.ts'),
  '@tandem/core': src('./packages/core/src/index.ts'),
  '@tandem/adapters': src('./packages/adapters/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['packages/*/src/**/*.test.ts'], exclude: ['**/*.it.test.ts', '**/node_modules/**'], environment: 'node' },
      },
      {
        resolve: { alias },
        test: { name: 'integration', include: ['packages/*/src/**/*.it.test.ts'], environment: 'node', testTimeout: 180_000, hookTimeout: 180_000 },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**', '**/index.ts'],
      reporter: ['text-summary', 'text', 'json-summary'],
      thresholds: {
        'packages/core/src/**': { lines: 85, statements: 85 },
      },
    },
  },
});
