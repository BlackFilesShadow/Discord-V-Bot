import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = 'guild-flag-e2e';
const SLOT = '1';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubFlagDashboard(page: Page) {
  let savedBody: Record<string, unknown> | null = null;
  let flagConfigs: Array<Record<string, unknown>> = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: 'flag-e2e-user', username: 'flag-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: 'flag-e2e-user', username: 'flag-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: true, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'FLAG',
        isOwner: true,
        permissions: ['dashboard.access', 'killfeed.manage'],
        slots: [{ id: 'conn-flag-e2e', slot: 1, alias: 'Chernarus', alias5: 'CHR01', status: 'ACTIVE', nitradoServerId: 'server-e2e' }],
        grantsCount: 0,
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      return json(route, {
        enabled: true,
        currencyName: 'Maeuse',
        emoji: '🐭',
        startBalance: 0,
        playtimeRewardPercent: 0,
        bankInterestPercent: 0,
        bankChannelId: null,
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) {
      return json(route, {
        channels: [
          { id: 'channel-flag-raised', name: 'flagge-hoch', type: 0, parentId: null },
          { id: 'channel-flag-lowered', name: 'flagge-runter', type: 0, parentId: null },
        ],
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/killfeed`) {
      const kind = url.searchParams.get('kind');
      if (method === 'GET') return json(route, { kind, configs: kind === 'FLAG' ? flagConfigs : [] });
      if (method === 'POST' && kind === 'FLAG') {
        savedBody = req.postDataJSON() as Record<string, unknown>;
        flagConfigs = [{
          id: 'flag-config-lowered',
          kind: 'FLAG',
          nitradoConnId: 'conn-flag-e2e',
          channelId: String(savedBody.channelId),
          isActive: true,
          categories: savedBody.categories,
          showActorCoords: savedBody.showActorCoords,
          showTargetCoords: savedBody.showTargetCoords,
          showTool: false,
          showDistance: false,
          embedColor: savedBody.embedColor,
          lastEventAt: null,
          lastPolledAt: null,
          lastErrorMsg: null,
          openDeliveryCount: 0,
          retryDeliveryCount: 0,
          failedDeliveryCount: 0,
          oldestOpenAt: null,
          lastSuccessAt: null,
          lastPlayerCount: null,
          lastPlayerListAt: null,
          playerListIntervalMinutes: null,
          nextPlayerListPostAt: null,
        }];
        return json(route, { id: 'flag-config-lowered', kind: 'FLAG' }, 201);
      }
    }

    return json(route, {});
  });

  return {
    savedBody: () => savedBody,
    flagConfigs: () => flagConfigs,
  };
}

test('Flaggen-Feed speichert Flagge runter separat mit eigenem Kanal und bleibt nach Reload sichtbar', async ({ page }) => {
  const state = await stubFlagDashboard(page);
  await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=killfeed`);

  await page.getByRole('button', { name: '🚩 Flaggen-Feed' }).click();
  await expect(page.getByText('Flagge hoch', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Flagge runter', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('🔎 Kurz-Online prüfen', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Neu' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('🚩 Flaggen-Feed konfigurieren')).toBeVisible();
  await dialog.getByLabel('Discord-Channel').selectOption('channel-flag-lowered');
  await dialog.getByLabel('Flagge runter').check();
  await dialog.getByRole('button', { name: 'Speichern' }).click();

  await expect.poll(state.savedBody).not.toBeNull();
  expect(state.savedBody()).toMatchObject({
    channelId: 'channel-flag-lowered',
    categories: ['LOWERED'],
    showActorCoords: true,
    showTargetCoords: true,
    showTool: false,
    showDistance: false,
    isActive: true,
  });

  await expect(page.getByText('#flagge-runter')).toBeVisible();
  await expect(page.getByText('🏳️ Flagge runter')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: '🚩 Flaggen-Feed' }).click();
  await expect(page.getByText('#flagge-runter')).toBeVisible();
  expect(state.flagConfigs()).toHaveLength(1);
});
