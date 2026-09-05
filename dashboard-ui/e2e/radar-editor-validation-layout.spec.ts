import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const CONNECTION_ID = 'c123456789012345678901234';
const CHANNEL_ID = '523456789012345678';
const USER_DISCORD_ID = 'radar-layout-e2e-user';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubRadar(page: Page): Promise<Array<{ method: string; path: string }>> {
  const mutations: Array<{ method: string; path: string }> = [];
  const functions = Array.from({ length: 6 }, (_, index) => ({
    key: `RADAR_TEST_${index + 1}`,
    label: `Radar-Funktion ${index + 1}`,
    order: (index + 1) * 10,
    defaultEnabled: index === 0,
    sourceEvents: ['PLAYER_POSITION'],
  }));

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_DISCORD_ID, username: 'radar-layout-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_DISCORD_ID, username: 'radar-layout-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/api/v2/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: true, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      guildId: GUILD_ID,
      alias5: 'CHAOS',
      isOwner: true,
      permissions: ['dashboard.access', 'radar.manage'],
      grantsCount: 0,
      slots: [{ id: CONNECTION_ID, slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE' }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, { enabled: false, currencyName: 'Maeuse', emoji: 'M', startBalance: 0, playtimeRewardPercent: 0, bankInterestPercent: 0, bankChannelId: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [{ id: CHANNEL_ID, name: 'radar', type: 0 }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/roles`) return json(route, { roles: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/config`) return json(route, { activeMap: 'CHERNARUS', nitradoConnId: CONNECTION_ID });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/functions`) return json(route, { functions });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/players`) return json(route, { players: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && method === 'GET') return json(route, { zones: [] });

    if (method !== 'GET') mutations.push({ method, path });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && method === 'POST') {
      return json(route, { error: 'Simulierter Speicherfehler.' }, 400);
    }
    return json(route, {});
  });

  return mutations;
}

test.describe('Radar editor validation and layout', () => {
  test('verhindert unvollständige Saves, bleibt bei API-Fehlern offen und quetscht Controls nicht zusammen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome', 'Desktop-Vertrag für Control-Größen und Maus-Geometrie.');
    await page.setViewportSize({ width: 1280, height: 1000 });
    const mutations = await stubRadar(page);

    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);

    const zoneButton = page.getByRole('button', { name: 'Zone', exact: true });
    const zoneButtonBox = await zoneButton.boundingBox();
    expect(zoneButtonBox?.height ?? 0).toBeGreaterThanOrEqual(40);

    const functionCards = page.getByLabel('Radar-Funktionen').locator(':scope > div');
    await expect(functionCards).toHaveCount(6);
    const widths = await functionCards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(170);

    await zoneButton.click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await expect(editor).toBeVisible();

    const save = editor.getByRole('button', { name: 'Speichern' });
    const saveBox = await save.boundingBox();
    expect(saveBox?.height ?? 0).toBeGreaterThanOrEqual(40);
    await expect(save).toBeDisabled();
    await expect(editor.getByText('Schließe die Geometrie auf der Karte ab', { exact: false })).toBeVisible();

    const map = editor.getByLabel('DayZ Radar-Karte');
    await map.scrollIntoViewIfNeeded();
    const mapBox = await map.boundingBox();
    expect(mapBox).not.toBeNull();
    if (mapBox) {
      await page.mouse.move(mapBox.x + 160, mapBox.y + 160);
      await page.mouse.down();
      await page.mouse.move(mapBox.x + 280, mapBox.y + 235, { steps: 5 });
      await page.mouse.up();
    }
    await expect(save).toBeEnabled();

    await save.click();
    await expect(editor.getByRole('alert')).toHaveText('Bitte gib einen Zonenname ein.');
    expect(mutations.filter(row => row.path.endsWith('/radar/zones') && row.method === 'POST')).toHaveLength(0);

    await editor.getByLabel('Zonenname').fill('Nordtor');
    await save.click();
    await expect(editor.getByRole('alert')).toHaveText('Bitte wähle einen Discord-Kanal für die Radar-Ausgabe.');
    expect(mutations.filter(row => row.path.endsWith('/radar/zones') && row.method === 'POST')).toHaveLength(0);

    await editor.getByLabel('Radar-Kanal').selectOption(CHANNEL_ID);
    await save.click();
    await expect(page.getByRole('heading', { name: 'Neue Radar-Zone' })).toBeVisible();
    await expect(editor).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Simulierter Speicherfehler.' })).toBeVisible();
    expect(mutations.filter(row => row.path.endsWith('/radar/zones') && row.method === 'POST')).toHaveLength(1);
  });
});
