import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@tandem/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5174, proxy: { '/api': 'http://127.0.0.1:4317' } },
});
