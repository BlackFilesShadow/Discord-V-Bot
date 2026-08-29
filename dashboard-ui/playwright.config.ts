import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realDb = process.env.E2E_REAL_DB === '1';
const realDbSpec = /stage-27-35-real-http-db\.spec\.ts/;
const dashboardUiRoot = path.dirname(fileURLToPath(import.meta.url));
const e2ePort = Number(process.env.E2E_PORT ?? '4173');

/**
 * Playwright-Konfig fuer Frontend-Smoke-Tests des V-Bot-Dashboards.
 *
 * Strategie: Die breite Browser-Matrix baut das Vite-SPA und serviert es via
 * `vite preview`; ihre API-Vertraege bleiben gezielt isoliert. Wenn
 * E2E_REAL_DB=1 gesetzt ist, laeuft zusaetzlich ein eigener Chromium-Block
 * gegen den echten Express-/OAuth-/AuthZ-/Prisma-Pfad mit PostgreSQL. Nur die
 * externe Discord-HTTP-Grenze wird dabei im Serverprozess simuliert.
 *
 * Was die Tests garantieren:
 *  - Build laeuft ohne Fehler durch
 *  - SPA mountet React + React-Router (sonst leerer #root)
 *  - Login-CTA ist sichtbar und klickbar
 *  - Basale a11y-Properties (lang, h1) vorhanden
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: realDbSpec,
    },
    {
      // Mobile-Smoke: garantiert, dass die Login-Seite auf einem echten
      // Mobil-Viewport (Pixel 5, 393px) korrekt rendert und bedienbar bleibt.
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testIgnore: realDbSpec,
    },
    ...(realDb ? [{
      name: 'real-db-chromium',
      testMatch: realDbSpec,
      use: { ...devices['Desktop Chrome'] },
    }] : []),
  ],
  webServer: {
    // Build wird VOR `playwright test` ueber den npm-script `e2e` ausgefuehrt
    // (`npm run build && playwright test`), damit der webServer-Boot nicht ins
    // Timeout laeuft. Im Real-DB-Modus liefert der echte Dashboard-Server
    // denselben Build aus; sonst nutzt die isolierte Matrix Vite preview.
    command: realDb
      ? 'node ../scripts/e2e-dashboard-db-server.cjs'
      : `npx vite preview --outDir ../src/dashboard/public --port ${e2ePort} --strictPort --host 127.0.0.1`,
    // Playwright wird auch aus dem Repository-Root aufgerufen. Der feste
    // Arbeitsordner verhindert, dass versehentlich ein Build einer anderen
    // Worktree-Kopie auf Port 4173 getestet wird.
    cwd: dashboardUiRoot,
    url: `http://127.0.0.1:${e2ePort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
