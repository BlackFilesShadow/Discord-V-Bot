import { test, expect } from '@playwright/test';

async function stubAuth(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/auth/status', route =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
}

async function expectTouchTarget(locator: import('@playwright/test').Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

test.describe('Mobile Dashboard (Login-Smoke)', () => {
  test('rendert auf Pixel-5-Viewport ohne horizontalen Overflow', async ({ page }) => {
    await stubAuth(page);
    await page.goto('/');
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.getByRole('button', { name: /Discord/i })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('Login-CTA erfuellt 44x44px-Touch-Target bei 320px', async ({ page }) => {
    await stubAuth(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/');
    const cta = page.getByRole('button', { name: /Discord/i });
    await expectTouchTarget(cta);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('hat Viewport-Meta, Sprache und CSP-sicheren Obsidian-Default', async ({ page }) => {
    await stubAuth(page);
    await page.goto('/');
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('width=device-width');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'de');
    await expect(html).toHaveAttribute('data-theme', 'obsidian');
    await expect(html).toHaveClass(/dark/);
  });
});

const VIEWPORTS = [
  { name: 'iPhone SE', width: 320, height: 568 },
  { name: 'Android-klein', width: 360, height: 800 },
  { name: 'iPhone X/12 mini', width: 375, height: 812 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
] as const;

test.describe('Mobile Viewport-Matrix (Login)', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} (${viewport.width}x${viewport.height}) ohne horizontalen Overflow`, async ({ page }) => {
      await stubAuth(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('#root')).not.toBeEmpty();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});

async function stubAuthenticated(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { discordId: '1', username: 'tester', avatar: null, role: 'DEVELOPER' },
      }),
    }),
  );
  await page.route('**/api/v2/dev/status', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false, eligible: true, expiresAt: null }),
    }),
  );
  await page.route('**/api/v2/bot-admin/status', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false, expiresAt: null }),
    }),
  );
  await page.route('**/api/v2/guilds', route =>
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
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} (${viewport.width}x${viewport.height}): Controls bleiben nutzbar und >=44px`, async ({ page }) => {
      await stubAuthenticated(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/servers');

      const branding = page.getByRole('link', { name: 'V-Bot' });
      const devPanel = page.getByTestId('dev-login-panel');
      const adminPanel = page.getByTestId('botadmin-login-panel');
      const themeToggle = page.getByTestId('theme-toggle');
      const densityToggle = page.getByRole('button', { name: /Dichte umschalten/i });
      const logout = page.getByRole('button', { name: 'Logout' });
      const devUnlock = page.getByRole('button', { name: 'DEV-Console entsperren' });
      const adminUnlock = page.getByRole('button', { name: 'Bot-Admin entsperren' });

      await expect(branding).toBeVisible();
      await expect(devPanel).toBeVisible();
      await expect(adminPanel).toBeVisible();
      await Promise.all([
        expectTouchTarget(branding),
        expectTouchTarget(themeToggle),
        expectTouchTarget(densityToggle),
        expectTouchTarget(logout),
        expectTouchTarget(devUnlock),
        expectTouchTarget(adminUnlock),
      ]);

      const [brandingBox, devBox, adminBox] = await Promise.all([
        branding.boundingBox(),
        devPanel.boundingBox(),
        adminPanel.boundingBox(),
      ]);
      expect(brandingBox).not.toBeNull();
      expect(devBox).not.toBeNull();
      expect(adminBox).not.toBeNull();
      expect(overlaps(brandingBox!, devBox!)).toBe(false);
      expect(overlaps(brandingBox!, adminBox!)).toBe(false);
      expect(overlaps(devBox!, adminBox!)).toBe(false);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('Dashboard Theme', () => {
  test('schaltet Obsidian/Ice und persistiert nur in der aktuellen Tab-Sitzung', async ({ page, context }) => {
    await stubAuthenticated(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/servers');

    const html = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');
    await expect(html).toHaveAttribute('data-theme', 'obsidian');
    await expect(html).toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return {
        accent: css.getPropertyValue('--color-accent').trim(),
        danger: css.getPropertyValue('--color-danger').trim(),
        onAccent: css.getPropertyValue('--color-on-accent').trim(),
      };
    })).toEqual({ accent: '210 43 58', danger: '248 113 113', onAccent: '255 255 255' });

    await toggle.click();
    await expect(html).toHaveAttribute('data-theme', 'ice');
    await expect(html).toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return {
        accent: css.getPropertyValue('--color-accent').trim(),
        danger: css.getPropertyValue('--color-danger').trim(),
        onAccent: css.getPropertyValue('--color-on-accent').trim(),
      };
    })).toEqual({ accent: '125 211 252', danger: '251 113 133', onAccent: '8 24 42' });
    expect(await page.evaluate(() => sessionStorage.getItem('ui.theme.session'))).toBe('ice');
    expect(await page.evaluate(() => localStorage.getItem('ui.theme'))).toBeNull();

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'ice');
    await expect(page.getByTestId('theme-toggle')).toBeVisible();

    const freshPage = await context.newPage();
    await stubAuthenticated(freshPage);
    await freshPage.goto('/servers');
    await expect(freshPage.locator('html')).toHaveAttribute('data-theme', 'obsidian');
    await freshPage.close();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('respektiert reduzierte Bewegung fuer Overlay und gemeinsame Buttons', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubAuth(page);
    await page.goto('/');

    const primary = page.getByRole('button', { name: /Discord/i });
    await expect(primary).toBeVisible();
    const motion = await primary.evaluate((element) => {
      const primary = element as HTMLButtonElement;
      return {
        overlayAnimation: getComputedStyle(document.body, '::before').animationName,
        transitionDurations: getComputedStyle(primary).transitionDuration.split(',').map(value => value.trim()),
      };
    });

    expect(motion.overlayAnimation).toBe('none');
    expect(motion.transitionDurations).toEqual(expect.arrayContaining(['0s']));
  });
});
