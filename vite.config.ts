import { defineConfig } from 'vite';

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  server: { port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
