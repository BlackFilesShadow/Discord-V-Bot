import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const OTHER_USER = '223456789012345678';
const USER_GUID = '123e4567-e89b-42d3-a456-426614174000';
const SLOT = '1';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAuthenticatedEconomy(page: Page, opts: { purchaseError?: boolean } = {}) {
  let configWrite: Record<string, unknown> | null = null;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'economy-admin', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'economy-admin', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/guilds/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      isOwner: true,
      permissions: ['dashboard.access', 'economy.manage', 'economy.view'],
      slots: [{ id: 'conn-economy-1', slot: 1, alias: 'Chernarus', alias5: 'ECO01', status: 'ACTIVE' }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      if (method === 'PUT') {
        configWrite = req.postDataJSON() as Record<string, unknown>;
        return json(route, {
          enabled: configWrite.enabled ?? true,
          currencyName: configWrite.currencyName ?? 'Maeuse',
          emoji: configWrite.emoji ?? '🐭',
          startBalance: configWrite.startBalance ?? 500,
          playtimeRewardPercent: configWrite.playtimeRewardPercent ?? 2,
          bankInterestPercent: configWrite.bankInterestPercent ?? 3,
          bankChannelId: configWrite.bankChannelId ?? null,
        });
      }
      return json(route, { enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500, playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-economy-1', detectedActiveServerCount: 1, resolvedAt: '2026-08-19T06:00:00.000Z' },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 12, links: 9, transactions: 44 },
      bank: { totalWallet: '12500', totalBank: '33000', interestPercent: 3, bankChannelId: null },
      casino: { gamesConfigured: 4, gamesEnabled: 2, rounds: 8, totalBet: '5000', totalPayout: '4200', houseEdge: '800', stats: [] },
      recentTransactions: [{ id: 'ledger-1', userDiscordId: OTHER_USER, delta: '750', type: 'GRANT', reason: 'ADM-Reward', createdAt: '2026-08-19T06:10:00.000Z' }],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [{ id: '123456789012345679', name: 'bank', type: 0, parentId: null }] });

    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/accounts`) return json(route, {
      accounts: [{
        id: 'virtual-1', kind: 'CUSTOM', name: 'Eventkasse', walletBalance: '110900', bankBalance: '0', totalBalance: '110900',
        status: 'ACTIVE', acceptUserTransfers: true, expiresAt: null, archivedAt: null, createdAt: '2026-08-20T10:00:00.000Z',
        description: null, channelId: null, archiveChannelId: null, currencyName: 'Maeuse', currencyEmoji: '🐭', accountEmoji: '🏦',
        bannerUrl: null, textStyle: 'NORMAL', exchangePlayerUnits: null, exchangeAccountUnits: null, accountPurpose: 'GENERAL', managers: [], projection: null,
      }],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/manager-panel`) return json(route, { panel: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/control/members`) return json(route, { members: [{ discordId: OTHER_USER, username: 'target', displayName: 'Target User', avatar: null }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) return json(route, { members: [{ id: USER_GUID, discordId: OTHER_USER, username: 'target', displayName: 'Target User', avatar: null }] });

    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) return json(route, { round: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) return json(route, { rounds: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/discord`) return json(route, { projection: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/vendors`) return json(route, { vendors: [{ id: 'vendor-1', name: 'Nachtmarkt', balance: '9000', pendingLiability: '5000', withdrawableBalance: '4000', status: 'ACTIVE', createdAt: '2026-08-18T12:00:00.000Z' }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/listings`) return json(route, { listings: [{ id: 'listing-1', vendorAccountId: 'vendor-1', sku: 'M4-KIT', name: 'M4 Kit', description: 'Testangebot', price: '2500', active: true, archivedAt: null, createdAt: '2026-08-18T12:30:00.000Z', deliveryItems: [{ itemText: 'M4A1', quantity: 1 }] }] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases`) {
      if (opts.purchaseError) return json(route, { error: 'Guild-Scope fehlt nach Auth-Middleware.' }, 500);
      return json(route, { purchases: [{ id: 'purchase-1', listingId: 'listing-1', vendorAccountId: 'vendor-1', userDiscordId: OTHER_USER, sourcePocket: 'WALLET', quantity: 2, unitPrice: '2500', amount: '5000', createdAt: '2026-08-19T06:20:00.000Z', fulfillmentStatus: 'PENDING', deliveryItems: [{ itemText: 'M4A1', quantity: 2 }], fulfilledAt: null, fulfillmentNote: null, refundedAt: null, refundReason: null }] });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) return json(route, { games: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) return json(route, { stats: [] });

    return json(route, {});
  });

  return { configWrite: () => configWrite };
}

test.describe('Economy authenticated E2E', () => {
  test('Page 1 Economy behaelt Core-Funktionen, aber nicht die separierten Page-2-Flächen', async ({ page }) => {
    const writes = await stubAuthenticatedEconomy(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Wirtschaft-Status')).toBeVisible();
    await expect(page.getByText('Economy-Konfiguration')).toBeVisible();
    await expect(page.getByText('Schwarzmarkt')).toBeVisible();
    await expect(page.getByText('Bestellungen & Auslieferung')).toBeVisible();
    await expect(page.getByText('Admin-Auszahlung')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Virtuelle Konten' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Bank' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Casino-Games' })).toHaveCount(0);

    const currencyInput = page.getByText('Waehrungsname').locator('..').locator('input');
    await currencyInput.fill('Chaoten-Dollar');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect.poll(writes.configWrite).not.toBeNull();
    expect(writes.configWrite()).toMatchObject({ currencyName: 'Chaoten-Dollar', enabled: true, startBalance: 500, playtimeRewardPercent: 2 });
  });

  test('Page 2 trennt Virtuelle Konten und Bank/Casino, Killfeed bleibt erhalten', async ({ page }) => {
    await stubAuthenticatedEconomy(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=virtual-accounts`);

    await expect(page.getByRole('heading', { name: 'Virtuelle Konten' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bank und Casino Funktionen', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Killfeed & ADM', exact: true })).toBeVisible();
    await expect(page.getByText('Admin-Auszahlung')).toHaveCount(1);
    await expect(page.getByText('Eventkasse')).toBeVisible();
    await expect(page.getByText('Discord-User / GUID')).toBeVisible();
    await expect(page.getByText('Grund (optional)')).toBeVisible();

    await page.getByRole('button', { name: 'Bank und Casino Funktionen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bank' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Casino-Games' })).toBeVisible();
    await expect(page.getByText('Admin-Auszahlung')).toHaveCount(0);
  });

  test('zeigt den echten Kaufhistorie-Fehlerzustand im authentifizierten Economy-Scope', async ({ page }) => {
    await stubAuthenticatedEconomy(page, { purchaseError: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);
    await expect(page.getByText('Economy-Konfiguration')).toBeVisible();
    await expect(page.getByText(/Kaufhistorie konnte nicht geladen werden:/)).toBeVisible();
    await expect(page.getByText(/Guild-Scope fehlt nach Auth-Middleware/)).toBeVisible();
  });
});
