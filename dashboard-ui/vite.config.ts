import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Build-Output direkt ins Express-static-Verzeichnis des Bots.
// Im Dev-Mode laeuft Vite auf Port 5173 und proxied /api + /auth + /socket.io
// an den Bot (Port 3000), damit Cookies/Sessions nahtlos weiterreichen.
export default defineConfig({
  plugins: [react()],
  // MapLibre GL v6 ships its worker as ESM. Vite dependency pre-bundling can
  // rewrite that worker import in a way that leaves runtime GeoJSON sources
  // alive but their fill/line layers invisible. DOM markers still render,
  // which made the radar editor look as if only its handles existed.
  // Keep MapLibre out of optimizeDeps so Vite preserves the package's worker
  // boundary exactly as published.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src'), '@radar-coordinates': path.resolve(__dirname, '../src/shared/radarCoordinates.ts') },
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
          if (id.includes('maplibre-gl')) return 'vendor-radar-map';
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
