import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const CONNECTION_ID = 'c123456789012345678901234';
const CHANNEL_ID = '523456789012345678';
const ROLE_ID = '623456789012345678';
const USER_DISCORD_ID = 'radar-e2e-user';

interface Mutation { method: string; path: string; query: string; body: unknown }

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubRadar(page: Page, initialZones: Array<Record<string, unknown>> = []): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  let zones: Array<Record<string, unknown>> = [...initialZones];
  await page.route('**/api/me', route => json(route, { user: { discordId: USER_DISCORD_ID, username: 'radar-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: { discordId: USER_DISCORD_ID, username: 'radar-e2e', avatar: null, role: 'DEVELOPER' } }));
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
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/players`) return json(route, { players: [{ gameId: 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=', playerName: 'XboxWache' }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && method === 'GET') return json(route, { zones });
    if (path.startsWith(`/api/v2/guilds/${GUILD_ID}/radar/zones/`) && method === 'GET') {
      const zoneId = path.split('/').at(-1);
      const zone = zones.find(item => item.id === zoneId);
      return zone ? json(route, { zone }) : json(route, { error: 'not found' }, 404);
    }
    if (method !== 'GET') {
      let body: unknown = null;
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
      mutations.push({ method, path, query: url.search, body });
      if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && method === 'POST') {
        const draft = body as Record<string, unknown>;
        zones = [{ ...draft, id: 'radar-zone-1', version: 1 }];
        return json(route, { zone: zones[0] }, 201);
      }
      if (path.startsWith(`/api/v2/guilds/${GUILD_ID}/radar/zones/`) && method === 'PUT') {
        const zoneId = path.split('/').at(-1);
        const draft = body as Record<string, unknown>;
        const existing = zones.find(item => item.id === zoneId);
        const updated = { ...existing, ...draft, id: zoneId, version: Number(existing?.version ?? 0) + 1 };
        zones = zones.map(item => item.id === zoneId ? updated : item);
        return json(route, { zone: updated });
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
  test('rendert die lokale Basemap, zieht einen stabilen Kreis und speichert im exakten Slot-Scope', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome', 'Dieser Vertrag simuliert explizit eine Desktop-Maus. Mobile Rendering- und Layout-Verträge werden separat geprüft.');
    const mutations = await stubRadar(page);
    const image = page.waitForResponse(response => response.url().endsWith('/radar/maps/chernarus.png') && response.status() === 200);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await expect(page.getByRole('heading', { name: 'Radar-Karte' })).toBeVisible();
    await expect(page.locator('.maplibregl-canvas').first()).toBeVisible();
    await image;

    await page.getByRole('button', { name: 'Zone', exact: true }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await expect(editor.getByLabel('DayZ Radar-Karte')).toBeVisible();
    const map = editor.getByLabel('DayZ Radar-Karte');
    const mapShell = editor.locator('[data-radar-interaction-mode]');
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'CIRCLE_CREATE');
    await map.scrollIntoViewIfNeeded();
    const mapBox = await map.boundingBox();
    expect(mapBox).not.toBeNull();
    if (mapBox) {
      await page.mouse.move(mapBox.x + 150, mapBox.y + 150);
      await page.mouse.down();
      await page.mouse.move(mapBox.x + 300, mapBox.y + 250, { steps: 5 });
      await page.mouse.up();
    }
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'CIRCLE_EDIT');
    await expect(editor.locator('.radar-zone-point')).toHaveCount(1);
    const centerX = await editor.getByLabel('Mittelpunkt X').inputValue();
    const centerY = await editor.getByLabel('Mittelpunkt Y').inputValue();
    const radiusHandle = editor.locator('.radar-zone-radius-handle');
    await expect(radiusHandle).toBeVisible();
    const handleBox = await radiusHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (handleBox) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 50, handleBox.y + 35, { steps: 5 });
      await expect(radiusHandle).toHaveCount(1);
      await page.mouse.up();
    }
    await expect(editor.getByLabel('Mittelpunkt X')).toHaveValue(centerX);
    await expect(editor.getByLabel('Mittelpunkt Y')).toHaveValue(centerY);
    await expect(editor.getByText(/^Kreisradius \d+ m$/)).not.toHaveText('Kreisradius 100 m');
    await editor.getByLabel('Kreisradius in Metern').fill('275');
    await expect(editor.getByText('Kreisradius 275 m')).toBeVisible();
    await editor.getByLabel('Bekannten Spieler auswählen').selectOption('K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=');
    await editor.getByRole('button', { name: 'Ausgewählten Spieler zur Allowlist hinzufügen' }).click();
    await expect(editor.getByText('XboxWache ·', { exact: false })).toBeVisible();
    await editor.getByLabel('Zonenname').fill('Nordtor');
    await editor.locator('select').filter({ has: page.locator('option[value="523456789012345678"]') }).selectOption(CHANNEL_ID);
    await expect(editor.getByRole('switch', { name: 'Rollen-Ping' })).not.toBeChecked();
    await editor.getByRole('button', { name: 'Speichern' }).click();

    await expect.poll(() => mutations.find(row => row.method === 'POST' && row.path.endsWith('/radar/zones'))).toBeTruthy();
    expect(mutations.find(row => row.method === 'POST' && row.path.endsWith('/radar/zones'))).toMatchObject({
      query: `?slot=${SLOT}`,
      body: expect.objectContaining({ name: 'Nordtor', map: 'CHERNARUS', channelId: CHANNEL_ID, rolePingEnabled: false, allowlist: [{ source: 'MANUAL', gameId: 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=', playerName: 'XboxWache' }] }),
    });
  });

  test('hält ein Polygon bis zum bewussten Klick auf den ersten Punkt offen und verfeinert es danach', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome', 'Dieser Vertrag simuliert explizit Desktop-Maus-Drag auf MapLibre-Markern. Mobile Rendering- und Layout-Verträge werden separat geprüft.');
    await stubRadar(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await page.getByRole('button', { name: 'Zone', exact: true }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await editor.getByRole('button', { name: 'Polygon' }).click();
    const map = editor.getByLabel('DayZ Radar-Karte');
    const mapShell = editor.locator('[data-radar-interaction-mode]');
    await map.scrollIntoViewIfNeeded();
    await map.click({ position: { x: 120, y: 120 } });
    await map.click({ position: { x: 220, y: 120 } });
    await map.click({ position: { x: 180, y: 220 } });
    await expect(editor.getByText('3 Punkte gesetzt')).toBeVisible();
    await expect(editor.locator('.radar-zone-point')).toHaveCount(3);
    await expect(editor.locator('.radar-zone-close-handle')).toHaveCount(1);
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'POLYGON_DRAW');
    await expect(mapShell).toHaveAttribute('data-radar-polygon-open', 'true');
    await expect(editor.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await expect(editor.locator('ol li')).toHaveCount(3);

    await editor.locator('.radar-zone-close-handle').click();
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'POLYGON_EDIT');
    await expect(mapShell).toHaveAttribute('data-radar-polygon-open', 'false');
    await expect(editor.getByText('Ziehe rote Eckpunkte zum Bearbeiten', { exact: false })).toBeVisible();
    await expect(editor.locator('.radar-zone-insert-handle')).toHaveCount(3);

    const beforeVertex = await editor.locator('ol li').nth(1).textContent();
    const vertex = editor.locator('.radar-zone-point').nth(1);
    const vertexBox = await vertex.boundingBox();
    expect(vertexBox).not.toBeNull();
    if (vertexBox) {
      await page.mouse.move(vertexBox.x + vertexBox.width / 2, vertexBox.y + vertexBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(vertexBox.x + 30, vertexBox.y + 20, { steps: 4 });
      await page.mouse.up();
    }
    await expect(editor.locator('ol li').nth(1)).not.toHaveText(beforeVertex ?? '');

    const insertHandle = editor.locator('.radar-zone-insert-handle').first();
    const insertBox = await insertHandle.boundingBox();
    expect(insertBox).not.toBeNull();
    if (insertBox) {
      await page.mouse.move(insertBox.x + insertBox.width / 2, insertBox.y + insertBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(insertBox.x + 15, insertBox.y + 15, { steps: 3 });
      await page.mouse.up();
    }
    await expect(editor.locator('ol li')).toHaveCount(4);
    await expect(editor.getByRole('button', { name: 'Polygonpunkt 1 entfernen' })).toBeEnabled();
  });

  test('lädt ein gespeichertes Polygon direkt geschlossen und vollständig bearbeitbar', async ({ page }) => {
    const savedZone = {
      id: 'saved-polygon', version: 4, name: 'Tisy', map: 'CHERNARUS', isActive: true,
      channelId: CHANNEL_ID, rolePingEnabled: false, roleIds: [], embedColor: '#dc2626', enabledFunctions: ['PLAYER_DETECTION'], allowlist: [],
      geometry: { type: 'POLYGON', points: [{ x: 4000, y: 4000 }, { x: 5000, y: 4000 }, { x: 4700, y: 5000 }] },
    };
    await stubRadar(page, [savedZone]);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await page.getByRole('button', { name: 'Tisy bearbeiten' }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await expect(editor).toBeVisible();
    const mapShell = editor.locator('[data-radar-interaction-mode]');
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'POLYGON_EDIT');
    await expect(mapShell).toHaveAttribute('data-radar-polygon-open', 'false');
    await expect(editor.locator('.radar-zone-close-handle')).toHaveCount(0);
    await expect(editor.locator('.radar-zone-point')).toHaveCount(3);
    await expect(editor.locator('.radar-zone-insert-handle')).toHaveCount(3);
    await expect(editor.getByRole('button', { name: 'Speichern' })).toBeEnabled();
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
