import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Build-Output direkt ins Express-static-Verzeichnis des Bots.
// Im Dev-Mode laeuft Vite auf Port 5173 und proxied /api + /auth + /socket.io
// an den Bot (Port 3000), damit Cookies/Sessions nahtlos weiterreichen.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: path.resolve(__dirname, '../src/dashboard/public'),
    emptyOutDir: true,
    sourcemap: true,
    // Stage 56: keep entry under control via vendor/route splits (measured, not speculative).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('\\react\\')) {
            return 'vendor-react';
          }
          if (id.includes('react-router')) return 'vendor-router';
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
          if (id.includes('socket.io-client') || id.includes('engine.io-client')) return 'vendor-socket';
          if (id.includes('lucide-react')) return 'vendor-lucide';
          if (id.includes('zod')) return 'vendor-zod';
          return 'vendor-misc';
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', changeOrigin: true, ws: true },
    },
  },
});
