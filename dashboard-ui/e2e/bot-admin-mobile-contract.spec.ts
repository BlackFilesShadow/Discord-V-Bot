import { test, expect, type Page, type Route } from '@playwright/test';

const USER = { discordId: '437718598876268545', username: 'bot-admin-test', avatar: null, role: 'DEVELOPER' };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubBotAdmin(page: Page): Promise<void> {
  await page.route('**/api/me', route => json(route, { user: USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: USER }));
  await page.route('**/api/v2/dev/status', route => json(route, { active: false, eligible: true, expiresAt: null }));
  await page.route('**/api/v2/bot-admin/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v2/bot-admin/status') {
      return json(route, { active: true, expiresAt: '2026-08-20T12:00:00.000Z' });
    }
    if (path === '/api/v2/bot-admin/guilds') {
      return json(route, { items: [{ id: '123456789012345678', name: 'Chaos', memberCount: 42 }] });
    }
    if (path === '/api/v2/bot-admin/overview') {
      return json(route, {
        stats: {
          openAppeals: 0,
          newFeedback: 0,
          pendingValidations: 0,
          uploadEnabled: true,
          suspendedUsers: 0,
          deletedPackages: 0,
          criticalWarnings: 0,
        },
        recentBroadcasts: [],
        recentExports: [],
        recentAdminActions: [],
      });
    }
    return json(route, {});
  });
}

const VIEWPORTS = [320, 360, 375, 390, 430] as const;

for (const width of VIEWPORTS) {
  test(`Bot-Admin Subnavigation bleibt bei ${width}px touch-tauglich und overflow-frei`, async ({ page }) => {
    await stubBotAdmin(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/bot-admin');

    const nav = page.getByRole('navigation', { name: 'Bot-Admin-Bereiche' });
    await expect(nav).toBeVisible();

    const buttons = nav.getByRole('button');
    await expect(buttons).toHaveCount(15);
    for (let i = 0; i < await buttons.count(); i += 1) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
