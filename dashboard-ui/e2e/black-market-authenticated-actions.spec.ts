import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const OTHER_USER = '223456789012345678';
const SLOT = '1';
const MAX_PRICE = '1000000000000000';
const MAX_STOCK = 1_000_000_000;

type Pocket = 'WALLET' | 'BANK';

interface Vendor {
  id: string;
  name: string;
  balance: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  createdAt: string;
}

interface Listing {
  id: string;
  vendorAccountId: string;
  sku: string;
  name: string;
  description: string | null;
  price: string;
  stock: number;
  maxPerPurchase: number;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
}

interface Mutation {
  kind: 'vendor' | 'listing' | 'restock' | 'archive' | 'purchase';
  path: string;
  query: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubBlackMarket(page: Page, opts: { canManage: boolean; purchaseError?: boolean } ) {
  const mutations: Mutation[] = [];
  const listingQueries: string[] = [];
  let vendorReads = 0;
  let purchaseHistoryReads = 0;
  let vendors: Vendor[] = [{
    id: 'vendor-1', name: 'Nachtmarkt', balance: '9000', status: 'ACTIVE', createdAt: '2026-08-18T12:00:00.000Z',
  }];
  let listings: Listing[] = [
    {
      id: 'listing-1', vendorAccountId: 'vendor-1', sku: 'M4-KIT', name: 'M4 Kit', description: 'Testangebot',
      price: '2500', stock: 5, maxPerPurchase: 3, active: true, archivedAt: null, createdAt: '2026-08-18T12:30:00.000Z',
    },
    {
      id: 'listing-archived', vendorAccountId: 'vendor-1', sku: 'OLD-KIT', name: 'Altes Kit', description: null,
      price: '500', stock: 0, maxPerPurchase: 1, active: false, archivedAt: '2026-08-18T13:30:00.000Z', createdAt: '2026-08-18T13:00:00.000Z',
    },
  ];
  let purchases = [{
    id: 'purchase-1', listingId: 'listing-1', vendorAccountId: 'vendor-1', userDiscordId: OTHER_USER,
    sourcePocket: 'WALLET' as Pocket, quantity: 2, unitPrice: '2500', amount: '5000', createdAt: '2026-08-19T06:20:00.000Z',
  }];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: opts.canManage ? 'market-admin' : 'market-buyer', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: opts.canManage ? 'market-admin' : 'market-buyer', avatar: null, role: 'ADMIN' },
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
      isOwner: opts.canManage,
      permissions: opts.canManage ? ['dashboard.access', 'economy.view', 'economy.manage'] : ['dashboard.access', 'economy.view'],
      slots: [{ id: 'conn-market-1', slot: 1, alias: 'Chernarus', alias5: 'MKT01', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, {
      whitelistActive: true, economyActive: true, permaOnly: false,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      nitradoConnId: 'conn-market-1', enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500,
      playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-market-1', detectedActiveServerCount: 1, resolvedAt: '2026-08-19T06:00:00.000Z' },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 2, links: 1, transactions: 4 },
      bank: { totalWallet: '12500', totalBank: '33000', interestPercent: 3, bankChannelId: null },
      casino: { gamesConfigured: 0, gamesEnabled: 0, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
      recentTransactions: [],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts`) return json(route, { accounts: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) return json(route, { members: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) return json(route, { round: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) return json(route, { rounds: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) return json(route, { games: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) return json(route, { stats: [] });

    const marketBase = `/api/v2/guilds/${GUILD_ID}/economy/black-market`;
    if (path === `${marketBase}/vendors`) {
      if (method === 'GET') {
        vendorReads += 1;
        return json(route, { nitradoConnId: 'conn-market-1', vendors });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ kind: 'vendor', path, query: url.search, body, idempotencyKey: req.headers()['x-idempotency-key'] ?? null });
      const vendor: Vendor = { id: 'vendor-2', name: String(body.name), balance: '0', status: 'ACTIVE', createdAt: '2026-08-19T12:00:00.000Z' };
      vendors = [...vendors, vendor];
      return json(route, vendor, 201);
    }
    if (path === `${marketBase}/listings`) {
      if (method === 'GET') {
        listingQueries.push(url.search);
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        return json(route, { nitradoConnId: 'conn-market-1', listings: includeInactive ? listings : listings.filter(row => row.active) });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ kind: 'listing', path, query: url.search, body, idempotencyKey: req.headers()['x-idempotency-key'] ?? null });
      const row: Listing = {
        id: 'listing-2', vendorAccountId: String(body.vendorAccountId), sku: String(body.sku).toUpperCase(), name: String(body.name),
        description: body.description == null ? null : String(body.description), price: String(body.price), stock: Number(body.stock),
        maxPerPurchase: Number(body.maxPerPurchase), active: true, archivedAt: null, createdAt: '2026-08-19T12:10:00.000Z',
      };
      listings = [...listings, row];
      return json(route, row, 201);
    }
    if (path === `${marketBase}/purchases`) {
      purchaseHistoryReads += 1;
      return json(route, { nitradoConnId: 'conn-market-1', purchases });
    }

    const listingMatch = new RegExp(`^${marketBase}/listings/([^/]+)/(restock|archive|purchase)$`).exec(path);
    if (listingMatch && method === 'POST') {
      const [, id, action] = listingMatch;
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const key = req.headers()['x-idempotency-key'] ?? null;
      if (action === 'restock') {
        mutations.push({ kind: 'restock', path, query: url.search, body, idempotencyKey: key });
        listings = listings.map(row => row.id === id ? { ...row, stock: Number(body.stock), active: true } : row);
        return json(route, listings.find(row => row.id === id));
      }
      if (action === 'archive') {
        mutations.push({ kind: 'archive', path, query: url.search, body, idempotencyKey: key });
        listings = listings.map(row => row.id === id ? { ...row, active: false, archivedAt: '2026-08-19T12:20:00.000Z' } : row);
        return json(route, listings.find(row => row.id === id));
      }

      mutations.push({ kind: 'purchase', path, query: url.search, body, idempotencyKey: key });
      if (opts.purchaseError) return json(route, { error: 'Nicht genug Guthaben im gewaehlten Pocket.' }, 400);
      const quantity = Number(body.quantity);
      const before = listings.find(row => row.id === id)!;
      const amount = (BigInt(before.price) * BigInt(quantity)).toString();
      const updated = { ...before, stock: before.stock - quantity };
      listings = listings.map(row => row.id === id ? updated : row);
      const purchase = {
        id: 'purchase-2', listingId: id, vendorAccountId: before.vendorAccountId, userDiscordId: USER_ID,
        sourcePocket: String(body.sourcePocket) as Pocket, quantity, unitPrice: before.price, amount, createdAt: '2026-08-19T12:30:00.000Z',
      };
      purchases = [purchase, ...purchases];
      return json(route, { booked: true, purchase, listing: updated });
    }

    return json(route, {});
  });

  return {
    mutations,
    listingQueries,
    vendorReads: () => vendorReads,
    purchaseHistoryReads: () => purchaseHistoryReads,
  };
}

function mutationOf(state: Awaited<ReturnType<typeof stubBlackMarket>>, kind: Mutation['kind']): Mutation | undefined {
  return state.mutations.find(row => row.kind === kind);
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Black Market authenticated action contract', () => {
  test('economy.view sieht nur Buyer-UI und kauft im exakten Slot-Scope ueber den zentralen Idempotency-Key', async ({ page }) => {
    const state = await stubBlackMarket(page, { canManage: false });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Schwarzmarkt')).toBeVisible();
    await expect(page.getByText('M4 Kit')).toBeVisible();
    await expect(page.getByText('Altes Kit')).toHaveCount(0);
    await expect(page.getByText('Haendler anlegen')).toHaveCount(0);
    await expect(page.getByText('Angebot anlegen')).toHaveCount(0);
    await expect(page.getByText('Letzte Kaeufe')).toHaveCount(0);
    await expect.poll(state.vendorReads).toBe(0);
    await expect.poll(state.purchaseHistoryReads).toBe(0);
    await expect.poll(() => state.listingQueries.some(query => query.includes(`slot=${SLOT}`) && query.includes('includeInactive=false'))).toBe(true);

    await page.getByLabel('Kaufmenge M4 Kit').fill('2');
    await page.getByLabel('Bezahlen aus M4 Kit').selectOption('BANK');
    await page.getByRole('button', { name: 'Kaufen', exact: true }).click();

    await expect.poll(() => mutationOf(state, 'purchase')).toBeTruthy();
    const purchase = mutationOf(state, 'purchase')!;
    expect(purchase.path).toBe(`/api/v2/guilds/${GUILD_ID}/economy/black-market/listings/listing-1/purchase`);
    expect(purchase.query).toBe(`?slot=${SLOT}`);
    expect(purchase.body).toEqual({ quantity: 2, sourcePocket: 'BANK' });
    expect(purchase.idempotencyKey).toBeTruthy();
    expect(purchase.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(`dashboard:${purchase.idempotencyKey}`.length).toBeLessThanOrEqual(48);
    await expect(page.getByText('Kauf gebucht: 2× fuer 5.000.')).toBeVisible();
  });

  test('economy.manage deckt Create, Restock, Archive, History und Backend-Grenzen ab', async ({ page }) => {
    const state = await stubBlackMarket(page, { canManage: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Haendler anlegen')).toBeVisible();
    await expect(page.getByText('Angebot anlegen')).toBeVisible();
    await expect(page.getByText('Altes Kit')).toBeVisible();
    await expect(page.getByText('Letzte Kaeufe')).toBeVisible();
    await expect.poll(state.vendorReads).toBeGreaterThan(0);
    await expect.poll(state.purchaseHistoryReads).toBeGreaterThan(0);
    await expect.poll(() => state.listingQueries.some(query => query.includes('includeInactive=true'))).toBe(true);

    const stockInput = page.getByLabel('Bestand M4 Kit');
    await stockInput.fill(String(MAX_STOCK + 1));
    await expect(page.getByRole('button', { name: 'Bestand', exact: true })).toBeDisabled();
    await stockInput.fill('7');
    await page.getByRole('button', { name: 'Bestand', exact: true }).click();
    await expect.poll(() => mutationOf(state, 'restock')).toBeTruthy();
    expect(mutationOf(state, 'restock')).toMatchObject({ query: `?slot=${SLOT}`, body: { stock: 7 } });

    await page.getByLabel('Angebot M4 Kit archivieren').click();
    await expect.poll(() => mutationOf(state, 'archive')).toBeTruthy();
    expect(mutationOf(state, 'archive')?.query).toBe(`?slot=${SLOT}`);

    await page.getByPlaceholder('z. B. Nachtmarkt').fill('Event-Haendler');
    await page.getByRole('button', { name: 'Haendler erstellen', exact: true }).click();
    await expect.poll(() => mutationOf(state, 'vendor')).toBeTruthy();
    expect(mutationOf(state, 'vendor')).toMatchObject({ query: `?slot=${SLOT}`, body: { name: 'Event-Haendler' } });

    await page.getByPlaceholder('SKU').fill('event-kit');
    await page.getByPlaceholder('Produktname').fill('Event Kit');
    await page.getByPlaceholder('Preis').fill(`${MAX_PRICE}1`);
    await page.getByPlaceholder('Bestand').fill(String(MAX_STOCK + 1));
    await expect(page.getByRole('button', { name: 'Angebot erstellen', exact: true })).toBeDisabled();
    await page.getByPlaceholder('Preis').fill(MAX_PRICE);
    await page.getByPlaceholder('Bestand').fill('5');
    await page.getByRole('button', { name: 'Angebot erstellen', exact: true }).click();
    await expect.poll(() => mutationOf(state, 'listing')).toBeTruthy();
    expect(mutationOf(state, 'listing')).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { vendorAccountId: 'vendor-2', sku: 'event-kit', name: 'Event Kit', price: MAX_PRICE, stock: 5, maxPerPurchase: 10 },
    });
  });

  test('zeigt Kauf-Fehler sichtbar statt False-Success', async ({ page }) => {
    await stubBlackMarket(page, { canManage: false, purchaseError: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await page.getByRole('button', { name: 'Kaufen', exact: true }).click();
    await expect(page.getByText(/Kauf fehlgeschlagen: Nicht genug Guthaben/)).toBeVisible();
    await expect(page.getByText(/Kauf gebucht:/)).toHaveCount(0);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Buyer-UI bleibt bei ${width}px ohne Seiten-Overflow`, async ({ page }) => {
      await stubBlackMarket(page, { canManage: false });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);
      await expect(page.getByText('M4 Kit')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Kaufen', exact: true })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
