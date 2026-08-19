import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const OTHER_SLOT = '2';
const USER_ID = '437718598876268545';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface SettingsPatch {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

async function stubSettings(page: Page) {
  const patches: SettingsPatch[] = [];
  let state = { whitelistActive: true, economyActive: false, permaOnly: false };

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'settings-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'settings-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path === '/api/v2/dev/status') {
      await json(route, { active: false, eligible: true, expiresAt: null });
      return;
    }
    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      await json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: true,
        permissions: ['dashboard.access'],
        slots: [
          { id: 'conn-settings-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE', nitradoServerId: '12345' },
          { id: 'conn-settings-2', slot: 2, alias: 'Livonia', alias5: 'LI002', status: 'ACTIVE', nitradoServerId: '67890' },
        ],
        grantsCount: 0,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON() as Record<string, unknown>;
        patches.push({ path, method: req.method(), body });
        state = { ...state, ...body } as typeof state;
        await json(route, { ok: true });
      } else {
        await json(route, state);
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${OTHER_SLOT}/settings`) {
      await json(route, { whitelistActive: false, economyActive: true, permaOnly: true });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      await json(route, {
        enabled: false,
        currencyName: 'Maeuse',
        emoji: '🐭',
        startBalance: 0,
        playtimeRewardPercent: 0,
        bankInterestPercent: 0,
        bankChannelId: null,
      });
      return;
    }

    await json(route, {});
  });

  return { patches };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectLatestPatch(patches: SettingsPatch[], expected: Record<string, unknown>): Promise<void> {
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  const latest = patches.at(-1);
  expect(latest).toEqual({
    path: `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`,
    method: 'PATCH',
    body: expected,
  });
}

test.describe('Dashboard settings authenticated action matrix', () => {
  test('alle drei Toggles mutieren jeweils nur ihr eigenes Feld im exakten Guild+Slot-Scope', async ({ page }) => {
    const { patches } = await stubSettings(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);

    await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(3);

    await switches.nth(0).click();
    await expectLatestPatch(patches, { whitelistActive: false });

    await switches.nth(1).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({
      path: `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`,
      method: 'PATCH',
      body: { economyActive: true },
    });

    await switches.nth(2).click();
    await expect.poll(() => patches.length).toBe(3);
    expect(patches[2]).toEqual({
      path: `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`,
      method: 'PATCH',
      body: { permaOnly: true },
    });

    expect(patches.every(write => !write.path.includes(`/server/${OTHER_SLOT}/`))).toBe(true);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`${width}px: Settings-Toggles bleiben bedienbar und ohne Seiten-Overflow`, async ({ page }) => {
      const { patches } = await stubSettings(page);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);

      await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
      const economySwitch = page.getByRole('switch').nth(1);
      await expect(economySwitch).toBeVisible();
      await economySwitch.click();
      await expectLatestPatch(patches, { economyActive: true });
      await expectNoHorizontalOverflow(page);
    });
  }
});
