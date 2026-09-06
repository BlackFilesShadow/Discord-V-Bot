import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const CONNECTION_ID = 'c123456789012345678901234';
const CHANNEL_ID = '523456789012345678';
const ROLE_ID = '623456789012345678';
const USER_DISCORD_ID = 'radar-e2e-user';

interface Mutation { method: string; path: string; query: string; body: unknown }

const FUNCTIONS = [
  { key: 'PLAYER_DETECTION', label: 'Spieler-Erkennung', order: 10, defaultEnabled: true, punitive: false, sourceEvents: ['PLAYER_POSITION'] },
  { key: 'BAN_PLAYER_DETECTION', label: 'Bann bei Spieler-Erkennung', order: 20, defaultEnabled: false, punitive: true, sourceEvents: ['PLAYER_POSITION'] },
  { key: 'BAN_PLACEMENT', label: 'Bann bei Platzierung', order: 30, defaultEnabled: false, punitive: true, sourceEvents: ['PLACEMENT'] },
  { key: 'BAN_BUILD', label: 'Bann bei Bauen', order: 40, defaultEnabled: false, punitive: true, sourceEvents: ['BUILD'] },
  { key: 'BAN_DISMANTLE', label: 'Bann bei Demontage', order: 50, defaultEnabled: false, punitive: true, sourceEvents: ['DISMANTLE'] },
  { key: 'BAN_DESTROY', label: 'Bann bei Zerstörung', order: 60, defaultEnabled: false, punitive: true, sourceEvents: ['DESTROY'] },
  { key: 'BAN_FLAG', label: 'Bann bei Flagge hoch/runter', order: 70, defaultEnabled: false, punitive: true, sourceEvents: ['UNKNOWN'] },
  { key: 'BAN_DISCONNECT', label: 'Bann bei Disconnect', order: 80, defaultEnabled: false, punitive: true, sourceEvents: ['PLAYER_DISCONNECTED'] },
  { key: 'BAN_HIT', label: 'Bann bei Hit', order: 90, defaultEnabled: false, punitive: true, sourceEvents: ['PLAYER_HIT'] },
  { key: 'BAN_KILL', label: 'Bann bei Kill', order: 100, defaultEnabled: false, punitive: true, sourceEvents: ['PLAYER_KILLED'] },
  { key: 'BAN_EXPLOSION', label: 'Bann bei Explosion', order: 110, defaultEnabled: false, punitive: true, sourceEvents: ['PLAYER_HIT', 'PLAYER_KILLED'] },
];

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubRadar(page: Page, initialZones: Array<Record<string, unknown>> = []): Promise<Mutation[]> {
  const mutations: Mutation[] = [];
  let zones: Array<Record<string, unknown>> = [...initialZones];
  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_DISCORD_ID, username: 'radar-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_DISCORD_ID, username: 'radar-e2e', avatar: null, role: 'DEVELOPER' },
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
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, {
      whitelistActive: true, economyActive: true, permaOnly: false,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      enabled: false, currencyName: 'Maeuse', emoji: 'M', startBalance: 0,
      playtimeRewardPercent: 0, bankInterestPercent: 0, bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, {
      channels: [{ id: CHANNEL_ID, name: 'radar', type: 0 }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/roles`) return json(route, {
      roles: [{ id: ROLE_ID, name: 'Wache', managed: false }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/config`) return json(route, {
      activeMap: 'CHERNARUS', nitradoConnId: CONNECTION_ID,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/functions`) return json(route, { functions: FUNCTIONS });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/players`) return json(route, {
      players: [{ gameId: 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=', playerName: 'XboxWache' }],
    });
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
  test('rendert HD-Hybrid X/Z, speichert Kreis und sendet nur die neuen Policy-Felder', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome', 'Desktop-Mausvertrag.');
    const mutations = await stubRadar(page);
    const image = page.waitForResponse(response => response.url().endsWith('/radar/maps/chernarus.png') && response.status() === 200);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await expect(page.getByText('HD Hybrid · X/Z')).toBeVisible();
    await expect(page.locator('.maplibregl-canvas').first()).toBeVisible();
    await image;

    await page.getByRole('button', { name: 'Zone', exact: true }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await expect(editor.getByText('Geometrie X/Z')).toBeVisible();
    await expect(editor.getByText('Höhenbegrenzung')).toHaveCount(0);
    await expect(editor.getByText('Automatischer Server-Ban')).toHaveCount(0);
    await expect(editor.getByRole('switch', { name: 'Bann bei Explosion' })).toBeVisible();

    const map = editor.getByLabel('DayZ Radar-Karte');
    const mapShell = editor.locator('[data-radar-interaction-mode]');
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
    await expect(editor.getByLabel('Mittelpunkt X')).toBeVisible();
    await expect(editor.getByLabel('Mittelpunkt Z')).toBeVisible();
    await editor.getByLabel('Kreisradius in Metern').fill('275');
    await editor.getByLabel('Zonenname').fill('Nordtor');
    await editor.locator('select').filter({ has: page.locator(`option[value="${CHANNEL_ID}"]`) }).selectOption(CHANNEL_ID);
    await editor.getByRole('switch', { name: 'Bann bei Bauen' }).check();
    await editor.getByRole('button', { name: 'Speichern' }).click();

    await expect.poll(() => mutations.find(row => row.method === 'POST' && row.path.endsWith('/radar/zones'))).toBeTruthy();
    const mutation = mutations.find(row => row.method === 'POST' && row.path.endsWith('/radar/zones'));
    expect(mutation).toMatchObject({
      query: `?slot=${SLOT}`,
      body: expect.objectContaining({
        name: 'Nordtor',
        map: 'CHERNARUS',
        channelId: CHANNEL_ID,
        enabledFunctions: expect.arrayContaining(['PLAYER_DETECTION', 'BAN_BUILD']),
      }),
    });
    expect(mutation?.body).not.toEqual(expect.objectContaining({ autoBanEnabled: expect.anything() }));
    expect(mutation?.body).not.toEqual(expect.objectContaining({ altitudeEnabled: expect.anything() }));
  });

  test('haelt ein Polygon bis zum bewussten Klick auf den ersten Punkt offen und nutzt X/Z-Felder', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome', 'Desktop-Mausvertrag.');
    await stubRadar(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await page.getByRole('button', { name: 'Zone', exact: true }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await editor.getByRole('button', { name: 'Polygon' }).click();
    await expect(editor.getByLabel('Polygon X')).toBeVisible();
    await expect(editor.getByLabel('Polygon Z')).toBeVisible();
    const map = editor.getByLabel('DayZ Radar-Karte');
    const mapShell = editor.locator('[data-radar-interaction-mode]');
    await map.scrollIntoViewIfNeeded();
    await map.click({ position: { x: 120, y: 120 } });
    await map.click({ position: { x: 220, y: 120 } });
    await map.click({ position: { x: 180, y: 220 } });
    await expect(editor.getByText('3 Punkte gesetzt')).toBeVisible();
    await expect(mapShell).toHaveAttribute('data-radar-polygon-open', 'true');
    await expect(editor.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await editor.locator('.radar-zone-close-handle').click();
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'POLYGON_EDIT');
    await expect(editor.locator('.radar-zone-insert-handle')).toHaveCount(3);
  });

  test('laedt ein gespeichertes Polygon direkt geschlossen und vollstaendig bearbeitbar', async ({ page }) => {
    const savedZone = {
      id: 'saved-polygon',
      version: 4,
      name: 'Tisy',
      map: 'CHERNARUS',
      isActive: true,
      channelId: CHANNEL_ID,
      rolePingEnabled: false,
      roleIds: [],
      embedColor: '#dc2626',
      enabledFunctions: ['PLAYER_DETECTION'],
      allowlist: [],
      geometry: {
        type: 'POLYGON',
        points: [{ x: 4000, y: 4000 }, { x: 5000, y: 4000 }, { x: 4700, y: 5000 }],
      },
    };
    await stubRadar(page, [savedZone]);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await page.getByRole('button', { name: 'Tisy bearbeiten' }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await expect(editor).toBeVisible();
    const mapShell = editor.locator('[data-radar-interaction-mode]');
    await expect(mapShell).toHaveAttribute('data-radar-interaction-mode', 'POLYGON_EDIT');
    await expect(editor.locator('.radar-zone-close-handle')).toHaveCount(0);
    await expect(editor.locator('.radar-zone-point')).toHaveCount(3);
    await expect(editor.locator('.radar-zone-insert-handle')).toHaveCount(3);
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
