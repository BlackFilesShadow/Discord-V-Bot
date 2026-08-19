import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const CHANNEL_ID = '123456789012345679';
const ROLE_ID = '123456789012345680';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function feedsPayload() {
  return {
    feeds: [{
      id: 'feed-1',
      name: 'DayZ News',
      feedType: 'RSS',
      url: 'https://example.invalid/dayz.xml',
      channelId: CHANNEL_ID,
      interval: 300,
      lastChecked: '2026-08-19T18:00:00.000Z',
      isActive: true,
      mentionRoles: [ROLE_ID],
      hasWebhookSecret: false,
      hasCredentials: false,
      createdAt: '2026-08-19T18:00:00.000Z',
      updatedAt: '2026-08-19T18:00:00.000Z',
    }],
  };
}

async function stubFeeds(page: Page, permissions: string[], forbidden = false) {
  const manageLookups: string[] = [];
  const mutations: string[] = [];
  const secretLookups: string[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'feed-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'feed-user', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: false,
        permissions,
        slots: [],
        grantsCount: 1,
      });
    }

    const base = `/api/v2/guilds/${GUILD_ID}`;
    if (path === `${base}/feeds` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: feeds.view' }, 403);
      return json(route, feedsPayload());
    }
    if (path === `${base}/channels` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { channels: [{ id: CHANNEL_ID, name: 'news', type: 0, parentId: null }] });
    }
    if (path === `${base}/roles` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { roles: [{ id: ROLE_ID, name: 'News', color: '#ffffff', position: 5, managed: false }] });
    }
    if (path.includes('/webhook') && method === 'GET') {
      secretLookups.push(path);
      return json(route, { webhookUrl: 'https://example.invalid/hook', secret: 'do-not-load-for-viewers' });
    }

    if (method !== 'GET') {
      mutations.push(`${method} ${path}`);
      return json(route, { ok: true });
    }

    return json(route, {});
  });

  return { manageLookups, mutations, secretLookups };
}

async function openFeeds(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Feeds', exact: true }).click();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Feeds authenticated viewer contract', () => {
  test('feeds.view sieht Feeds read-only ohne Manage- oder Secret-Lookups', async ({ page }) => {
    const state = await stubFeeds(page, ['feeds.view']);
    await openFeeds(page);

    await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'DayZ News' })).toBeVisible();
    await expect(page.getByText('https://example.invalid/dayz.xml')).toBeVisible();
    await expect(page.getByText(CHANNEL_ID)).toBeVisible();
    await expect(page.getByText(/300s.*1 Rolle/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);

    expect(state.manageLookups).toEqual([]);
    expect(state.secretLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('fehlendes feeds.view bleibt sichtbar fail-closed', async ({ page }) => {
    const state = await stubFeeds(page, ['tickets.manage'], true);
    await openFeeds(page);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByText(/Feeds konnten nicht gelesen werden/)).toBeVisible();
    expect(state.manageLookups).toEqual([]);
    expect(state.secretLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('feeds.manage behält Editor sowie Channel- und Rollen-Lookups', async ({ page }) => {
    const state = await stubFeeds(page, ['feeds.view', 'feeds.manage']);
    await openFeeds(page);

    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /DayZ News/ }).click();
    await expect(page.getByRole('heading', { name: 'Feed bearbeiten' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeVisible();
    await expect.poll(() => state.manageLookups).toEqual(expect.arrayContaining([
      `/api/v2/guilds/${GUILD_ID}/channels`,
      `/api/v2/guilds/${GUILD_ID}/roles`,
    ]));
    expect(state.mutations).toEqual([]);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Feeds-Viewer bleibt bei ${width}px ohne Seiten-Overflow lesbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubFeeds(page, ['feeds.view']);
      await openFeeds(page);

      await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'DayZ News' })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
