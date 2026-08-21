import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';
const CHANNEL_ID = '523456789012345678';
const CONFIG_ID = 'feed-death-1';

interface Mutation { method: string; path: string; query: string; body: unknown }

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function feed(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    kind: 'DEATH',
    nitradoConnId: 'conn-1',
    channelId: CHANNEL_ID,
    isActive: true,
    categories: ['PVP', 'DEATH'],
    showActorCoords: true,
    showTargetCoords: false,
    showTool: true,
    showDistance: true,
    embedColor: '#dc2626',
    lastEventAt: '2026-08-19T09:00:00.000Z',
    lastPolledAt: '2026-08-19T09:01:00.000Z',
    lastErrorMsg: null,
    ...overrides,
  };
}

async function stub(page: Page, opts: { saveFailure?: boolean; listFailure?: boolean; actionDelayMs?: number } = {}) {
  const mutations: Mutation[] = [];
  await page.route('**/api/me', route => json(route, { user: { discordId: USER_ID, username: 'killfeed-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: { discordId: USER_ID, username: 'killfeed-e2e', avatar: null, role: 'DEVELOPER' } }));
  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: true, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      guildId: GUILD_ID,
      alias5: 'CHAOS',
      isOwner: true,
      permissions: ['dashboard.access', 'killfeed.manage'],
      slots: [{ id: 'conn-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, { enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500, playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [{ id: CHANNEL_ID, name: 'killfeed', type: 0, parentId: null }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/killfeed` && method === 'GET') {
      if (opts.listFailure) return json(route, { error: 'Nitrado momentan nicht erreichbar' }, 503);
      return json(route, { kind: url.searchParams.get('kind') ?? 'DEATH', configs: [feed()] });
    }

    if (method !== 'GET') {
      let body: unknown = null;
      try { body = req.postDataJSON(); } catch { body = req.postData(); }
      mutations.push({ method, path, query: url.search, body });
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/killfeed` && method === 'POST') {
      return opts.saveFailure ? json(route, { error: 'FEED_SAVE_FAILED' }, 409) : json(route, feed({ id: 'feed-new' }), 201);
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}` && method === 'PATCH') {
      if (opts.actionDelayMs) await new Promise(resolve => setTimeout(resolve, opts.actionDelayMs));
      return opts.saveFailure ? json(route, { error: 'FEED_SAVE_FAILED' }, 409) : json(route, feed());
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}` && method === 'DELETE') return json(route, { ok: true, deleted: 1 });
    return json(route, {});
  });
  return mutations;
}

function find(mutations: Mutation[], method: string, path: string) {
  return mutations.find(row => row.method === method && row.path === path);
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Authenticated Killfeed & ADM', () => {
  test('List, Toggle, Create, Edit und Delete bleiben exakt Guild+Slot+Kind-gescoped', async ({ page }) => {
    const mutations = await stub(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=killfeed`);

    await expect(page.getByRole('heading', { name: 'Nitrado Gameplay-Feeds' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '#killfeed' })).toBeVisible();

    const configCard = page.getByRole('heading', { name: '#killfeed' }).locator('xpath=ancestor::div[.//button][1]');
    await configCard.getByRole('button').first().click();
    await expect.poll(() => find(mutations, 'PATCH', `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}`)).toBeTruthy();
    expect(find(mutations, 'PATCH', `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}`)).toMatchObject({
      query: `?slot=${SLOT}&kind=DEATH`,
      body: { isActive: false },
    });

    await page.getByRole('button', { name: /Neu/ }).click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByLabel('Discord-Channel').selectOption(CHANNEL_ID);
    await createDialog.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => find(mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/killfeed`)).toBeTruthy();
    expect(find(mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/killfeed`)).toMatchObject({
      query: `?slot=${SLOT}&kind=DEATH`,
      body: {
        channelId: CHANNEL_ID,
        categories: ['PVP', 'DEATH', 'SUICIDE', 'NPC', 'VEHICLE'],
        showActorCoords: true,
        showTargetCoords: false,
        showTool: true,
        showDistance: true,
        embedColor: '#dc2626',
        isActive: true,
      },
    });

    await page.getByRole('button', { name: 'Bearbeiten' }).click();
    const editDialog = page.getByRole('dialog');
    await editDialog.getByLabel('Embed-Farbe').fill('#112233');
    await editDialog.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => mutations.filter(row => row.method === 'PATCH' && row.path.endsWith(`/killfeed/${CONFIG_ID}`)).length).toBeGreaterThanOrEqual(2);
    const edit = mutations.filter(row => row.method === 'PATCH' && row.path.endsWith(`/killfeed/${CONFIG_ID}`)).at(-1);
    expect(edit).toMatchObject({ query: `?slot=${SLOT}&kind=DEATH`, body: expect.objectContaining({ embedColor: '#112233' }) });

    page.once('dialog', dialog => void dialog.accept());
    await configCard.getByRole('button').last().click();
    await expect.poll(() => find(mutations, 'DELETE', `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}`)).toBeTruthy();
    expect(find(mutations, 'DELETE', `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}`)?.query).toBe(`?slot=${SLOT}&kind=DEATH`);
  });

  test('Editor validiert lokal und Backend-Save-Fehler bleibt sichtbar', async ({ page }) => {
    const mutations = await stub(page, { saveFailure: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=killfeed`);
    await page.getByRole('button', { name: /Neu/ }).click();
    const dialog = page.getByRole('dialog');

    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog.getByText('Channel, gültige Farbe und mindestens eine Kategorie sind erforderlich.')).toBeVisible();
    expect(mutations.filter(row => row.method === 'POST' && row.path.endsWith('/killfeed'))).toHaveLength(0);

    await dialog.getByLabel('Discord-Channel').selectOption(CHANNEL_ID);
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    await expect(dialog.getByText(/FEED_SAVE_FAILED/)).toBeVisible();
  });

  test('synchroner Doppel-Klick erzeugt nur eine Toggle-Mutation', async ({ page }) => {
    const mutations = await stub(page, { actionDelayMs: 200 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=killfeed`);

    const toggle = page.getByRole('button', { name: 'Deathfeed deaktivieren' });
    await toggle.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });

    await expect.poll(() => mutations.filter(row => (
      row.method === 'PATCH' && row.path === `/api/v2/guilds/${GUILD_ID}/killfeed/${CONFIG_ID}`
    )).length).toBe(1);
    await expect(toggle).toBeEnabled();
  });

  test('503-Listenfehler wird als echter Fehlerzustand angezeigt', async ({ page }) => {
    await stub(page, { listFailure: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=killfeed`);
    await expect(page.getByText(/Nitrado momentan nicht erreichbar/)).toBeVisible();
  });
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px Killfeed bleibt ohne Seiten-Overflow`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=killfeed`);
    await expect(page.getByRole('heading', { name: 'Nitrado Gameplay-Feeds' })).toBeVisible();
    await page.getByRole('button', { name: /Neu/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await noOverflow(page);
  });
}
