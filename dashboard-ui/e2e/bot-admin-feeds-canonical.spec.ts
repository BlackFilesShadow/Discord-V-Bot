import { test, expect, type Page, type Route, type Request } from '@playwright/test';

const GUILD_ID = '999999999999999999';
const CHANNEL_ID = '222222222222222222';
const USER = { discordId: 'bot-admin-feed-user', username: 'bot-admin-feed-test', avatar: null, role: 'ADMIN' };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubBotAdmin(page: Page, onCreate: (request: Request) => void): Promise<void> {
  await page.route('**/api/me', route => json(route, { user: USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: USER }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: true, expiresAt: '2026-09-12T18:00:00.000Z' }));
  await page.route('**/api/v2/dev/status', route => json(route, { error: 'Keine globale DEV-Berechtigung.', code: 'DEV_IDENTITY_REQUIRED' }, 403));
  await page.route('**/api/v2/bot-admin/guilds', route => json(route, {
    items: [{ id: GUILD_ID, name: 'Feed Test Guild', memberCount: 42 }],
  }));
  await page.route('**/api/v2/bot-admin/overview', route => json(route, {
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
  }));
  await page.route(`**/api/v2/bot-admin/feeds/channels?guildId=${GUILD_ID}`, route => json(route, {
    channels: [{ id: CHANNEL_ID, name: 'news-feed', type: 0, parentId: null }],
  }));
  await page.route(`**/api/v2/bot-admin/feeds/roles?guildId=${GUILD_ID}`, route => json(route, { roles: [] }));
  await page.route(`**/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`, async route => {
    if (route.request().method() === 'POST') {
      onCreate(route.request());
      return json(route, {
        id: 'feed-created',
        name: 'Canonical Feed',
        feedType: 'RSS',
        url: 'https://example.com/feed.xml',
        channelId: CHANNEL_ID,
        interval: 300,
        lastChecked: null,
        isActive: true,
        mentionRoles: [],
        hasWebhookSecret: false,
        hasCredentials: false,
        createdAt: '2026-09-12T15:00:00.000Z',
        updatedAt: '2026-09-12T15:00:00.000Z',
      }, 201);
    }
    return json(route, { items: [] });
  });

  // Ein BotAdmin darf fuer diese Oberfläche nicht versehentlich auf den normalen
  // Guild-Permission-Transport zurückfallen.
  await page.route(`**/api/v2/guilds/${GUILD_ID}/feeds**`, route => json(route, { error: 'wrong transport' }, 599));
  await page.route(`**/api/v2/guilds/${GUILD_ID}/channels`, route => json(route, { error: 'wrong transport' }, 599));
  await page.route(`**/api/v2/guilds/${GUILD_ID}/roles`, route => json(route, { error: 'wrong transport' }, 599));
}

test('BotAdmin nutzt die kanonische Feed-UI mit eigenem Auth-Transport', async ({ page }) => {
  const createdBodies: unknown[] = [];
  await stubBotAdmin(page, request => createdBodies.push(request.postDataJSON()));
  await page.goto('/bot-admin');

  await page.getByRole('button', { name: 'Feeds', exact: true }).click();
  await page.getByRole('combobox').first().selectOption(GUILD_ID);

  await expect(page.getByText('Live-Feeds aus RSS, News, Twitch, Steam, YouTube oder eingehenden Webhooks.')).toBeVisible();
  await page.getByRole('button', { name: 'Neu', exact: true }).click();

  const typeSelect = page.getByLabel('Typ');
  await expect(typeSelect.locator('option')).toHaveText([
    'RSS-Feed',
    'News (→ Deutsch)',
    'Twitch-Stream',
    'Steam-News',
    'YouTube',
    'Webhook (eingehend)',
  ]);
  await expect(typeSelect.locator('option[value="TWITTER"]')).toHaveCount(0);
  await expect(typeSelect.locator('option[value="CUSTOM"]')).toHaveCount(0);
  await expect(typeSelect.locator('option[value="YOUTUBE"]')).toHaveCount(1);

  await page.getByLabel('Name (optional bei News)').fill('Canonical Feed');
  await page.getByLabel('Feed URL').fill('https://example.com/feed.xml');
  await page.getByLabel('Ziel-Channel').selectOption(CHANNEL_ID);
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();

  await expect.poll(() => createdBodies.length).toBe(1);
  expect(createdBodies[0]).toMatchObject({
    name: 'Canonical Feed',
    feedType: 'RSS',
    url: 'https://example.com/feed.xml',
    channelId: CHANNEL_ID,
    interval: 300,
    mentionRoles: [],
  });
  await expect(page.getByText('Feed gespeichert.')).toBeVisible();
});
