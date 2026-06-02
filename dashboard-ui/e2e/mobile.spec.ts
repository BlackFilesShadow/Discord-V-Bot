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

/**
 * Mobile-Viewport-Matrix: prueft die explizit geforderten Geraetegroessen
 * (iPhone SE bis iPhone 14 Pro Max) auf horizontalen Overflow der Login-Seite.
 */
const VIEWPORTS = [
  { name: 'iPhone SE',        width: 320, height: 568 },
  { name: 'Android-klein',    width: 360, height: 800 },
  { name: 'iPhone X/12 mini', width: 375, height: 812 },
  { name: 'iPhone 14',        width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
] as const;

test.describe('Mobile Viewport-Matrix (Login)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height}) ohne horizontalen Overflow`, async ({ page }) => {
      await stubAuth(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      await expect(page.locator('#root')).not.toBeEmpty();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});

/**
 * Authentifizierte Shell: stubbt eine Session + DEV/Bot-Admin-Status (gesperrt)
 * und prueft auf der Server-Uebersicht, dass Branding, DEV-Login, Bot-Admin-Login
 * und der Server-Titel mobil NICHT ueberlappen und kein horizontaler Overflow
 * entsteht. Deckt den Mobile-Header/Login-Restrukturierungs-Fix ab.
 */
async function stubAuthenticated(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { discordId: '1', username: 'tester', avatar: null, role: 'DEVELOPER' },
      }),
    }),
  );
  await page.route('**/api/v2/dev/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false, eligible: true, expiresAt: null }),
    }),
  );
  await page.route('**/api/v2/bot-admin/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false, expiresAt: null }),
    }),
  );
  await page.route('**/api/v2/guilds', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ guilds: [] }),
    }),
  );
}

interface Rect { x: number; y: number; width: number; height: number }
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

test.describe('Mobile Header/Login (authentifiziert, kein Overlap)', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height}): Branding/DEV/Bot-Admin ueberlappen nicht`, async ({ page }) => {
      await stubAuthenticated(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/servers');

      const branding = page.getByRole('link', { name: 'V-Bot' });
      const devPanel = page.getByTestId('dev-login-panel');
      const adminPanel = page.getByTestId('botadmin-login-panel');

      await expect(branding).toBeVisible();
      await expect(devPanel).toBeVisible();
      await expect(adminPanel).toBeVisible();

      const [bBox, dBox, aBox] = await Promise.all([
        branding.boundingBox(),
        devPanel.boundingBox(),
        adminPanel.boundingBox(),
      ]);
      expect(bBox).not.toBeNull();
      expect(dBox).not.toBeNull();
      expect(aBox).not.toBeNull();

      // Branding (Header) liegt ueber den Login-Panels — keine Ueberschneidung.
      expect(overlaps(bBox!, dBox!)).toBe(false);
      expect(overlaps(bBox!, aBox!)).toBe(false);
      // DEV- und Bot-Admin-Panel duerfen sich gegenseitig nicht ueberlagern.
      expect(overlaps(dBox!, aBox!)).toBe(false);

      // Kein horizontaler Overflow ueber alle Viewports.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});
