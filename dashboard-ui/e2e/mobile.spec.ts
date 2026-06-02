import { test, expect } from '@playwright/test';

/**
 * Mobile-Smoke fuer das V-Bot-Dashboard.
 *
 * Laeuft im Projekt `mobile-chrome` (Pixel 5) und zusaetzlich erzwungen bei
 * 320px (kleinster unterstuetzter Viewport). Prueft, dass die Login-Seite —
 * die einzige unauthentifizierte Route — mobil vollstaendig nutzbar ist:
 *  - SPA mountet, kein horizontaler Overflow
 *  - Login-CTA sichtbar UND erfuellt das 44x44px-Touch-Target-Minimum
 *  - viewport-Meta + lang/dark vorhanden
 *
 * Backend wird gestubbt (kein echter Bot im CI), analog zu login.spec.ts.
 */

async function stubAuth(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/auth/status', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
}

test.describe('Mobile Dashboard (Login-Smoke)', () => {
  test('rendert auf Pixel-5-Viewport ohne horizontalen Overflow', async ({ page }) => {
    await stubAuth(page);
    await page.goto('/');

    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.getByRole('button', { name: /Discord/i })).toBeVisible();

    // Kein horizontaler Overflow: Dokumentbreite <= Viewportbreite (+1px Toleranz).
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('Login-CTA erfuellt 44x44px-Touch-Target bei 320px', async ({ page }) => {
    await stubAuth(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/');

    const cta = page.getByRole('button', { name: /Discord/i });
    await expect(cta).toBeVisible();

    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    // Touch-Target-Minimum (WCAG 2.5.5 / Mobile-Hardening): >= 44x44px.
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);

    // Auch bei 320px kein horizontaler Overflow.
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('hat Viewport-Meta + lang/dark (mobile a11y/Theme-Smoke)', async ({ page }) => {
    await stubAuth(page);
    await page.goto('/');

    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('width=device-width');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'de');
    await expect(html).toHaveClass(/dark/);
  });
});
