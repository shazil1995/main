import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: false }, '/healthz': 'http://127.0.0.1:4100' } },
  build: { sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 300, rollupOptions: { output: { manualChunks: (id: string) => (id.includes('node_modules') ? 'vendor' : undefined) } } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
