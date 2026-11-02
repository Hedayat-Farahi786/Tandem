/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web' },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { '/api': api },
  },
  test: {
    environment: 'node',
  },
});
