import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const CHANNEL_ID = '123456789012345679';
const ROLE_ID = '123456789012345680';
const EMBED_ID = 'embed-viewer-1';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function menuPayload() {
  return {
    menus: [{
      id: 'menu-1',
      channelId: CHANNEL_ID,
      messageId: '123456789012345681',
      isPosted: true,
      title: 'Raid-Rollen',
      description: 'Wähle deine Rolle für den nächsten Raid.',
      mode: 'MULTI',
      isActive: true,
      componentType: 'BUTTON',
      assignMode: 'TOGGLE',
      maxRolesPerUser: 2,
      archived: false,
      embedId: EMBED_ID,
      createdAt: '2026-08-19T18:00:00.000Z',
      updatedAt: '2026-08-19T18:00:00.000Z',
      options: [{
        id: 'option-1',
        roleId: ROLE_ID,
        roleIds: [ROLE_ID],
        label: 'Tank',
        emoji: '🛡️',
        description: null,
        confirmMessage: null,
        position: 0,
        buttonStyle: 'PRIMARY',
        isActive: true,
        assignMode: null,
      }],
    }],
  };
}

async function stubReactionEmbeds(page: Page, permissions: string[], forbidden = false) {
  const manageLookups: string[] = [];
  const mutations: string[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'reaction-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'reaction-user', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
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
    if (path === `${base}/reaction-embeds` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: reactionroles.view' }, 403);
      return json(route, menuPayload());
    }

    if (path === `${base}/channels` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { channels: [{ id: CHANNEL_ID, name: 'rollen', type: 0, parentId: null }] });
    }
    if (path === `${base}/roles` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { roles: [{ id: ROLE_ID, name: 'Tank', color: '#ffffff', position: 5, managed: false }] });
    }
    if (path === `${base}/embeds` && method === 'GET') {
      manageLookups.push(path);
      return json(route, {
        embeds: [{
          id: EMBED_ID,
          name: 'Raid Embed',
          content: null,
          title: 'Raid-Rollen',
          description: 'Wähle deine Rolle',
          url: null,
          color: '#5865f2',
          authorName: null,
          authorIconUrl: null,
          authorUrl: null,
          footerText: null,
          footerIconUrl: null,
          thumbnailUrl: null,
          imageUrl: null,
          showTimestamp: false,
          fields: [],
        }],
      });
    }

    if (method !== 'GET') {
      mutations.push(`${method} ${path}`);
      return json(route, { ok: true });
    }

    return json(route, {});
  });

  return { manageLookups, mutations };
}

async function openReactionEmbeds(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Reaktions Embeds', exact: true }).click();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Reaction-Embeds authenticated viewer contract', () => {
  test('reactionroles.view sieht Menüs read-only ohne Cross-Scope-Manage-Lookups', async ({ page }) => {
    const state = await stubReactionEmbeds(page, ['reactionroles.view']);
    await openReactionEmbeds(page);

    await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Raid-Rollen' })).toBeVisible();
    await expect(page.getByText('Wähle deine Rolle für den nächsten Raid.')).toBeVisible();
    await expect(page.getByText('🛡️ Tank')).toBeVisible();
    await expect(page.getByText(ROLE_ID)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);

    expect(state.manageLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('fehlendes reactionroles.view bleibt sichtbar fail-closed', async ({ page }) => {
    const state = await stubReactionEmbeds(page, ['tickets.manage'], true);
    await openReactionEmbeds(page);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByText(/konnten nicht gelesen werden/)).toBeVisible();
    expect(state.manageLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('reactionroles.manage behält Editor und notwendige Manage-Lookups', async ({ page }) => {
    const state = await stubReactionEmbeds(page, ['reactionroles.view', 'reactionroles.manage', 'embeds.view']);
    await openReactionEmbeds(page);

    await expect(page.getByRole('button', { name: 'Neu', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Raid-Rollen/ }).click();
    await expect(page.getByRole('heading', { name: 'Menü bearbeiten' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeVisible();

    await expect.poll(() => state.manageLookups).toEqual(expect.arrayContaining([
      `/api/v2/guilds/${GUILD_ID}/channels`,
      `/api/v2/guilds/${GUILD_ID}/roles`,
      `/api/v2/guilds/${GUILD_ID}/embeds`,
    ]));
    expect(state.mutations).toEqual([]);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Viewer bleibt bei ${width}px ohne Seiten-Overflow lesbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubReactionEmbeds(page, ['reactionroles.view']);
      await openReactionEmbeds(page);

      await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Raid-Rollen' })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
