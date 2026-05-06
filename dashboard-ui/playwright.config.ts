import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright-Konfig fuer Frontend-Smoke-Tests des V-Bot-Dashboards.
 *
 * Strategie: KEIN echtes Backend. Wir bauen das Vite-SPA und servieren es
 * via `vite preview`. Smoke-Tests pruefen nur, dass die Login-Seite (die
 * einzige unauthentifizierte Route) korrekt rendert — alles dahinter
 * braucht eine echte Discord-OAuth-Session, was im CI nicht reproduzierbar
 * ist und hier auch nicht der Punkt der E2E-Suite ist.
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
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Build wird VOR `playwright test` ueber den npm-script `e2e` ausgefuehrt
    // (`npm run build && playwright test`), damit der webServer-Boot nicht ins
    // 120s-Timeout laeuft. preview servierte statische Files aus build.outDir
    // (= ../src/dashboard/public). KEIN Proxy, kein Backend.
    command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
