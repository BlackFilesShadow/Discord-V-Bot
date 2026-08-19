import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const OTHER_USER = '223456789012345678';
const SLOT = '1';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAuthenticatedEconomy(page: Page, opts: { purchaseError?: boolean } = {}) {
  let configWrite: Record<string, unknown> | null = null;
  let adminPayWrite: Record<string, unknown> | null = null;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'economy-admin', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/guilds/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      await json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      await json(route, {
        isOwner: true,
        permissions: ['dashboard.access', 'economy.manage'],
        slots: [{ id: 'conn-economy-1', slot: 1, alias: 'Chernarus', alias5: 'ECO01', status: 'ACTIVE' }],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      if (method === 'PUT') {
        configWrite = req.postDataJSON() as Record<string, unknown>;
        await json(route, { ok: true });
      } else {
        await json(route, {
          enabled: true,
          currencyName: 'Maeuse',
          emoji: '🐭',
          startBalance: 500,
          playtimeRewardPercent: 2,
          bankInterestPercent: 3,
          bankChannelId: null,
        });
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) {
      await json(route, { required: false, state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-economy-1', detectedActiveServerCount: 1, resolvedAt: '2026-08-19T06:00:00.000Z' }, servers: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) {
      await json(route, {
        economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 12, links: 9, transactions: 44 },
        bank: { totalWallet: '12500', totalBank: '33000', interestPercent: 3, bankChannelId: null },
        casino: { gamesConfigured: 4, gamesEnabled: 2, rounds: 8, totalBet: '5000', totalPayout: '4200', houseEdge: '800', stats: [] },
        recentTransactions: [{ id: 'ledger-1', userDiscordId: OTHER_USER, delta: '750', type: 'GRANT', reason: 'ADM-Reward', createdAt: '2026-08-19T06:10:00.000Z' }],
        coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) {
      await json(route, { channels: [{ id: '123456789012345679', name: 'bank', type: 0, parentId: null }] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts`) {
      await json(route, { accounts: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) {
      await json(route, { members: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) {
      await json(route, { round: null });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) {
      await json(route, { rounds: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/vendors`) {
      await json(route, { vendors: [{ id: 'vendor-1', name: 'Nachtmarkt', balance: '9000', status: 'ACTIVE', createdAt: '2026-08-18T12:00:00.000Z' }] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/listings`) {
      await json(route, { listings: [{ id: 'listing-1', vendorAccountId: 'vendor-1', sku: 'M4-KIT', name: 'M4 Kit', description: 'Testangebot', price: '2500', stock: 5, maxPerPurchase: 2, active: true, archivedAt: null, createdAt: '2026-08-18T12:30:00.000Z' }] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases`) {
      if (opts.purchaseError) {
        await json(route, { error: 'Guild-Scope fehlt nach Auth-Middleware.' }, 500);
      } else {
        await json(route, { purchases: [{ id: 'purchase-1', listingId: 'listing-1', vendorAccountId: 'vendor-1', userDiscordId: OTHER_USER, sourcePocket: 'WALLET', quantity: 2, unitPrice: '2500', amount: '5000', createdAt: '2026-08-19T06:20:00.000Z' }] });
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) {
      await json(route, { games: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) {
      await json(route, { stats: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/accounts/${OTHER_USER}/admin-pay` && method === 'POST') {
      adminPayWrite = req.postDataJSON() as Record<string, unknown>;
      await json(route, { ok: true, booked: true });
      return;
    }

    await json(route, {});
  });

  return {
    configWrite: () => configWrite,
    adminPayWrite: () => adminPayWrite,
  };
}

test.describe('Economy authenticated E2E', () => {
  test('rendert Kernzustand + Kaufhistorie und sendet kanonische Mutationen', async ({ page }) => {
    const writes = await stubAuthenticatedEconomy(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Wirtschaft-Status')).toBeVisible();
    await expect(page.getByText('12').first()).toBeVisible();
    await expect(page.getByText(/12\.500/)).toBeVisible();
    await expect(page.getByText('Economy-Konfiguration')).toBeVisible();
    await expect(page.getByText('Schwarzmarkt')).toBeVisible();
    await expect(page.getByText('Letzte Kaeufe')).toBeVisible();
    await expect(page.getByText(`User ${OTHER_USER}`)).toBeVisible();
    await expect(page.getByText(/2× · 5\.000/)).toBeVisible();

    const currencyInput = page.getByText('Waehrungsname').locator('..').locator('input');
    await currencyInput.fill('Chaoten-Dollar');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect.poll(writes.configWrite).not.toBeNull();
    expect(writes.configWrite()).toMatchObject({ currencyName: 'Chaoten-Dollar', enabled: true, startBalance: 500, playtimeRewardPercent: 2 });

    await page.getByPlaceholder('17–20 Ziffern').fill(OTHER_USER);
    await page.getByPlaceholder('z. B. 5000 oder -200').fill('250');
    await page.getByText('Begruendung (3–200 Zeichen)').locator('..').locator('input').fill('E2E Admin-Korrektur');
    await page.getByRole('button', { name: /Buchen/ }).click();
    await expect.poll(writes.adminPayWrite).not.toBeNull();
    expect(writes.adminPayWrite()).toEqual({ delta: '250', reason: 'E2E Admin-Korrektur' });
    await expect(page.getByText(`Gebucht: 250 fuer ${OTHER_USER}`)).toBeVisible();
  });

  test('zeigt den echten Kaufhistorie-Fehlerzustand im authentifizierten Economy-Scope', async ({ page }) => {
    await stubAuthenticatedEconomy(page, { purchaseError: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Economy-Konfiguration')).toBeVisible();
    await expect(page.getByText(/Kaufhistorie konnte nicht geladen werden:/)).toBeVisible();
    await expect(page.getByText(/Guild-Scope fehlt nach Auth-Middleware/)).toBeVisible();
  });
});
