import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const CHANNEL_ID = '123456789012345679';

interface Mutation {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubLifecycle(page: Page, permissions: string[], forbidden = false, isOwner = false) {
  const mutations: Mutation[] = [];
  const manageLookups: string[] = [];
  const hasFullAccess = isOwner || permissions.includes('dashboard.access');

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'lifecycle-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'lifecycle-user', avatar: null, role: 'ADMIN' },
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
        isOwner,
        permissions,
        slots: [],
        grantsCount: isOwner ? 0 : 1,
      });
    }

    const base = `/api/v2/guilds/${GUILD_ID}`;
    if (path === `${base}/welcome/config` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: welcome.view' }, 403);
      return json(route, {
        configured: true,
        enabled: true,
        channelId: CHANNEL_ID,
        message: 'Willkommen {user} auf {guild}!',
        mode: 'text',
        mediaUrl: null,
        mediaLayout: 'image_first',
      });
    }
    if (path === `${base}/goodbye/config` && method === 'GET') {
      if (forbidden) return json(route, { error: 'Permission fehlt: welcome.view' }, 403);
      return json(route, {
        configured: true,
        enabled: false,
        channelId: CHANNEL_ID,
      });
    }
    if (path === `${base}/leave-cleanup/config` && method === 'GET') {
      if (!hasFullAccess) return json(route, { error: 'Dashboard-Vollzugriff erforderlich.' }, 403);
      return json(route, {
        configured: true,
        deletePlayerDataOnLeave: false,
      });
    }

    if (path === `${base}/channels` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { channels: [{ id: CHANNEL_ID, name: 'willkommen', type: 0, parentId: null }] });
    }
    if (path === `${base}/roles` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { roles: [] });
    }
    if (path === `${base}/welcome/autoroles` && method === 'GET') {
      manageLookups.push(path);
      return json(route, { autoroles: [] });
    }

    const mutationBody = (): Record<string, unknown> | null => {
      if (!req.postData()) return null;
      try { return req.postDataJSON() as Record<string, unknown>; } catch { return null; }
    };

    if (path === `${base}/welcome/config` && method === 'POST') {
      const body = mutationBody() ?? {};
      mutations.push({ method, path, body });
      return json(route, { configured: true, ...body });
    }
    if (path === `${base}/goodbye/config` && method === 'POST') {
      const body = mutationBody() ?? {};
      mutations.push({ method, path, body });
      return json(route, { configured: true, ...body });
    }
    if (path === `${base}/leave-cleanup/config` && method === 'POST') {
      if (!hasFullAccess) return json(route, { error: 'Dashboard-Vollzugriff erforderlich.' }, 403);
      const body = mutationBody() ?? {};
      mutations.push({ method, path, body });
      return json(route, { configured: true, ...body });
    }
    if (method !== 'GET') {
      mutations.push({ method, path, body: mutationBody() });
      return json(route, { ok: true });
    }

    return json(route, {});
  });

  return { mutations, manageLookups };
}

