import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const CONNECTION_ID = 'c123456789012345678901234';
const CHANNEL_ID = '523456789012345678';
const ROLE_ID = '623456789012345678';

interface Mutation { method: string; path: string; query: string; body: unknown }

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubRadar(page: Page): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  let zones: Array<Record<string, unknown>> = [];
  await page.route('**/api/me', route => json(route, { user: { discordId: '437718598876268545', username: 'radar-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: { discordId: '437718598876268545', username: 'radar-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/api/v2/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: true, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      guildId: GUILD_ID, alias5: 'CHAOS', isOwner: true, permissions: ['dashboard.access', 'radar.manage'], grantsCount: 0,
      slots: [{ id: CONNECTION_ID, slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE' }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, { enabled: false, currencyName: 'Maeuse', emoji: 'M', startBalance: 0, playtimeRewardPercent: 0, bankInterestPercent: 0, bankChannelId: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [{ id: CHANNEL_ID, name: 'radar', type: 0 }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/roles`) return json(route, { roles: [{ id: ROLE_ID, name: 'Wache', managed: false }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/config`) return json(route, { activeMap: 'CHERNARUS', nitradoConnId: CONNECTION_ID });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/functions`) return json(route, { functions: [{ key: 'PLAYER_DETECTION', label: 'Spieler-Erkennung', order: 10, defaultEnabled: true, sourceEvents: ['PLAYER_POSITION'] }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && method === 'GET') return json(route, { zones });
    if (method !== 'GET') {
      let body: unknown = null;
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
      mutations.push({ method, path, query: url.search, body });
      if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && method === 'POST') {
        const draft = body as Record<string, unknown>;
        zones = [{ ...draft, id: 'radar-zone-1', version: 1 }];
        return json(route, { zone: zones[0] }, 201);
      }
    }
    return json(route, {});
  });
  return mutations;
}

function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe('Authenticated Radar', () => {
  test('rendert die lokale Basemap, bearbeitet per Klick und speichert im exakten Slot-Scope', async ({ page }) => {
    const mutations = await stubRadar(page);
    const image = page.waitForResponse(response => response.url().endsWith('/radar/maps/chernarus.png') && response.status() === 200);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await expect(page.getByRole('heading', { name: 'Radar-Karte' })).toBeVisible();
    await expect(page.locator('.maplibregl-canvas').first()).toBeVisible();
    await image;

    await page.getByRole('button', { name: 'Zone', exact: true }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await expect(editor.getByLabel('DayZ Radar-Karte')).toBeVisible();
    await editor.getByLabel('DayZ Radar-Karte').click({ position: { x: 150, y: 150 } });
    await expect(editor.getByLabel('Zonenname')).toBeVisible();
    await editor.getByLabel('Zonenname').fill('Nordtor');
    await editor.locator('select').filter({ has: page.locator('option[value="523456789012345678"]') }).selectOption(CHANNEL_ID);
    await editor.getByRole('switch', { name: 'Rollen-Ping' }).click();
    await editor.getByRole('button', { name: 'Speichern' }).click();

    await expect.poll(() => mutations.find(row => row.method === 'POST' && row.path.endsWith('/radar/zones'))).toBeTruthy();
    expect(mutations.find(row => row.method === 'POST' && row.path.endsWith('/radar/zones'))).toMatchObject({
      query: `?slot=${SLOT}`,
      body: expect.objectContaining({ name: 'Nordtor', map: 'CHERNARUS', channelId: CHANNEL_ID }),
    });
  });

  for (const width of [320, 360, 375, 390, 430] as const) {
    test(`${width}px bleibt ohne horizontalen Overflow`, async ({ page }) => {
      await stubRadar(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
      await expect(page.getByRole('heading', { name: 'Radar-Karte' })).toBeVisible();
      await expect(overflow(page)).resolves.toBeLessThanOrEqual(1);
    });
  }
});