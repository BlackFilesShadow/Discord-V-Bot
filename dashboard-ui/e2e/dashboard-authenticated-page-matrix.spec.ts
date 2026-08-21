import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAuthenticatedDashboard(page: Page) {
  let settingsPatch: Record<string, unknown> | null = null;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'dashboard-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'dashboard-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') {
      await json(route, { active: false, eligible: true, expiresAt: null });
      return;
    }
    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === '/api/v2/guilds') {
      await json(route, {
        guilds: [{
          id: GUILD_ID,
          name: 'Die Chaoten',
          iconUrl: null,
          memberCount: 42,
          botPresent: true,
          alias5: 'CHAOS',
          isOwner: true,
        }],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      await json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: true,
        permissions: ['dashboard.access'],
        slots: [{ id: 'conn-dashboard-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE', nitradoServerId: '12345' }],
        grantsCount: 0,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      if (method === 'PATCH') {
        settingsPatch = req.postDataJSON() as Record<string, unknown>;
        await json(route, { ok: true });
      } else {
        await json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      await json(route, {
        enabled: true,
        currencyName: 'Maeuse',
        emoji: '🐭',
        startBalance: 500,
        playtimeRewardPercent: 2,
        bankInterestPercent: 3,
        bankChannelId: null,
      });
      return;
    }

    await json(route, {});
  });

  return { settingsPatch: () => settingsPatch };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Dashboard authenticated page matrix', () => {
  test('Serverliste rendert authentifizierten Guild-Zugriff und Navigation', async ({ page }) => {
    await stubAuthenticatedDashboard(page);
    await page.goto('/servers');

    await expect(page.getByRole('heading', { name: 'Deine Server' })).toBeVisible();
    await expect(page.getByText('Die Chaoten')).toBeVisible();
    await expect(page.getByText('42 Mitglieder')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verwalten' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('Guild-Dashboard rendert Nitrado-Scope mit kanonischem Slot', async ({ page }) => {
    await stubAuthenticatedDashboard(page);
    await page.goto(`/servers/${GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'CHAOS' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nitrado-Slots (1/5)' })).toBeVisible();
    await expect(page.getByText('Chernarus')).toBeVisible();
    await expect(page.getByText('Nitrado-Service: 12345')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('Slot-Settings sind authentifiziert, scoped und mutieren nur den gewählten Slot', async ({ page }) => {
    const writes = await stubAuthenticatedDashboard(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);

    await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
    await expect(page.getByText('Whitelist aktiv')).toBeVisible();
    await expect(page.getByText('Economy aktiv')).toBeVisible();
    await expect(page.getByText('Perma-Only Modus')).toBeVisible();

    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(3);
    await switches.nth(0).click();
    await expect.poll(writes.settingsPatch).not.toBeNull();
    expect(writes.settingsPatch()).toEqual({ whitelistActive: false });
    await expectNoHorizontalOverflow(page);
  });
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

const AUTHENTICATED_ROUTES = [
  { path: '/servers', marker: 'Deine Server' },
  { path: `/servers/${GUILD_ID}`, marker: 'Nitrado-Slots (1/5)' },
  { path: `/servers/${GUILD_ID}/server/${SLOT}?tab=settings`, marker: 'Server-Toggles' },
] as const;

test.describe('Authenticated mobile viewport matrix', () => {
  for (const viewport of VIEWPORTS) {
    for (const route of AUTHENTICATED_ROUTES) {
      test(`${viewport.width}px ${route.path} bleibt ohne horizontalen Overflow`, async ({ page }) => {
        await stubAuthenticatedDashboard(page);
        await page.setViewportSize(viewport);
        await page.goto(route.path);
        await expect(page.getByText(route.marker, { exact: false }).first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    }
  }
});

/** Stage 30: desktop completion baseline (1280x800). */
test.describe('Desktop 1280 completion', () => {
  const desktop = { width: 1280, height: 800 } as const;
  for (const route of AUTHENTICATED_ROUTES) {
    test(`desktop ${route.path} marker + no horizontal overflow`, async ({ page }) => {
      await stubAuthenticatedDashboard(page);
      await page.setViewportSize(desktop);
      await page.goto(route.path);
      await expect(page.getByText(route.marker, { exact: false }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    });
  }
});
