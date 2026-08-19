import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';

type Slot = {
  id: string;
  slot: number;
  alias: string;
  alias5: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  nitradoServerId: string | null;
};

type Mutation = { path: string; body: Record<string, unknown> };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAliases(page: Page, isOwner: boolean, failSave = false) {
  let slots: Slot[] = [
    { id: 'conn-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE', nitradoServerId: '11111' },
    { id: 'conn-2', slot: 2, alias: 'Livonia', alias5: 'LV002', status: 'EXPIRED', nitradoServerId: '22222' },
  ];
  const mutations: Mutation[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'alias-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'alias-user', avatar: null, role: 'ADMIN' },
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
        isOwner,
        permissions: isOwner ? ['dashboard.access'] : ['dashboard.view'],
        slots,
        grantsCount: 0,
      });
    }

    const match = path.match(new RegExp(`^/api/v2/guilds/${GUILD_ID}/nitrado/(\\d+)/alias$`));
    if (match && method === 'PATCH') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ path, body });
      if (failSave) return json(route, { error: 'Alias konnte nicht gespeichert werden.' }, 400);
      const slot = Number(match[1]);
      const alias = String(body.alias ?? '');
      slots = slots.map(row => row.slot === slot ? { ...row, alias } : row);
      const updated = slots.find(row => row.slot === slot)!;
      return json(route, { ok: true, slot, alias: updated.alias, alias5: updated.alias5 });
    }

    return json(route, {});
  });

  return { mutations };
}

async function openAliases(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Server-Aliase', exact: true }).click();
}

function firstAliasInput(page: Page) {
  return page.getByRole('textbox', { name: 'Anzeigename', exact: true }).first();
}

function firstSaveButton(page: Page) {
  return page.getByRole('button', { name: 'Speichern', exact: true }).first();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Server aliases authenticated contract', () => {
  test('Nicht-Owner sehen den Owner-only Alias-Tab nicht', async ({ page }) => {
    await stubAliases(page, false);
    await page.goto(`/servers/${GUILD_ID}`);
    await expect(page.getByRole('button', { name: 'Server-Aliase', exact: true })).toHaveCount(0);
  });

  test('Owner speichert getrimmten Alias nur im exakten Guild+Slot-Scope und alias5 bleibt unverändert', async ({ page }) => {
    const state = await stubAliases(page, true);
    await openAliases(page);

    await expect(page.getByText('CH001', { exact: true })).toBeVisible();
    const input = firstAliasInput(page);
    await expect(input).toHaveValue('Chernarus');
    await input.fill('  Chernarus PvE  ');
    await firstSaveButton(page).click();

    await expect.poll(() => state.mutations[0]?.path).toBe(`/api/v2/guilds/${GUILD_ID}/nitrado/1/alias`);
    expect(state.mutations[0]?.body).toEqual({ alias: 'Chernarus PvE' });
    await expect(page.getByText('Alias gespeichert.')).toBeVisible();
    await expect(page.getByText('CH001', { exact: true })).toBeVisible();
  });

  test('leerer/Whitespace-Alias bleibt clientseitig gesperrt', async ({ page }) => {
    const state = await stubAliases(page, true);
    await openAliases(page);

    const input = firstAliasInput(page);
    await expect(input).toHaveValue('Chernarus');
    await input.fill('   ');
    await expect(firstSaveButton(page)).toBeDisabled();
    expect(state.mutations).toEqual([]);
  });

  test('Backend-Fehler beim Alias-Save wird sichtbar und nicht als Erfolg behandelt', async ({ page }) => {
    const state = await stubAliases(page, true, true);
    await openAliases(page);

    const input = firstAliasInput(page);
    await expect(input).toHaveValue('Chernarus');
    await input.fill('Fehler Alias');
    await firstSaveButton(page).click();

    await expect.poll(() => state.mutations.length).toBe(1);
    await expect(page.getByText('Alias konnte nicht gespeichert werden.')).toBeVisible();
    await expect(page.getByText('Alias gespeichert.')).toHaveCount(0);
  });

  test('nicht-aktiver Slot zeigt seinen Status ohne die Alias-Funktion zu verlieren', async ({ page }) => {
    await stubAliases(page, true);
    await openAliases(page);

    await expect(page.getByText('Slot-Status: EXPIRED')).toBeVisible();
    const inputs = page.getByRole('textbox', { name: 'Anzeigename', exact: true });
    await expect(inputs.nth(1)).toHaveValue('Livonia');
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Server-Aliase bleiben bei ${width}px ohne Seiten-Overflow bedienbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubAliases(page, true);
      await openAliases(page);
      await expect(firstAliasInput(page)).toHaveValue('Chernarus');
      await expect(page.getByText('CH001', { exact: true })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
