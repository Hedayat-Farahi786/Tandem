/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// loadEnv (not process.env): the config type-checks without Node's types.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.PORT ?? 5173),
      proxy: { '/api': env.BACKEND_URL ?? 'http://127.0.0.1:3001' },
    },
    test: {
      environment: 'jsdom',
    },
  };
});
