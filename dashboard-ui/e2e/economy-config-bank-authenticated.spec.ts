import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const SLOT = '1';
const BANK_CHANNEL = '123456789012345679';

interface EconomyConfig {
  enabled: boolean;
  currencyName: string;
  emoji: string;
  startBalance: number;
  playtimeRewardPercent: number;
  bankInterestPercent: number;
  bankChannelId: string | null;
}

interface Mutation {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown>;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubEconomyConfig(page: Page) {
  let config: EconomyConfig = {
    enabled: true,
    currencyName: 'Maeuse',
    emoji: '🐭',
    startBalance: 500,
    playtimeRewardPercent: 2,
    bankInterestPercent: 3,
    bankChannelId: null,
  };
  let settingsReads = 0;
  let failNextPut = false;
  let canonicalizeNextCurrency = false;
  const mutations: Mutation[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'economy-config-admin', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'economy-config-admin', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      guildId: GUILD_ID,
      alias5: 'CHAOS',
      isOwner: true,
      permissions: ['dashboard.access', 'economy.manage', 'casino.manage'],
      slots: [{ id: 'conn-economy-1', slot: 1, alias: 'Chernarus', alias5: 'ECO01', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      settingsReads += 1;
      return json(route, { whitelistActive: true, economyActive: config.enabled, permaOnly: false });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      if (method === 'PUT') {
        const body = req.postDataJSON() as Record<string, unknown>;
        mutations.push({ method, path, query: url.search, body });
        if (failNextPut) {
          failNextPut = false;
          return json(route, { error: 'ECONOMY_CONFIG_BLOCKED' }, 400);
        }
        config = { ...config, ...body } as EconomyConfig;
        if (canonicalizeNextCurrency) {
          canonicalizeNextCurrency = false;
          config.currencyName = 'Server-Canonical';
        }
        return json(route, { nitradoConnId: 'conn-economy-1', ...config });
      }
      return json(route, { nitradoConnId: 'conn-economy-1', ...config });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-economy-1', detectedActiveServerCount: 1, resolvedAt: '2026-08-19T10:00:00.000Z' },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: config.enabled, currencyName: config.currencyName, emoji: config.emoji, accounts: 0, links: 0, transactions: 0 },
      bank: { totalWallet: '0', totalBank: '0', interestPercent: config.bankInterestPercent, bankChannelId: config.bankChannelId },
      casino: { gamesConfigured: 0, gamesEnabled: 0, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
      recentTransactions: [],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, {
      channels: [{ id: BANK_CHANNEL, name: 'bank', type: 0, parentId: null }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts`) return json(route, { accounts: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) return json(route, { members: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) return json(route, { round: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) return json(route, { rounds: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/vendors`) return json(route, { vendors: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/listings`) return json(route, { listings: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases`) return json(route, { purchases: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) return json(route, { games: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) return json(route, { stats: [] });

    return json(route, {});
  });

  return {
    mutations,
    settingsReads: () => settingsReads,
    failNextPut: () => { failNextPut = true; },
    canonicalizeNextCurrency: () => { canonicalizeNextCurrency = true; },
  };
}

function configWrite(mutations: Mutation[], index = 0): Mutation | undefined {
  return mutations.filter(row => row.path.endsWith('/economy/config') && row.method === 'PUT')[index];
}

function currencyInput(page: Page) {
  return page.getByText('Waehrungsname').locator('..').locator('input');
}

function interestInput(page: Page) {
  return page.getByText('Tageszins (%)').locator('..').locator('input');
}

function bankSelect(page: Page) {
  return page.getByText('Bank-Channel').locator('..').locator('select');
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Economy Config + Bank authenticated contract', () => {
  test('Config-Write ist exakt gescoped, uebernimmt kanonische Response und synchronisiert Settings', async ({ page }) => {
    const state = await stubEconomyConfig(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(currencyInput(page)).toHaveValue('Maeuse');
    await expect.poll(state.settingsReads).toBeGreaterThanOrEqual(1);
    const settingsReadsBeforeSave = state.settingsReads();

    state.canonicalizeNextCurrency();
    await currencyInput(page).fill('Client-Name');
    await page.getByRole('button', { name: 'Update', exact: true }).click();

    await expect.poll(() => configWrite(state.mutations, 0)).toBeTruthy();
    expect(configWrite(state.mutations, 0)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: {
        enabled: true,
        currencyName: 'Client-Name',
        emoji: '🐭',
        startBalance: 500,
        playtimeRewardPercent: 2,
      },
    });
    await expect(currencyInput(page)).toHaveValue('Server-Canonical');
    await expect.poll(state.settingsReads).toBeGreaterThan(settingsReadsBeforeSave);
  });

  test('Bank-Write sendet nur Bankfelder im exakten Slot-Scope', async ({ page }) => {
    const state = await stubEconomyConfig(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);

    await expect(bankSelect(page)).toBeVisible();
    await bankSelect(page).selectOption(BANK_CHANNEL);
    await interestInput(page).fill('7');
    await page.getByRole('button', { name: 'Bank speichern', exact: true }).click();

    await expect.poll(() => configWrite(state.mutations, 0)).toBeTruthy();
    expect(configWrite(state.mutations, 0)).toEqual({
      method: 'PUT',
      path: `/api/v2/guilds/${GUILD_ID}/economy/config`,
      query: `?slot=${SLOT}`,
      body: { bankChannelId: BANK_CHANNEL, bankInterestPercent: 7 },
    });
  });

  test('Save-Fehler wird sichtbar und ungueltige Pflichtfelder blockieren den Write', async ({ page }) => {
    const state = await stubEconomyConfig(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await currencyInput(page).fill('');
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    expect(state.mutations).toHaveLength(0);

    await currencyInput(page).fill('Gueltig');
    state.failNextPut();
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByText(/Economy-Konfiguration konnte nicht gespeichert werden:/)).toBeVisible();
    await expect(page.getByText(/ECONOMY_CONFIG_BLOCKED/)).toBeVisible();
  });

  test('numerische Config-Eingaben bleiben im Backend-Contract', async ({ page }) => {
    const state = await stubEconomyConfig(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    const startBalance = page.getByText('Startguthaben (neue Members)').locator('..').locator('input');
    const reward = page.getByText('Spielzeit-Belohnung %/min').locator('..').locator('input');
    await startBalance.fill('1000000001');
    await reward.fill('12.9');
    await page.getByRole('button', { name: 'Update', exact: true }).click();

    await expect.poll(() => configWrite(state.mutations, 0)).toBeTruthy();
    expect(configWrite(state.mutations, 0)?.body).toMatchObject({
      startBalance: 1000000000,
      playtimeRewardPercent: 12,
    });
  });
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px Economy Config + Bank bleibt ohne Seiten-Overflow`, async ({ page }) => {
    await stubEconomyConfig(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByRole('heading', { name: 'Economy-Konfiguration' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
    await noPageOverflow(page);

    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);
    await expect(page.getByRole('heading', { name: 'Bank', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bank speichern', exact: true })).toBeVisible();
    await noPageOverflow(page);
  });
}
