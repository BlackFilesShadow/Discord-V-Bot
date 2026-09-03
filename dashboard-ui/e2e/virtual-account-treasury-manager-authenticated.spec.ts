import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const SLOT = '1';
const LIVE_CHANNEL_ID = '123456789012345679';
const ARCHIVE_CHANNEL_ID = '123456789012345680';
const CATEGORY_ID = '123456789012345681';
const ACCOUNT_ID = 'acct-configured';
const TREASURY_ID = 'acct-treasury';

interface Mutation {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    kind: 'CUSTOM',
    name: 'Eventkasse',
    walletBalance: '0',
    bankBalance: '0',
    totalBalance: '0',
    status: 'ACTIVE',
    acceptUserTransfers: true,
    expiresAt: null,
    archivedAt: null,
    createdAt: '2026-09-03T05:00:00.000Z',
    description: 'Event-Budget',
    channelId: LIVE_CHANNEL_ID,
    archiveChannelId: ARCHIVE_CHANNEL_ID,
    currencyName: 'Maeuse',
    currencyEmoji: '🐭',
    accountEmoji: '🏦',
    bannerUrl: null,
    textStyle: 'NORMAL',
    exchangePlayerUnits: null,
    exchangeAccountUnits: null,
    accountPurpose: 'GENERAL',
    managers: [],
    projection: { channelId: LIVE_CHANNEL_ID, messageId: 'message-1', archiveThreadId: null, lastSyncedAt: null, lastSyncError: null },
    ...overrides,
  };
}

