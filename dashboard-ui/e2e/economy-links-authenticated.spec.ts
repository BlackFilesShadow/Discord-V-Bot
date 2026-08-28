import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';
const LINKED_USER = '223456789012345678';
const NEW_USER = '323456789012345678';
const LINKED_PLAYER = 'Void__Architect';
const LINKED_GAME_ID = 'dayz-guid-abc-123';
const NEW_PLAYER = 'Fresh_Player';

interface Mutation { method: string; path: string; query: string; body: unknown }

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stub(page: Page, forceFailure = false) {
  const mutations: Mutation[] = [];
  await page.route('**/api/me', route => json(route, { user: { discordId: USER_ID, username: 'links-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: { discordId: USER_ID, username: 'links-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: true, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      guildId: GUILD_ID, alias5: 'CHAOS', isOwner: true, permissions: ['dashboard.access'],
      slots: [{ id: 'conn-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE' }], grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, { enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500, playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-links` && method === 'GET') return json(route, {
      links: [{
        userDiscordId: LINKED_USER,
        playerName: LINKED_PLAYER,
        gameId: LINKED_GAME_ID,
        status: 'VERIFIED',
        verifiedAt: '2026-08-19T08:00:00.000Z',
      }],
    });

    if (method !== 'GET') {
      let body: unknown = null;
      try { body = req.postDataJSON(); } catch { body = req.postData(); }
      mutations.push({ method, path, query: url.search, body });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-links/grant` && method === 'POST') {
      return forceFailure ? json(route, { error: 'LINK_CONFLICT' }, 409) : json(route, {
        userDiscordId: NEW_USER,
        playerName: NEW_PLAYER,
        gameId: 'resolved-dayz-guid-new',
        status: 'VERIFIED',
      }, 201);
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-links/${LINKED_USER}` && method === 'DELETE') return json(route, { ok: true });
    return json(route, {});
  });
  return mutations;
}

function find(mutations: Mutation[], method: string, path: string) {
  return mutations.find(row => row.method === method && row.path === path);
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Authenticated Economy-Links', () => {
  test('List, Force-Link und Unlink bleiben exakt Guild+Slot-gescoped und nutzen den kanonischen Spielernamen', async ({ page }) => {
    const mutations = await stub(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=links`);

    await expect(page.getByRole('heading', { name: 'Economy-Links (Discord ↔ In-Game)' })).toBeVisible();
    await expect(page.getByText(LINKED_USER, { exact: true })).toBeVisible();
    await expect(page.getByText(LINKED_PLAYER, { exact: true })).toBeVisible();
    await expect(page.getByText(LINKED_GAME_ID, { exact: true })).toBeVisible();

    await page.getByPlaceholder('Discord-ID').fill(NEW_USER);
    await page.getByPlaceholder('Spielername').fill(NEW_PLAYER);
    await page.getByRole('button', { name: 'Setzen' }).click();
    await expect.poll(() => find(mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/economy-links/grant`)).toBeTruthy();
    const forceWrite = find(mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/economy-links/grant`);
    expect(forceWrite).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { userDiscordId: NEW_USER, playerName: NEW_PLAYER },
    });
    expect(forceWrite?.body).not.toHaveProperty('gameId');

    const linkedRow = page.getByText(LINKED_USER, { exact: true }).locator('xpath=ancestor::div[.//button][1]');
    await linkedRow.getByRole('button').click();
    await expect.poll(() => find(mutations, 'DELETE', `/api/v2/guilds/${GUILD_ID}/economy-links/${LINKED_USER}`)).toBeTruthy();
    expect(find(mutations, 'DELETE', `/api/v2/guilds/${GUILD_ID}/economy-links/${LINKED_USER}`)?.query).toBe(`?slot=${SLOT}`);
  });

  test('Client-Validierung blockiert ungueltige Discord-ID und ungueltigen Spielernamen', async ({ page }) => {
    const mutations = await stub(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=links`);
    await page.getByPlaceholder('Discord-ID').fill('123');
    await page.getByPlaceholder('Spielername').fill('Bad\tName');
    await expect(page.getByRole('button', { name: 'Setzen' })).toBeDisabled();
    expect(mutations.filter(row => row.path.endsWith('/economy-links/grant'))).toHaveLength(0);
  });

  test('Backend-Konflikt wird sichtbar statt als Erfolg behandelt', async ({ page }) => {
    await stub(page, true);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=links`);
    await page.getByPlaceholder('Discord-ID').fill(NEW_USER);
    await page.getByPlaceholder('Spielername').fill(NEW_PLAYER);
    await page.getByRole('button', { name: 'Setzen' }).click();
    await expect(page.locator('.text-danger').filter({ hasText: /./ })).toBeVisible();
  });
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px Economy-Links zeigt Spielername + GUID ohne Seiten-Overflow`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=links`);
    await expect(page.getByRole('heading', { name: 'Economy-Links (Discord ↔ In-Game)' })).toBeVisible();
    await expect(page.getByPlaceholder('Discord-ID')).toBeVisible();
    await expect(page.getByPlaceholder('Spielername')).toBeVisible();
    await expect(page.getByText(LINKED_PLAYER, { exact: true })).toBeVisible();
    await expect(page.getByText(LINKED_GAME_ID, { exact: true })).toBeVisible();
    await noOverflow(page);
  });
}
