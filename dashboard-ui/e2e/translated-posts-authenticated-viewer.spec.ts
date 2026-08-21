import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const CHANNEL_ID = '123456789012345679';
const ROLE_ID = '123456789012345680';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function postsPayload() {
  return {
    posts: [{
      id: 'post-1',
      channelId: CHANNEL_ID,
      sourceText: 'Server restart tonight at 22:00 UTC.',
      sourceLang: 'en',
      targetLang: 'de',
      customTitle: 'Server-News',
      imageUrl: null,
      hasImage: false,
      rolePings: [ROLE_ID],
      mode: 'recurring',
      scheduledFor: null,
      recurrenceCron: 'DAILY:22:00',
      nextRunAt: '2026-08-20T22:00:00.000Z',
      isActive: true,
    }],
  };
}

async function stubTranslations(page: Page, permissions: string[], forbidden = false) {
  const manageLookups: string[] = [];
  const mutations: string[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'translate-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'translate-user', avatar: null, role: 'ADMIN' },
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
    if (path === `${base}/translated-posts` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: translate.view' }, 403);
      return json(route, postsPayload());
    }
    if (path === `${base}/translated-posts/meta/languages` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: translate.view' }, 403);
      return json(route, { languages: [
        { code: 'en', name: 'Englisch', emoji: '🇬🇧' },
        { code: 'de', name: 'Deutsch', emoji: '🇩🇪' },
      ] });
    }
    if (path === `${base}/channels` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { channels: [{ id: CHANNEL_ID, name: 'news', type: 0, parentId: null }] });
    }
    if (path === `${base}/roles` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { roles: [{ id: ROLE_ID, name: 'News', color: '#ffffff', position: 5, managed: false }] });
    }

    if (method !== 'GET') {
      mutations.push(`${method} ${path}`);
      return json(route, { ok: true });
    }

    return json(route, {});
  });

  return { manageLookups, mutations };
}

async function openTranslations(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Übersetzungen', exact: true }).click();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Translated posts authenticated viewer contract', () => {
  test('translate.view sieht Übersetzungs-Posts read-only ohne Manage-Lookups oder Mutationen', async ({ page }) => {
    const state = await stubTranslations(page, ['translate.view']);
    await openTranslations(page);

    await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Server-News' })).toBeVisible();
    await expect(page.getByText('Server restart tonight at 22:00 UTC.')).toBeVisible();
    await expect(page.getByText('Englisch → Deutsch')).toBeVisible();
    await expect(page.getByText(CHANNEL_ID)).toBeVisible();
    await expect(page.getByText(/DAILY:22:00/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Senden', exact: true })).toHaveCount(0);

    expect(state.manageLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('fehlendes translate.view bleibt sichtbar fail-closed', async ({ page }) => {
    const state = await stubTranslations(page, ['tickets.manage'], true);
    await openTranslations(page);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByText(/Übersetzungen konnten nicht gelesen werden/)).toBeVisible();
    expect(state.manageLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('translate.manage behält Editor sowie Channel- und Rollen-Lookups', async ({ page }) => {
    const state = await stubTranslations(page, ['translate.view', 'translate.manage']);
    await openTranslations(page);

    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Server-News Englisch → Deutsch #news', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Übersetzung bearbeiten' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeVisible();
    await expect.poll(() => state.manageLookups).toEqual(expect.arrayContaining([
      `/api/v2/guilds/${GUILD_ID}/channels`,
      `/api/v2/guilds/${GUILD_ID}/roles`,
    ]));
    expect(state.mutations).toEqual([]);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Übersetzungs-Viewer bleibt bei ${width}px ohne Seiten-Overflow lesbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubTranslations(page, ['translate.view']);
      await openTranslations(page);

      await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Server-News' })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
