import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';
const TARGET_USER = '323456789012345678';
const BOT_USER = '423456789012345678';
const TARGET_ROLE = '523456789012345678';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface PermissionStubOptions {
  isOwner?: boolean;
  grantStatus?: number;
}

async function stubPermissionDashboard(page: Page, options: PermissionStubOptions = {}) {
  const isOwner = options.isOwner ?? true;
  const userScopes = new Set<string>();
  const roleScopes = new Set<string>();
  const writes: Array<{ method: string; path: string }> = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'dashboard-e2e', avatar: null, role: 'USER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'dashboard-e2e', avatar: null, role: 'USER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') {
      await json(route, { active: false, eligible: false, expiresAt: null });
      return;
    }
    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      await json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner,
        permissions: isOwner ? ['dashboard.access'] : ['dashboard.view'],
        slots: [],
        grantsCount: userScopes.size > 0 ? 1 : 0,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/roles` && method === 'GET') {
      await json(route, {
        roles: [
          { id: TARGET_ROLE, name: 'Support', color: '#22c55e', position: 10, managed: false },
          { id: '623456789012345678', name: 'Managed Bot', color: '#000000', position: 9, managed: true },
          { id: GUILD_ID, name: '@everyone', color: '#000000', position: 0, managed: false },
        ],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/members` && method === 'GET') {
      await json(route, {
        members: [
          { id: TARGET_USER, username: 'alice', displayName: 'Alice', avatar: null, bot: false },
          { id: BOT_USER, username: 'helperbot', displayName: 'Helper Bot', avatar: null, bot: true },
        ],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/permissions` && method === 'GET') {
      await json(route, {
        grants: userScopes.size > 0 ? [{
          userDiscordId: TARGET_USER,
          username: 'alice',
          displayName: 'Alice',
          avatar: null,
          permissions: [...userScopes].sort(),
          grantedBy: USER_ID,
          updatedAt: '2026-08-19T00:00:00.000Z',
        }] : [],
        roleGrants: roleScopes.size > 0 ? [{
          roleDiscordId: TARGET_ROLE,
          permissions: [...roleScopes].sort(),
          grantedBy: USER_ID,
          updatedAt: '2026-08-19T00:00:00.000Z',
        }] : [],
        availableScopes: ['dashboard.view', 'economy.view', 'tickets.manage'],
      });
      return;
    }

    const userScopeMatch = path.match(new RegExp(`^/api/v2/guilds/${GUILD_ID}/permissions/${TARGET_USER}/([^/]+)$`));
    if (userScopeMatch && (method === 'PUT' || method === 'DELETE')) {
      writes.push({ method, path });
      const scope = decodeURIComponent(userScopeMatch[1]);
      if (method === 'PUT' && options.grantStatus && options.grantStatus !== 200) {
        await json(route, { error: 'Permission-Konflikt. Bitte erneut versuchen.' }, options.grantStatus);
        return;
      }
      if (method === 'PUT') userScopes.add(scope);
      else userScopes.delete(scope);
      await json(route, { permissions: [...userScopes].sort() });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/permissions/${TARGET_USER}` && method === 'DELETE') {
      writes.push({ method, path });
      userScopes.clear();
      await json(route, { ok: true });
      return;
    }

    const roleScopeMatch = path.match(new RegExp(`^/api/v2/guilds/${GUILD_ID}/permissions/roles/${TARGET_ROLE}/([^/]+)$`));
    if (roleScopeMatch && (method === 'PUT' || method === 'DELETE')) {
      writes.push({ method, path });
      const scope = decodeURIComponent(roleScopeMatch[1]);
      if (method === 'PUT') roleScopes.add(scope);
      else roleScopes.delete(scope);
      await json(route, { permissions: [...roleScopes].sort() });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/permissions/roles/${TARGET_ROLE}` && method === 'DELETE') {
      writes.push({ method, path });
      roleScopes.clear();
      await json(route, { ok: true });
      return;
    }

    await json(route, {});
  });

  return { writes, userScopes, roleScopes };
}

async function openPermissions(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  const tab = page.getByRole('button', { name: 'Berechtigungen' }).first();
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByText('Berechtigung erteilen', { exact: true })).toBeVisible();
}

async function selectComboboxOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(placeholder) }).first().click();
  const option = page.getByRole('option', { name: new RegExp(optionName) }).first();
  await expect(option).toBeVisible();
  await option.click();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Berechtigungen authenticated owner action matrix', () => {
  test('User grant, revoke und purge bleiben exakt guild+target+scope gescoped', async ({ page }) => {
    const state = await stubPermissionDashboard(page);
    await openPermissions(page);

    await selectComboboxOption(page, 'Mitglied suchen', 'Alice');
    await page.locator('select').filter({ has: page.locator('option[value="dashboard.view"]') }).first().selectOption('dashboard.view');
    await page.getByRole('button', { name: 'Erteilen' }).click();

    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0]).toEqual({
      method: 'PUT',
      path: `/api/v2/guilds/${GUILD_ID}/permissions/${TARGET_USER}/dashboard.view`,
    });
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Berechtigung dashboard.view von Alice entziehen' }).click();
    await expect.poll(() => state.writes.length).toBe(2);
    expect(state.writes[1]).toEqual({
      method: 'DELETE',
      path: `/api/v2/guilds/${GUILD_ID}/permissions/${TARGET_USER}/dashboard.view`,
    });

    // erneut erteilen, danach kompletter Purge mit Confirm
    await selectComboboxOption(page, 'Mitglied suchen', 'Alice');
    await page.locator('select').filter({ has: page.locator('option[value="economy.view"]') }).first().selectOption('economy.view');
    await page.getByRole('button', { name: 'Erteilen' }).click();
    await expect.poll(() => state.writes.length).toBe(3);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Alle entziehen' }).first().click();
    await expect.poll(() => state.writes.length).toBe(4);
    expect(state.writes[3]).toEqual({
      method: 'DELETE',
      path: `/api/v2/guilds/${GUILD_ID}/permissions/${TARGET_USER}`,
    });
  });

  test('Role grant und revoke nutzen ausschließlich die ausgewählte Guild-Rolle', async ({ page }) => {
    const state = await stubPermissionDashboard(page);
    await openPermissions(page);

    await page.getByRole('button', { name: 'Rolle', exact: true }).click();
    await selectComboboxOption(page, 'Rolle waehlen', 'Support');
    await page.locator('select').filter({ has: page.locator('option[value="tickets.manage"]') }).first().selectOption('tickets.manage');
    await page.getByRole('button', { name: 'Erteilen' }).click();

    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0]).toEqual({
      method: 'PUT',
      path: `/api/v2/guilds/${GUILD_ID}/permissions/roles/${TARGET_ROLE}/tickets.manage`,
    });

    await expect(page.getByText('@Support', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Berechtigung tickets\.manage.*entziehen/ }).click();
    await expect.poll(() => state.writes.length).toBe(2);
    expect(state.writes[1]).toEqual({
      method: 'DELETE',
      path: `/api/v2/guilds/${GUILD_ID}/permissions/roles/${TARGET_ROLE}/tickets.manage`,
    });
  });

  test('Bot-Mitglied bleibt im User-Picker disabled', async ({ page }) => {
    await stubPermissionDashboard(page);
    await openPermissions(page);
    await page.getByRole('button', { name: /Mitglied suchen/ }).first().click();
    await expect(page.getByRole('option', { name: /Helper Bot/ })).toBeDisabled();
  });

  test('Backend-Fehler wird sichtbar und nicht als Erfolg maskiert', async ({ page }) => {
    const state = await stubPermissionDashboard(page, { grantStatus: 409 });
    await openPermissions(page);
    await selectComboboxOption(page, 'Mitglied suchen', 'Alice');
    await page.locator('select').filter({ has: page.locator('option[value="dashboard.view"]') }).first().selectOption('dashboard.view');
    await page.getByRole('button', { name: 'Erteilen' }).click();

    await expect.poll(() => state.writes.length).toBe(1);
    await expect(page.getByText('Permission-Konflikt. Bitte erneut versuchen.').first()).toBeVisible();
    await expect(page.getByText('Alice', { exact: true })).toHaveCount(0);
  });

  test('Nicht-Owner sieht den Owner-only Berechtigungs-Tab nicht', async ({ page }) => {
    const state = await stubPermissionDashboard(page, { isOwner: false });
    await page.goto(`/servers/${GUILD_ID}`);
    await expect(page.getByRole('heading', { name: 'CHAOS' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Berechtigungen' })).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
  });
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

test.describe('Berechtigungen mobile matrix', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px bleibt ohne horizontalen Seiten-Overflow`, async ({ page }) => {
      await stubPermissionDashboard(page);
      await page.setViewportSize(viewport);
      await openPermissions(page);
      await expect(page.getByRole('button', { name: /Mitglied suchen/ }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Erteilen' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
