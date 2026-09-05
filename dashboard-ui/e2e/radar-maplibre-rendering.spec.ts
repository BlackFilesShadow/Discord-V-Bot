import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const CONNECTION_ID = 'c123456789012345678901234';
const CHANNEL_ID = '523456789012345678';
const USER_DISCORD_ID = 'radar-render-e2e-user';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubRadar(page: Page): Promise<void> {
  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_DISCORD_ID, username: 'radar-render-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_DISCORD_ID, username: 'radar-render-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/api/v2/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

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
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      return json(route, { enabled: false, currencyName: 'Maeuse', emoji: 'M', startBalance: 0, playtimeRewardPercent: 0, bankInterestPercent: 0, bankChannelId: null });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) {
      return json(route, { channels: [{ id: CHANNEL_ID, name: 'radar', type: 0 }] });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/roles`) return json(route, { roles: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/config`) {
      return json(route, { activeMap: 'CHERNARUS', nitradoConnId: CONNECTION_ID });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/functions`) {
      return json(route, { functions: [{ key: 'PLAYER_DETECTION', label: 'Spieler-Erkennung', order: 10, defaultEnabled: true, sourceEvents: ['PLAYER_POSITION'] }] });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/players`) return json(route, { players: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/radar/zones` && request.method() === 'GET') return json(route, { zones: [] });
    return json(route, {});
  });
}

test.describe('Radar MapLibre GeoJSON rendering', () => {
  test('die geschlossene Polygonflaeche ist wirklich gerendert und per Flaechen-Drag interaktiv', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-chrome', 'Dieser Rendervertrag verwendet explizite Desktop-Mausgesten.');
    await stubRadar(page);

    let workerResponse: { status: number; contentType: string } | undefined;
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!pathname.endsWith('/maplibre-gl-worker.mjs')) return;
      workerResponse = {
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
      };
    });

    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=radar`);
    await page.getByRole('button', { name: 'Zone', exact: true }).click();
    const editor = page.getByLabel('Radar-Zoneneditor');
    await editor.getByRole('button', { name: 'Polygon' }).click();

    await expect.poll(() => workerResponse).toMatchObject({ status: 200 });
    expect(workerResponse?.contentType).toMatch(/javascript|ecmascript/i);
    expect(workerResponse?.contentType).not.toContain('text/html');

    const map = editor.getByLabel('DayZ Radar-Karte');
    await map.scrollIntoViewIfNeeded();
    const box = await map.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await map.click({ position: { x: 120, y: 120 } });
    await map.click({ position: { x: 240, y: 120 } });
    await map.click({ position: { x: 180, y: 240 } });
    await expect(editor.locator('.radar-zone-close-handle')).toHaveCount(1);
    await editor.locator('.radar-zone-close-handle').click();
    await expect(editor.locator('[data-radar-interaction-mode]')).toHaveAttribute('data-radar-interaction-mode', 'POLYGON_EDIT');

    const before = await editor.locator('ol li').allTextContents();
    expect(before).toHaveLength(3);

    // Punkt innerhalb des Dreiecks. Der mousedown-Handler ist direkt an die
    // MapLibre-Fill-Layer gebunden. Ist die GeoJSON-Layer unsichtbar/nicht
    // gerendert, greift hier nur das normale Map-Panning und die Zonengeometrie
    // bleibt unveraendert. Damit prueft dieser Test den echten Renderpfad statt
    // nur die separat gerenderten DOM-Handles.
    await page.mouse.move(box.x + 180, box.y + 165);
    await page.mouse.down();
    await page.mouse.move(box.x + 210, box.y + 190, { steps: 5 });
    await page.mouse.up();

    await expect.poll(async () => editor.locator('ol li').allTextContents()).not.toEqual(before);
    const after = await editor.locator('ol li').allTextContents();
    expect(after).toHaveLength(3);
    expect(after.every((value, index) => value !== before[index])).toBe(true);
  });
});
