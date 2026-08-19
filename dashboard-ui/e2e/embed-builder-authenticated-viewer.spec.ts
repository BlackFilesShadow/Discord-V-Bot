import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const CHANNEL_ID = '123456789012345679';
const EMBED_ID = 'embed-viewer-1';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function embedsPayload() {
  return {
    embeds: [{
      id: EMBED_ID,
      name: 'Server-Regeln',
      channelId: CHANNEL_ID,
      messageId: '123456789012345680',
      content: 'Bitte lest die Regeln.',
      title: 'Die Chaoten Regeln',
      description: 'Fair spielen und respektvoll bleiben.',
      url: null,
      color: '#5865f2',
      authorName: null,
      authorIconUrl: null,
      authorUrl: null,
      footerText: 'Stand 2026',
      footerIconUrl: null,
      thumbnailUrl: null,
      imageUrl: 'https://example.invalid/rules.png',
      showTimestamp: false,
      fields: [{ name: 'Raid', value: 'Kein Base-Raid', inline: false }],
      isTemplate: true,
      isDraft: false,
      isPosted: true,
      createdAt: '2026-08-19T18:00:00.000Z',
      updatedAt: '2026-08-19T18:00:00.000Z',
    }],
  };
}

async function stubEmbedBuilder(page: Page, permissions: string[], forbidden = false) {
  const channelLookups: string[] = [];
  const mutations: string[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'embed-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'embed-user', avatar: null, role: 'ADMIN' },
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
    if (path === `${base}/embeds` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: embeds.view' }, 403);
      return json(route, embedsPayload());
    }
    if (path === `${base}/channels` && method === 'GET') {
      channelLookups.push(path);
      return json(route, { channels: [{ id: CHANNEL_ID, name: 'regeln', type: 0, parentId: null }] });
    }

    if (method !== 'GET') {
      mutations.push(`${method} ${path}`);
      if (path === `${base}/embeds` && method === 'POST') return json(route, embedsPayload().embeds[0], 201);
      return json(route, { ok: true });
    }

    return json(route, {});
  });

  return { channelLookups, mutations };
}

async function openEmbeds(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Eingebettete Nachrichten', exact: true }).click();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Embed-Builder authenticated viewer contract', () => {
  test('embeds.view sieht gespeicherte Embeds read-only ohne Channel-Lookup oder Mutation', async ({ page }) => {
    const state = await stubEmbedBuilder(page, ['embeds.view']);
    await openEmbeds(page);

    await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Server-Regeln' })).toBeVisible();
    await expect(page.getByText('Die Chaoten Regeln')).toBeVisible();
    await expect(page.getByText('Fair spielen und respektvoll bleiben.')).toBeVisible();
    await expect(page.getByText(CHANNEL_ID)).toBeVisible();
    await expect(page.getByText(/1 Feld\(er\).*Bild vorhanden/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Neuer Embed', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);

    expect(state.channelLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('fehlendes embeds.view bleibt sichtbar fail-closed', async ({ page }) => {
    const state = await stubEmbedBuilder(page, ['tickets.manage'], true);
    await openEmbeds(page);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByText(/konnten nicht gelesen werden/)).toBeVisible();
    expect(state.channelLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('embeds.manage behält Liste, Editor und Channel-Lookup', async ({ page }) => {
    const state = await stubEmbedBuilder(page, ['embeds.view', 'embeds.manage']);
    await openEmbeds(page);

    await expect(page.getByRole('button', { name: 'Neuer Embed', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Server-Regeln/ }).click();
    await expect(page.getByRole('heading', { name: 'Embed bearbeiten' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeVisible();
    await expect.poll(() => state.channelLookups).toContain(`/api/v2/guilds/${GUILD_ID}/channels`);
    expect(state.mutations).toEqual([]);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Embed-Viewer bleibt bei ${width}px ohne Seiten-Overflow lesbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubEmbedBuilder(page, ['embeds.view']);
      await openEmbeds(page);

      await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Server-Regeln' })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
