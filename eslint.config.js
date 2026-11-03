import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'spikes/sandbox/**', 'spikes/.work/**', 'spikes/reports/**', 'apps/web/dist/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Core talks to the world only through ports.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['node:child_process', 'child_process', 'node:sqlite', 'node:net', 'node:http', 'node:https', '@github/copilot-sdk'],
          patterns: [{ group: ['@tandem/adapters', '@tandem/adapters/*', '@aws-sdk/*'], message: 'core depends only on ports' }],
        },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'core depends only on ports' }],
    },
  },
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@tandem/core', '@tandem/adapters', 'node:*'], message: 'shared has no dependencies on other packages or Node APIs' }] }],
    },
  },
  {
    // Spikes and scripts print reports.
    files: ['spikes/src/**/*.ts', 'scripts/**/*.ts', '**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
);