async function openWelcome(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Willkommen', exact: true }).click();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Welcome/Goodbye authenticated dashboard contract', () => {
  test('welcome.view sieht Welcome + Goodbye read-only ohne Manage-Lookups oder Mutationen', async ({ page }) => {
    const state = await stubLifecycle(page, ['welcome.view']);
    await openWelcome(page);

    await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
    await expect(page.getByText('Willkommen {user} auf {guild}!')).toBeVisible();
    await expect(page.getByText('Vordefiniertes strukturiertes Abschieds-Embed')).toBeVisible();
    await expect(page.getByText(`Discord-Channel ${CHANNEL_ID}`).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Test senden/ })).toHaveCount(0);

    expect(state.manageLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('fehlendes welcome.view bleibt fail-closed und loest keine Manage-Pfade aus', async ({ page }) => {
    const state = await stubLifecycle(page, ['tickets.manage'], true);
    await openWelcome(page);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByText(/konnte nicht gelesen werden/)).toBeVisible();
    expect(state.manageLookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('welcome.manage zeigt den Cleanup im Goodbye-Bereich sichtbar, ohne Vollzugriff zu erteilen', async ({ page }) => {
    const state = await stubLifecycle(page, ['welcome.view', 'welcome.manage']);
    await openWelcome(page);

    await expect(page.getByRole('heading', { name: 'Willkommen', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Abschied / Goodbye' })).toBeVisible();
    await expect(page.getByTestId('goodbye-leave-cleanup-owner-only')).toBeVisible();
    await expect(page.getByText('Spieler-Cleanup', { exact: true })).toBeVisible();
    await expect(page.getByText(/Discord-Server-Owner/)).toBeVisible();
    await expect(page.getByText(/dashboard\.access/)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Whitelist und Spielerstatistik bei Austritt bereinigen' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect.poll(() => state.mutations.some(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/welcome/config`)).toBe(true);
    await page.getByRole('button', { name: 'Bye Bye aktivieren', exact: true }).click();
    await expect.poll(() => state.mutations.some(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/goodbye/config`)).toBe(true);
    const goodbyeMutation = state.mutations.find(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/goodbye/config`);
    expect(goodbyeMutation?.body).toEqual({ enabled: true, channelId: CHANNEL_ID });

    for (const mutation of state.mutations) {
      expect(mutation.path).toContain(`/api/v2/guilds/${GUILD_ID}/`);
    }
    expect(state.manageLookups).toEqual(expect.arrayContaining([
      `/api/v2/guilds/${GUILD_ID}/channels`,
      `/api/v2/guilds/${GUILD_ID}/roles`,
      `/api/v2/guilds/${GUILD_ID}/welcome/autoroles`,
    ]));
  });

  test('dashboard.access kann den sichtbaren Cleanup wie der Owner sicher aktivieren', async ({ page }) => {
    const state = await stubLifecycle(page, ['dashboard.access']);
    await openWelcome(page);

    const cleanup = page.getByTestId('goodbye-leave-cleanup');
    const cleanupSwitch = page.getByRole('switch', { name: 'Whitelist und Spielerstatistik bei Austritt bereinigen' });
    await expect(cleanup).toBeVisible();
    await expect(cleanupSwitch).toBeVisible();
    await expect(page.getByTestId('goodbye-leave-cleanup-owner-only')).toHaveCount(0);

    await cleanupSwitch.click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Cleanup speichern', exact: true }).click();

    await expect.poll(() => state.mutations.some(m => (
      m.method === 'POST'
      && m.path === `/api/v2/guilds/${GUILD_ID}/leave-cleanup/config`
      && m.body?.deletePlayerDataOnLeave === true
    ))).toBe(true);
    await noPageOverflow(page);
  });

  test('Server-Owner kann den sichtbaren Cleanup im Goodbye-Bereich weiterhin sicher aktivieren', async ({ page }) => {
    const state = await stubLifecycle(page, [], false, true);
    await openWelcome(page);

    const cleanup = page.getByTestId('goodbye-leave-cleanup');
    const cleanupSwitch = page.getByRole('switch', { name: 'Whitelist und Spielerstatistik bei Austritt bereinigen' });
    await expect(cleanup).toBeVisible();
    await expect(cleanupSwitch).toBeVisible();
    await expect(page.getByTestId('goodbye-leave-cleanup-owner-only')).toHaveCount(0);

    await cleanupSwitch.click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Cleanup speichern', exact: true }).click();

    await expect.poll(() => state.mutations.some(m => (
      m.method === 'POST'
      && m.path === `/api/v2/guilds/${GUILD_ID}/leave-cleanup/config`
      && m.body?.deletePlayerDataOnLeave === true
    ))).toBe(true);
    await noPageOverflow(page);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Welcome/Goodbye Viewer bleibt bei ${width}px ohne Seiten-Overflow lesbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubLifecycle(page, ['welcome.view']);
      await openWelcome(page);

      await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
      await expect(page.getByText('Willkommen {user} auf {guild}!')).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
