import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const BACKEND_ORIGIN = 'http://127.0.0.1:53821';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
        // The backend rejects writes whose Origin is not its own port (design §12).
        // Browsers send Origin: http://localhost:5173 for dev-mode writes, so the
        // proxy rewrites it to the backend origin. changeOrigin only rewrites Host.
        headers: { origin: BACKEND_ORIGIN },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