async function stubVirtualWorkspace(page: Page) {
  const mutations: Mutation[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'virtual-auditor', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'virtual-auditor', avatar: null, role: 'ADMIN' },
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
      permissions: ['dashboard.access', 'economy.view', 'economy.manage'],
      slots: [{ id: 'conn-audit-1', slot: 1, alias: 'Chernarus', alias5: 'AUD01', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      nitradoConnId: 'conn-audit-1', enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500,
      playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-audit-1', detectedActiveServerCount: 1, resolvedAt: '2026-09-03T05:00:00.000Z' },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 1, links: 0, transactions: 0 },
      bank: { totalWallet: '0', totalBank: '0', interestPercent: 3, bankChannelId: null },
      casino: { gamesConfigured: 0, gamesEnabled: 0, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
      recentTransactions: [],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, {
      channels: [
        { id: LIVE_CHANNEL_ID, name: 'events', type: 0, parentId: null },
        { id: ARCHIVE_CHANNEL_ID, name: 'events-archiv', type: 0, parentId: null },
        { id: CATEGORY_ID, name: 'Economy', type: 4, parentId: null },
      ],
    });

    const base = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts`;
    if (path === `${base}/control/accounts` && method === 'GET') return json(route, { accounts: [account()] });
    if (path === `${base}/control/members` && method === 'GET') return json(route, { members: [] });
    if (path === `${base}/members` && method === 'GET') return json(route, { members: [] });
    if (path === `${base}/control/manager-panel` && method === 'GET') return json(route, { panel: null });
    if (path === `${base}/control/manager-panel` && method === 'PUT') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      return json(route, { panel: { channelId: body.channelId, messageId: 'manager-message-1' } });
    }
    if (path === `${base}/control/bank-treasury` && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      return json(route, {
        account: account({ id: TREASURY_ID, name: 'Serverbank', accountPurpose: 'BANK_TREASURY', channelId: null, archiveChannelId: null, projection: null }),
        syncWarning: null,
      });
    }
    if (path === `${base}/control/accounts/${ACCOUNT_ID}` && method === 'PUT') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      return json(route, {
        account: account({ ...body, description: body.description }),
        syncWarning: 'Konto-Embed: fehlende Discord-Berechtigung',
      });
    }
    if (path === `${base}/control/accounts/${ACCOUNT_ID}/sync` && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      return json(route, { ok: true, account: account() });
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) return json(route, { round: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) return json(route, { rounds: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/vendors`) return json(route, { vendors: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/listings`) return json(route, { listings: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases`) return json(route, { purchases: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) return json(route, { games: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) return json(route, { stats: [] });

    return json(route, {});
  });

  return mutations;
}

function findMutation(mutations: Mutation[], path: string, method?: string): Mutation | undefined {
  return mutations.find(row => row.path === path && (!method || row.method === method));
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=virtual-accounts`);
  await expect(page.locator('h2').filter({ hasText: 'Virtuelle Konten' })).toBeVisible();
}

test.describe('Virtual account treasury + manager authenticated contracts', () => {
  test('Serverbank und Management-Kanal bleiben exakt Guild+Slot-gescoped', async ({ page }) => {
    const mutations = await stubVirtualWorkspace(page);
    await openWorkspace(page);

    await page.getByRole('button', { name: 'Serverbank anlegen', exact: true }).click();
    const treasuryPath = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/bank-treasury`;
    await expect.poll(() => findMutation(mutations, treasuryPath, 'POST')).toBeTruthy();
    expect(findMutation(mutations, treasuryPath, 'POST')).toEqual({
      method: 'POST', path: treasuryPath, query: `?slot=${SLOT}`, body: {},
    });
    await expect(page.getByText('Serverbank „Serverbank“ ist bereit.')).toBeVisible();

    const managerBlock = page.getByText('Management-Kanal', { exact: true })
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    const managerSelect = managerBlock.locator('select');
    await expect(managerSelect.locator('option')).toHaveCount(3); // Placeholder + zwei Textkanaele; Kategorie bleibt ausgeschlossen.
    await managerSelect.selectOption(LIVE_CHANNEL_ID);
    await managerBlock.getByRole('button', { name: 'Management-Kanal speichern', exact: true }).click();

    const managerPath = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/manager-panel`;
    await expect.poll(() => findMutation(mutations, managerPath, 'PUT')).toBeTruthy();
    expect(findMutation(mutations, managerPath, 'PUT')).toEqual({
      method: 'PUT', path: managerPath, query: `?slot=${SLOT}`, body: { channelId: LIVE_CHANNEL_ID },
    });
    await expect(page.getByText(/Management-Kanal synchronisiert/)).toBeVisible();
  });

  test('Konfiguration zeigt SyncWarning wahrheitsgemäß und manueller Sync bleibt exakt gescoped', async ({ page }) => {
    const mutations = await stubVirtualWorkspace(page);
    await openWorkspace(page);

    const row = page.getByText('Eventkasse', { exact: false })
      .locator('xpath=ancestor::div[contains(@class,"bg-bg-elev/40")][1]');
    await row.getByRole('button', { name: 'Konfigurieren', exact: true }).click();
    await row.getByText('Beschreibung', { exact: true }).locator('..').locator('textarea').fill('Neu konfiguriert');
    await row.getByRole('button', { name: 'Speichern', exact: true }).click();

    const updatePath = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts/${ACCOUNT_ID}`;
    await expect.poll(() => findMutation(mutations, updatePath, 'PUT')).toBeTruthy();
    expect(findMutation(mutations, updatePath, 'PUT')).toMatchObject({
      method: 'PUT',
      path: updatePath,
      query: `?slot=${SLOT}`,
      body: {
        description: 'Neu konfiguriert',
        channelId: LIVE_CHANNEL_ID,
        archiveChannelId: ARCHIVE_CHANNEL_ID,
        acceptUserTransfers: true,
        managers: [],
      },
    });
    await expect(page.getByText('Gespeichert. Discord-Sync: Konto-Embed: fehlende Discord-Berechtigung')).toBeVisible();

    await row.getByRole('button', { name: 'Sync', exact: true }).click();
    const syncPath = `${updatePath}/sync`;
    await expect.poll(() => findMutation(mutations, syncPath, 'POST')).toBeTruthy();
    expect(findMutation(mutations, syncPath, 'POST')).toEqual({
      method: 'POST', path: syncPath, query: `?slot=${SLOT}`, body: {},
    });
    await expect(page.getByText('Discord-Projektion für „Eventkasse“ synchronisiert.')).toBeVisible();
  });
});