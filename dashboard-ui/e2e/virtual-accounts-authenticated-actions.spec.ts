import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const MEMBER_DISCORD_ID = '223456789012345678';
const MEMBER_GUID = '11111111-1111-4111-8111-111111111111';
const SLOT = '1';
const LIVE_CHANNEL_ID = '123456789012345679';
const ARCHIVE_CHANNEL_ID = '123456789012345680';
const ZERO_ACCOUNT = 'acct-zero';
const FUNDED_ACCOUNT = 'acct-funded';
const DELETE_ACCOUNT = 'acct-delete';

interface Mutation {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function account(id: string, name: string, walletBalance: string, bankBalance = '0') {
  const totalBalance = (BigInt(walletBalance) + BigInt(bankBalance)).toString();
  return {
    id,
    kind: 'CUSTOM',
    name,
    walletBalance,
    bankBalance,
    totalBalance,
    status: 'ACTIVE',
    acceptUserTransfers: true,
    expiresAt: null,
    archivedAt: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    description: id === FUNDED_ACCOUNT ? 'Eventtopf' : null,
    channelId: null,
    archiveChannelId: null,
    currencyName: 'Maeuse',
    currencyEmoji: '🐭',
    accountEmoji: '🏦',
    bannerUrl: null,
    textStyle: 'NORMAL',
    exchangePlayerUnits: null,
    exchangeAccountUnits: null,
    accountPurpose: 'GENERAL',
    managers: [],
    projection: null,
  };
}

async function stubEconomy(page: Page, opts: { payoutError?: boolean } = {}) {
  const mutations: Mutation[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'virtual-admin', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'virtual-admin', avatar: null, role: 'ADMIN' },
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
      slots: [{ id: 'conn-virtual-1', slot: 1, alias: 'Chernarus', alias5: 'VA001', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      enabled: true,
      currencyName: 'Maeuse',
      emoji: '🐭',
      startBalance: 500,
      playtimeRewardPercent: 2,
      bankInterestPercent: 3,
      bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-virtual-1', detectedActiveServerCount: 1, resolvedAt: '2026-08-19T10:00:00.000Z' },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 3, links: 0, transactions: 0 },
      bank: { totalWallet: '0', totalBank: '0', interestPercent: 3, bankChannelId: null },
      casino: { gamesConfigured: 0, gamesEnabled: 0, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
      recentTransactions: [],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, {
      channels: [
        { id: LIVE_CHANNEL_ID, name: 'events', type: 0, parentId: null },
        { id: ARCHIVE_CHANNEL_ID, name: 'events-archiv', type: 0, parentId: null },
      ],
    });

    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/members` && method === 'GET') return json(route, {
      members: [{ discordId: MEMBER_DISCORD_ID, username: 'alice', displayName: 'Alice', avatar: null }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members` && method === 'GET') return json(route, {
      members: [{ id: MEMBER_GUID, discordId: MEMBER_DISCORD_ID, username: 'alice', displayName: 'Alice', avatar: null }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/manager-panel` && method === 'GET') return json(route, { panel: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts` && method === 'GET') return json(route, {
      accounts: [
        account(ZERO_ACCOUNT, 'Leere Kasse', '0'),
        account(FUNDED_ACCOUNT, 'Eventkasse', '5000', '250'),
        account(DELETE_ACCOUNT, 'Löschbare Kasse', '0'),
      ],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts` && method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      return json(route, {
        account: {
          ...account('acct-created', String(body.name), '0'),
          description: body.description,
          channelId: body.channelId,
          archiveChannelId: body.archiveChannelId,
          currencyName: body.currencyName,
          currencyEmoji: body.currencyEmoji,
          accountEmoji: body.accountEmoji,
        },
        syncWarning: null,
      }, 201);
    }
    if ((path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts/${DELETE_ACCOUNT}`
      || path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts/${FUNDED_ACCOUNT}`) && method === 'DELETE') {
      mutations.push({ method, path, query: url.search, body: null });
      return json(route, {
        ok: true,
        deleted: {
          id: path.endsWith(FUNDED_ACCOUNT) ? FUNDED_ACCOUNT : DELETE_ACCOUNT,
          name: path.endsWith(FUNDED_ACCOUNT) ? 'Eventkasse' : 'Löschbare Kasse',
          mode: 'HARD_DELETED',
          walletRemoved: path.endsWith(FUNDED_ACCOUNT) ? '5000' : '0',
          bankRemoved: path.endsWith(FUNDED_ACCOUNT) ? '250' : '0',
          domainPreserved: false,
        },
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/${ZERO_ACCOUNT}/entries` && method === 'GET') return json(route, {
      entries: [{ id: 'entry-1', delta: '250', entryType: 'ADMIN', sourcePocket: null, actorDiscordId: USER_ID, userDiscordId: null, reason: 'Audit Test', createdAt: '2026-08-19T10:05:00.000Z' }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/${ZERO_ACCOUNT}/archive` && method === 'POST') {
      mutations.push({ method, path, query: url.search, body: {} });
      return json(route, { id: ZERO_ACCOUNT, status: 'ARCHIVED' });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/${FUNDED_ACCOUNT}/payout` && method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      if (opts.payoutError) return json(route, { error: 'PAYOUT_TARGET_STALE' }, 400);
      return json(route, { ok: true, booked: true, account: account(FUNDED_ACCOUNT, 'Eventkasse', '4750', '250'), syncWarning: null });
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

function mutation(mutations: Mutation[], path: string) {
  return mutations.find(row => row.path === path);
}

async function gotoVirtualAccounts(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=virtual-accounts`);
  await expect(page.locator('h2').filter({ hasText: 'Virtuelle Konten' })).toBeVisible();
}

function payoutPanel(page: Page) {
  return page.getByRole('button', { name: 'Auszahlen', exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
}

async function selectPayoutMember(page: Page): Promise<void> {
  const payout = payoutPanel(page);
  await payout.getByRole('button', { name: /Discord-User suchen/ }).click();
  await expect(page.getByRole('option', { name: /Alice/ })).toBeVisible();
  await page.getByRole('option', { name: /Alice/ }).click();
}

async function noOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Authenticated virtual-account actions', () => {
  test('Create und Audit bleiben exakt Guild+Slot-gescoped und nutzen getrennte Live-/Archivkanaele', async ({ page }) => {
    const mutations = await stubEconomy(page);
    await gotoVirtualAccounts(page);

    await page.getByPlaceholder('z. B. Eventkasse').fill('Turnierkasse');
    await page.getByPlaceholder('Zweck des Kontos…').fill('Gewinne fuer das Turnier');
    await page.getByText('Hauptkanal / Live-Embed').locator('..').locator('select').selectOption(LIVE_CHANNEL_ID);
    await expect(page.getByText('Bei Discord-Integration muss ein separater Archiv-Kanal ausgewählt werden.')).toBeVisible();
    await page.getByText('Archiv-Kanal / Transaktions-Threads').locator('..').locator('select').selectOption(ARCHIVE_CHANNEL_ID);
    await page.getByRole('button', { name: 'Konto erstellen' }).click();

    const createPath = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts`;
    await expect.poll(() => mutation(mutations, createPath)).toBeTruthy();
    expect(mutation(mutations, createPath)).toMatchObject({
      method: 'POST',
      query: `?slot=${SLOT}`,
      body: {
        name: 'Turnierkasse',
        description: 'Gewinne fuer das Turnier',
        channelId: LIVE_CHANNEL_ID,
        archiveChannelId: ARCHIVE_CHANNEL_ID,
        currencyName: 'Coins',
        currencyEmoji: '💰',
        accountEmoji: '🏦',
        acceptUserTransfers: true,
        managers: [],
        expiresAt: null,
      },
    });
    await expect(page.getByText(/Konto „Turnierkasse“ erstellt/)).toBeVisible();

    const zeroRow = page.getByText('Leere Kasse', { exact: false })
      .locator('xpath=ancestor::div[.//button[normalize-space()="Audit"]][1]');
    await zeroRow.getByRole('button', { name: 'Audit', exact: true }).click();
    await expect(page.getByText(/Audit Test/)).toBeVisible();

    await expect(zeroRow.getByRole('button', { name: 'Archivieren', exact: true })).toHaveCount(0);
  });

  test('Hard-Delete löscht ein aktives Konto mit Guthaben nach zwei Klicks und bleibt exakt Guild+Slot-gescoped', async ({ page }) => {
    const mutations = await stubEconomy(page);
    await gotoVirtualAccounts(page);

    const fundedRow = page.getByText('Eventkasse', { exact: false })
      .locator('xpath=ancestor::div[contains(@class,"bg-bg-elev/40")][1]');
    const fundedDelete = fundedRow.getByRole('button', { name: 'Löschen', exact: true });
    await expect(fundedDelete).toBeEnabled();

    const deletePath = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts/${FUNDED_ACCOUNT}`;
    const row = fundedRow;

    await row.getByRole('button', { name: 'Löschen', exact: true }).click();
    expect(mutation(mutations, deletePath)).toBeUndefined();
    await expect(row.getByRole('button', { name: 'Wirklich löschen?', exact: true })).toBeVisible();
    await expect(page.getByText(/Sein Wallet- und Bankguthaben werden mit diesem Konto gelöscht/)).toBeVisible();
    await expect(page.getByText(/Historische Buchungen und Referenzen bleiben erhalten/)).toBeVisible();

    await row.getByRole('button', { name: 'Wirklich löschen?', exact: true }).click();
    await expect.poll(() => mutation(mutations, deletePath)).toBeTruthy();
    expect(mutation(mutations, deletePath)).toMatchObject({ method: 'DELETE', query: `?slot=${SLOT}`, body: null });
    await expect(page.getByText(/Konto „Eventkasse“ wurde dauerhaft gelöscht/)).toBeVisible();
    await expect(page.getByText(/Historische Buchungen und Referenzen bleiben erhalten/)).toBeVisible();
  });

  test('Payout nutzt kanonische User-GUID, beide Pockets, Idempotency und exakten Slot-Scope', async ({ page }) => {
    const mutations = await stubEconomy(page);
    await gotoVirtualAccounts(page);

    const payout = payoutPanel(page);
    await payout.getByText('Konto', { exact: true }).locator('..').locator('select').selectOption(FUNDED_ACCOUNT);
    await selectPayoutMember(page);
    await payout.getByText('Betrag in Konto-Währung').locator('..').locator('input').fill('250');
    await payout.getByText('Quelle', { exact: true }).locator('..').locator('select').selectOption('BANK');
    await payout.getByText('Ziel beim Spieler').locator('..').locator('select').selectOption('BANK');
    await payout.getByPlaceholder('Optional').fill('Turnier Refund');
    await payout.getByRole('button', { name: 'Auszahlen', exact: true }).click();

    const path = `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/${FUNDED_ACCOUNT}/payout`;
    await expect.poll(() => mutation(mutations, path)).toBeTruthy();
    const write = mutation(mutations, path)!;
    expect(write.query).toBe(`?slot=${SLOT}`);
    expect(write.body).toMatchObject({
      userId: MEMBER_GUID,
      amount: '250',
      sourcePocket: 'BANK',
      targetPocket: 'BANK',
      reason: 'Turnier Refund',
    });
    expect(String(write.body?.operationId ?? '')).toMatch(/^[A-Za-z0-9._:-]+$/);
    await expect(page.getByText('Admin-Auszahlung atomar gebucht.')).toBeVisible();
  });

  test('Payout-Backendfehler bleibt sichtbar und wird nicht als Erfolg behandelt', async ({ page }) => {
    await stubEconomy(page, { payoutError: true });
    await gotoVirtualAccounts(page);

    const payout = payoutPanel(page);
    await payout.getByText('Konto', { exact: true }).locator('..').locator('select').selectOption(FUNDED_ACCOUNT);
    await selectPayoutMember(page);
    await payout.getByText('Betrag in Konto-Währung').locator('..').locator('input').fill('250');
    await payout.getByPlaceholder('Optional').fill('Turnier Refund');
    await payout.getByRole('button', { name: 'Auszahlen', exact: true }).click();

    await expect(page.getByText(/PAYOUT_TARGET_STALE/)).toBeVisible();
    await expect(page.getByText('Admin-Auszahlung atomar gebucht.')).toHaveCount(0);
  });
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px virtuelle Konten bleiben ohne Seiten-Overflow`, async ({ page }) => {
    await stubEconomy(page);
    await page.setViewportSize({ width, height: 1000 });
    await gotoVirtualAccounts(page);
    await expect(page.getByRole('button', { name: 'Auszahlen', exact: true })).toBeVisible();
    await noOverflow(page);
  });
}
