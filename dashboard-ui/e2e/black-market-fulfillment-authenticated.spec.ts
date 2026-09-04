import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const BUYER_ID = '223456789012345678';
const SLOT = '1';
const PURCHASE_ID = 'purchase-pending-1';

interface Mutation {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown>;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function pendingPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: PURCHASE_ID,
    listingId: 'listing-1',
    vendorAccountId: 'vendor-1',
    userDiscordId: BUYER_ID,
    sourcePocket: 'BANK',
    quantity: 2,
    unitPrice: '2500',
    amount: '5000',
    createdAt: '2026-09-03T05:00:00.000Z',
    fulfillmentStatus: 'PENDING',
    deliveryItems: [{ itemText: 'M4A1', quantity: 2 }],
    fulfilledAt: null,
    fulfillmentNote: null,
    refundedAt: null,
    refundReason: null,
    ...overrides,
  };
}

async function stubMarket(page: Page) {
  const mutations: Mutation[] = [];
  let purchase = pendingPurchase();

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'market-manager', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'market-manager', avatar: null, role: 'ADMIN' },
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
      slots: [{ id: 'conn-market-audit', slot: 1, alias: 'Chernarus', alias5: 'MKA01', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, {
      whitelistActive: true, economyActive: true, permaOnly: false,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      nitradoConnId: 'conn-market-audit', enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500,
      playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-market-audit', detectedActiveServerCount: 1, resolvedAt: '2026-09-03T05:00:00.000Z' },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 1, links: 0, transactions: 1 },
      bank: { totalWallet: '0', totalBank: '0', interestPercent: 3, bankChannelId: null },
      casino: { gamesConfigured: 0, gamesEnabled: 0, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
      recentTransactions: [],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [] });

    const marketBase = `/api/v2/guilds/${GUILD_ID}/economy/black-market`;
    if (path === `${marketBase}/discord` && method === 'GET') return json(route, { projection: null });
    if (path === `${marketBase}/vendors` && method === 'GET') return json(route, {
      vendors: [{ id: 'vendor-1', name: 'Nachtmarkt', balance: '5000', pendingLiability: '5000', withdrawableBalance: '0', status: 'ACTIVE', createdAt: '2026-09-03T04:00:00.000Z' }],
    });
    if (path === `${marketBase}/listings` && method === 'GET') return json(route, {
      listings: [{ id: 'listing-1', vendorAccountId: 'vendor-1', sku: 'M4', name: 'M4A1', description: null, price: '2500', active: true, archivedAt: null, createdAt: '2026-09-03T04:00:00.000Z', deliveryItems: [{ itemText: 'M4A1', quantity: 1 }] }],
    });
    if (path === `${marketBase}/purchases` && method === 'GET') return json(route, { purchases: [purchase] });
    if (path === `${marketBase}/purchases/${PURCHASE_ID}/deliver` && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      purchase = pendingPurchase({ fulfillmentStatus: 'DELIVERED', fulfilledAt: '2026-09-03T05:10:00.000Z', fulfillmentNote: 'Dashboard' });
      return json(route, { changed: true, purchase });
    }
    if (path === `${marketBase}/purchases/${PURCHASE_ID}/refund` && method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      purchase = pendingPurchase({ fulfillmentStatus: 'REFUNDED', refundedAt: '2026-09-03T05:10:00.000Z', refundReason: body.reason });
      return json(route, { booked: true, purchase, syncWarning: 'Katalog konnte nach Refund nicht synchronisiert werden.' });
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) return json(route, { round: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) return json(route, { rounds: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts`) return json(route, { accounts: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/manager-panel`) return json(route, { panel: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/members`) return json(route, { members: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) return json(route, { members: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) return json(route, { games: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) return json(route, { stats: [] });

    return json(route, {});
  });

  return mutations;
}

function mutation(mutations: Mutation[], path: string): Mutation | undefined {
  return mutations.find(row => row.path === path);
}

async function openEconomy(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=virtual-accounts`);
  await expect(page.getByText('Bestellungen & Auslieferung')).toBeVisible();
  await expect(page.getByText('M4A1 × 2', { exact: true })).toBeVisible();
}

test.describe('Black market fulfillment authenticated contracts', () => {
  test('Geliefert markiert exakt die gescopte Bestellung und entfernt offene Aktionen', async ({ page }) => {
    const mutations = await stubMarket(page);
    await openEconomy(page);

    await page.getByRole('button', { name: 'Geliefert', exact: true }).click();
    const path = `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases/${PURCHASE_ID}/deliver`;
    await expect.poll(() => mutation(mutations, path)).toBeTruthy();
    expect(mutation(mutations, path)).toEqual({ method: 'POST', path, query: `?slot=${SLOT}`, body: {} });
    await expect(page.getByText(`Bestellung ${PURCHASE_ID} als geliefert markiert.`)).toBeVisible();
    await expect(page.getByText('GELIEFERT', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
  });

  test('Refund übergibt den Grund exakt und zeigt post-save Discord-Warnung statt False-Success', async ({ page }) => {
    const mutations = await stubMarket(page);
    await openEconomy(page);

    await page.getByLabel(`Refund-Grund ${PURCHASE_ID}`).fill('Spieler konnte Ware nicht abholen');
    await page.getByRole('button', { name: 'Refund', exact: true }).click();
    const path = `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases/${PURCHASE_ID}/refund`;
    await expect.poll(() => mutation(mutations, path)).toBeTruthy();
    expect(mutation(mutations, path)).toEqual({
      method: 'POST', path, query: `?slot=${SLOT}`, body: { reason: 'Spieler konnte Ware nicht abholen' },
    });
    await expect(page.getByText(/vollständig refundiert\. Discord-Sync: Katalog konnte nach Refund nicht synchronisiert werden/)).toBeVisible();
    await expect(page.getByText('REFUNDIERT', { exact: true })).toBeVisible();
  });
});