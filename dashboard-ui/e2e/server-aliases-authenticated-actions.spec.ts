import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface AliasStubOptions {
  isOwner?: boolean;
  patchStatus?: number;
}

async function stubAliasDashboard(page: Page, options: AliasStubOptions = {}) {
  const isOwner = options.isOwner ?? true;
  let alias = 'Chernarus';
  let patchCount = 0;
  let patchPath: string | null = null;
  let patchBody: Record<string, unknown> | null = null;

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
        slots: [{
          id: 'conn-alias-1',
          slot: 1,
          alias,
          alias5: 'CH001',
          status: 'ACTIVE',
          nitradoServerId: '12345',
        }],
        grantsCount: 0,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/nitrado/1/alias` && method === 'PATCH') {
      patchCount += 1;
      patchPath = path;
      patchBody = req.postDataJSON() as Record<string, unknown>;

      if (!isOwner) {
        await json(route, { error: 'Nur der Guild-Owner darf diese Aktion ausführen.' }, 403);
        return;
      }
      if (options.patchStatus && options.patchStatus !== 200) {
        await json(route, { error: 'Alias-Konflikt. Bitte erneut versuchen.' }, options.patchStatus);
        return;
      }

      alias = String(patchBody.alias ?? alias).trim();
      await json(route, { ok: true, slot: 1, alias, alias5: 'CH001' });
      return;
    }

    await json(route, {});
  });

  return {
    patchCount: () => patchCount,
    patchPath: () => patchPath,
    patchBody: () => patchBody,
  };
}

async function openAliases(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  const tab = page.getByRole('button', { name: 'Server-Aliase' }).first();
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByRole('heading', { name: 'Server-Aliase' })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Server-Aliase authenticated owner contract', () => {
  test('Owner speichert exakt Guild+Slot-gescoped, trimmt Alias und lässt alias5 unverändert', async ({ page }) => {
    const writes = await stubAliasDashboard(page);
    await openAliases(page);

    const input = page.getByPlaceholder('Anzeigename').first();
    await expect(input).toHaveValue('Chernarus');
    await expect(page.getByText('CH001', { exact: true })).toBeVisible();

    await input.fill('  Neue Welt  ');
    await page.getByRole('button', { name: 'Speichern' }).first().click();

    await expect.poll(writes.patchCount).toBe(1);
    expect(writes.patchPath()).toBe(`/api/v2/guilds/${GUILD_ID}/nitrado/1/alias`);
    expect(writes.patchBody()).toEqual({ alias: 'Neue Welt' });
    expect(writes.patchBody()).not.toHaveProperty('alias5');

    await expect(page.getByText('Alias gespeichert.')).toBeVisible();
    await expect(page.getByText('CH001', { exact: true })).toBeVisible();
  });

  test('leerer Alias bleibt clientseitig fail-closed und löst keinen PATCH aus', async ({ page }) => {
    const writes = await stubAliasDashboard(page);
    await openAliases(page);

    const input = page.getByPlaceholder('Anzeigename').first();
    await input.fill('   ');

    const save = page.getByRole('button', { name: 'Speichern' }).first();
    await expect(save).toBeDisabled();
    expect(writes.patchCount()).toBe(0);
  });

  test('Backend-Fehler wird sichtbar und nicht als Erfolg maskiert', async ({ page }) => {
    const writes = await stubAliasDashboard(page, { patchStatus: 409 });
    await openAliases(page);

    const input = page.getByPlaceholder('Anzeigename').first();
    await input.fill('Konflikt');
    await page.getByRole('button', { name: 'Speichern' }).first().click();

    await expect.poll(writes.patchCount).toBe(1);
    await expect(page.getByText('Alias-Konflikt. Bitte erneut versuchen.')).toBeVisible();
    await expect(page.getByText('Alias gespeichert.')).toHaveCount(0);
  });

  test('Nicht-Owner sieht den Alias-Tab nicht und erreicht keine Alias-Mutation', async ({ page }) => {
    const writes = await stubAliasDashboard(page, { isOwner: false });
    await page.goto(`/servers/${GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'CHAOS' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Server-Aliase' })).toHaveCount(0);
    expect(writes.patchCount()).toBe(0);
  });
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

test.describe('Server-Aliase mobile matrix', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px bleibt ohne horizontalen Seiten-Overflow`, async ({ page }) => {
      await stubAliasDashboard(page);
      await page.setViewportSize(viewport);
      await openAliases(page);

      await expect(page.getByPlaceholder('Anzeigename').first()).toBeVisible();
      await expect(page.getByText('CH001', { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
