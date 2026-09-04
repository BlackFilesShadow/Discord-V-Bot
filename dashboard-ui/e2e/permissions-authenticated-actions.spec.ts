import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const OWNER_ID = '437718598876268545';
const MEMBER_ID = '111111111111111111';
const ROLE_ID = '222222222222222222';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

type Grant = {
  userDiscordId: string;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  permissions: string[];
  grantedBy: string;
  updatedAt: string;
};

type RoleGrant = {
  roleDiscordId: string;
  permissions: string[];
  grantedBy: string;
  updatedAt: string;
};

interface PermissionStubOptions {
  isOwner?: boolean;
  failGrant?: boolean;
}

async function stubPermissions(page: Page, options: PermissionStubOptions = {}) {
  const isOwner = options.isOwner ?? true;
  let grants: Grant[] = [];
  let roleGrants: RoleGrant[] = [];
  const writes: Array<{ method: string; path: string }> = [];
  let permissionReads = 0;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: OWNER_ID, username: 'permission-e2e', avatar: null, role: 'USER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: OWNER_ID, username: 'permission-e2e', avatar: null, role: 'USER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const base = `/api/v2/guilds/${GUILD_ID}`;

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `${base}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner,
        permissions: isOwner ? [] : ['dashboard.view'],
        slots: [],
        grantsCount: grants.length,
      });
    }

    if (path === `${base}/permissions` && method === 'GET') {
      permissionReads += 1;
      if (!isOwner) return json(route, { error: 'Nur der Server-Owner darf das.' }, 403);
      return json(route, {
        grants,
        roleGrants,
        availableScopes: ['dashboard.access', 'economy.view', 'whitelist.view', 'tickets.manage'],
      });
    }
    if (path === `${base}/members` && method === 'GET') {
      return json(route, {
        members: [{ id: MEMBER_ID, username: 'alice', displayName: 'Alice', avatar: null, bot: false }],
      });
    }
    if (path === `${base}/roles` && method === 'GET') {
      return json(route, {
        roles: [{ id: ROLE_ID, name: 'Moderation', color: '#5865F2', position: 5, managed: false }],
      });
    }

    if (path.startsWith(`${base}/permissions/`) && method !== 'GET') {
      writes.push({ method, path });
      if (options.failGrant && method === 'PUT') {
        return json(route, { error: 'Permission-Konflikt. Bitte erneut versuchen.' }, 409);
      }

      const rolePrefix = `${base}/permissions/roles/`;
      if (path.startsWith(rolePrefix)) {
        const rest = path.slice(rolePrefix.length).split('/');
        const roleId = rest[0];
        const scope = rest[1];
        const current = roleGrants.find(grant => grant.roleDiscordId === roleId);
        if (method === 'PUT' && scope) {
          const permissions = Array.from(new Set([...(current?.permissions ?? []), scope])).sort();
          roleGrants = [{ roleDiscordId: roleId, permissions, grantedBy: OWNER_ID, updatedAt: new Date().toISOString() }];
          return json(route, { permissions });
        }
        if (method === 'DELETE' && scope) {
          const permissions = (current?.permissions ?? []).filter(item => item !== scope);
          roleGrants = permissions.length > 0
            ? [{ roleDiscordId: roleId, permissions, grantedBy: OWNER_ID, updatedAt: new Date().toISOString() }]
            : [];
          return json(route, { permissions });
        }
        if (method === 'DELETE') {
          roleGrants = [];
          return json(route, { ok: true });
        }
      }

      const rest = path.slice(`${base}/permissions/`.length).split('/');
      const userId = rest[0];
      const scope = rest[1];
      const current = grants.find(grant => grant.userDiscordId === userId);
      if (method === 'PUT' && scope) {
        const permissions = Array.from(new Set([...(current?.permissions ?? []), scope])).sort();
        grants = [{
          userDiscordId: userId,
          username: 'alice',
          displayName: 'Alice',
          avatar: null,
          permissions,
          grantedBy: OWNER_ID,
          updatedAt: new Date().toISOString(),
        }];
        return json(route, { permissions });
      }
      if (method === 'DELETE' && scope) {
        const permissions = (current?.permissions ?? []).filter(item => item !== scope);
        grants = permissions.length > 0 ? [{ ...current!, permissions, updatedAt: new Date().toISOString() }] : [];
        return json(route, { permissions });
      }
      if (method === 'DELETE') {
        grants = [];
        return json(route, { ok: true });
      }
    }

    return json(route, {});
  });

  return {
    writes,
    permissionReads: () => permissionReads,
  };
}

async function openPermissions(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  const tab = page.getByRole('button', { name: 'Berechtigungen' }).first();
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByRole('heading', { name: 'Berechtigung erteilen' })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Permissions authenticated owner contract', () => {
  test('Owner kann User- und Role-Grants guild-gescoped vergeben und einzeln entziehen', async ({ page }) => {
    const state = await stubPermissions(page);
    await openPermissions(page);
    const base = `/api/v2/guilds/${GUILD_ID}`;

    await page.getByRole('button', { name: 'Mitglied suchen...' }).click();
    await page.getByRole('option', { name: /Alice/ }).click();
    await page.locator('select').selectOption('economy.view');
    await page.getByRole('button', { name: 'Erteilen', exact: true }).click();

    await expect(page.getByText('Alice', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Berechtigung economy.view von Alice entziehen/ })).toBeVisible();
    expect(state.writes).toContainEqual({ method: 'PUT', path: `${base}/permissions/${MEMBER_ID}/economy.view` });

    await page.getByRole('button', { name: 'Rolle' }).click();
    await page.getByRole('button', { name: 'Rolle waehlen...' }).click();
    await page.getByRole('option', { name: /Moderation/ }).click();
    await page.locator('select').selectOption('whitelist.view');
    await page.getByRole('button', { name: 'Erteilen', exact: true }).click();

    await expect(page.getByText('@Moderation', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Berechtigung whitelist.view von Rolle @Moderation entziehen/ })).toBeVisible();
    expect(state.writes).toContainEqual({ method: 'PUT', path: `${base}/permissions/roles/${ROLE_ID}/whitelist.view` });

    await page.getByRole('button', { name: /Berechtigung economy.view von Alice entziehen/ }).click();
    await expect(page.getByText('Noch keine delegierten Mitglieder-Rechte.')).toBeVisible();
    expect(state.writes).toContainEqual({ method: 'DELETE', path: `${base}/permissions/${MEMBER_ID}/economy.view` });
  });

  test('Owner kann komplette User- und Role-Grants purgen', async ({ page }) => {
    const state = await stubPermissions(page);
    await openPermissions(page);
    const base = `/api/v2/guilds/${GUILD_ID}`;

    await page.getByRole('button', { name: 'Mitglied suchen...' }).click();
    await page.getByRole('option', { name: /Alice/ }).click();
    await page.locator('select').selectOption('economy.view');
    await page.getByRole('button', { name: 'Erteilen', exact: true }).click();

    await page.getByRole('button', { name: 'Rolle' }).click();
    await page.getByRole('button', { name: 'Rolle waehlen...' }).click();
    await page.getByRole('option', { name: /Moderation/ }).click();
    await page.locator('select').selectOption('tickets.manage');
    await page.getByRole('button', { name: 'Erteilen', exact: true }).click();

    page.on('dialog', dialog => void dialog.accept());
    const aliceCard = page.getByText('Alice', { exact: true }).locator('xpath=ancestor::*[contains(@class,"card-premium")][1]');
    await aliceCard.getByRole('button', { name: 'Alle entziehen' }).click();
    await expect(page.getByText('Noch keine delegierten Mitglieder-Rechte.')).toBeVisible();

    const roleCard = page.getByText('@Moderation', { exact: true }).locator('xpath=ancestor::*[contains(@class,"card-premium")][1]');
    await roleCard.getByRole('button', { name: 'Alle entziehen' }).click();
    await expect(page.getByText('Noch keine Rollen-basierten Rechte.')).toBeVisible();

    expect(state.writes).toContainEqual({ method: 'DELETE', path: `${base}/permissions/${MEMBER_ID}` });
    expect(state.writes).toContainEqual({ method: 'DELETE', path: `${base}/permissions/roles/${ROLE_ID}` });
  });

  test('Backend-Konflikt bleibt sichtbar und wird nicht als Erfolg maskiert', async ({ page }) => {
    const state = await stubPermissions(page, { failGrant: true });
    await openPermissions(page);
    const base = `/api/v2/guilds/${GUILD_ID}`;

    await page.getByRole('button', { name: 'Mitglied suchen...' }).click();
    await page.getByRole('option', { name: /Alice/ }).click();
    await page.locator('select').selectOption('economy.view');
    await page.getByRole('button', { name: 'Erteilen', exact: true }).click();

    await expect(page.getByText('Permission-Konflikt. Bitte erneut versuchen.').first()).toBeVisible();
    await expect(page.getByText('Mitglieder (0)', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Berechtigung economy.view von Alice entziehen/ })).toHaveCount(0);
    expect(state.writes).toContainEqual({ method: 'PUT', path: `${base}/permissions/${MEMBER_ID}/economy.view` });
  });

  test('Nicht-Owner sieht den Owner-only Permission-Tab nicht und ruft Permission-API nicht auf', async ({ page }) => {
    const state = await stubPermissions(page, { isOwner: false });
    await page.goto(`/servers/${GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'CHAOS' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Berechtigungen' })).toHaveCount(0);
    expect(state.permissionReads()).toBe(0);
    expect(state.writes).toEqual([]);
  });
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

test.describe('Permissions mobile matrix', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px bleibt ohne horizontalen Seiten-Overflow`, async ({ page }) => {
      await stubPermissions(page);
      await page.setViewportSize(viewport);
      await openPermissions(page);

      await expect(page.getByRole('button', { name: 'Erteilen', exact: true })).toBeVisible();
      await expect(page.getByText('Mitglieder (0)', { exact: true })).toBeVisible();
      await expect(page.getByText('Rollen (0)', { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
