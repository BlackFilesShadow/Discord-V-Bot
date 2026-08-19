import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const SLOT = '1';

interface Mutation {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubCasino(page: Page, opts: { updateErrorType?: string } = {}) {
  const mutations: Mutation[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'casino-admin', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'casino-admin', avatar: null, role: 'ADMIN' },
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
      slots: [{ id: 'conn-casino-1', slot: 1, alias: 'Chernarus', alias5: 'CAS01', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      return json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      return json(route, {
        enabled: true,
        currencyName: 'Maeuse',
        emoji: '🐭',
        startBalance: 500,
        playtimeRewardPercent: 2,
        bankInterestPercent: 3,
        bankChannelId: null,
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) {
      return json(route, {
        required: false,
        state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-casino-1', detectedActiveServerCount: 1, resolvedAt: '2026-08-19T10:00:00.000Z' },
        servers: [],
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) {
      return json(route, {
        economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 0, links: 0, transactions: 0 },
        bank: { totalWallet: '0', totalBank: '0', interestPercent: 3, bankChannelId: null },
        casino: { gamesConfigured: 4, gamesEnabled: 4, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
        recentTransactions: [],
        coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts`) return json(route, { accounts: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) return json(route, { members: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/current`) return json(route, { round: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/lottery/history`) return json(route, { rounds: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/vendors`) return json(route, { vendors: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/listings`) return json(route, { listings: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases`) return json(route, { purchases: [] });

    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games` && method === 'GET') {
      return json(route, {
        nitradoConnId: 'conn-casino-1',
        games: [
          { type: 'SLOT', enabled: true, winChancePct: 63, fixedOdds: null, payoutMult: 2.5, minBet: '25', maxBet: '2500' },
          { type: 'COINFLIP', enabled: true, winChancePct: null, fixedOdds: '50/50', payoutMult: 1.9, minBet: '10', maxBet: '1000' },
          { type: 'DICE', enabled: false, winChancePct: null, fixedOdds: '1/6', payoutMult: 5.5, minBet: '5', maxBet: '500' },
          { type: 'BLACKJACK', enabled: true, winChancePct: null, fixedOdds: 'Kartenlogik', payoutMult: 2, minBet: '20', maxBet: '2000' },
        ],
      });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats` && method === 'GET') {
      return json(route, {
        nitradoConnId: 'conn-casino-1',
        stats: [
          { type: 'SLOT', wins: 3, draws: 1, losses: 2, bet: '600', payout: '700' },
          { type: 'COINFLIP', wins: 4, draws: 0, losses: 5, bet: '900', payout: '800' },
        ],
      });
    }

    const gameMatch = path.match(new RegExp(`^/api/v2/guilds/${GUILD_ID}/casino/games/(SLOT|COINFLIP|DICE|BLACKJACK)$`));
    if (gameMatch && method === 'PUT') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      if (opts.updateErrorType === gameMatch[1]) {
        return json(route, { error: 'CASINO_UPDATE_BLOCKED' }, 400);
      }
      return json(route, { nitradoConnId: 'conn-casino-1', type: gameMatch[1], ...body });
    }

    return json(route, {});
  });

  return mutations;
}

function row(page: Page, type: 'SLOT' | 'COINFLIP' | 'DICE' | 'BLACKJACK') {
  return page.getByRole('row').filter({ hasText: type });
}

function findMutation(mutations: Mutation[], type: string) {
  return mutations.find(m => m.path.endsWith(`/casino/games/${type}`));
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Casino authenticated dashboard contract', () => {
  test('hydriert reale Serverwerte und zeigt Fixed-Odds + W/D/L korrekt', async ({ page }) => {
    await stubCasino(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByRole('heading', { name: 'Casino-Games' })).toBeVisible();

    const slot = row(page, 'SLOT');
    await expect(slot.locator('input').nth(0)).toHaveValue('63');
    await expect(slot.locator('input').nth(1)).toHaveValue('2.5');
    await expect(slot.locator('input').nth(2)).toHaveValue('25');
    await expect(slot.locator('input').nth(3)).toHaveValue('2500');
    await expect(slot.getByText('3 / 1 / 2', { exact: true })).toBeVisible();

    const coinflip = row(page, 'COINFLIP');
    await expect(coinflip.getByText('50/50', { exact: true })).toBeVisible();
    await expect(coinflip.locator('input')).toHaveCount(3);
    await expect(row(page, 'DICE').getByText('1/6', { exact: true })).toBeVisible();
    await expect(row(page, 'BLACKJACK').getByText('Kartenlogik', { exact: true })).toBeVisible();
  });

  test('SLOT sendet Win-Prozent, Fixed-Odds-Games senden es niemals', async ({ page }) => {
    const mutations = await stubCasino(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    const slot = row(page, 'SLOT');
    await expect(slot.locator('input').nth(0)).toHaveValue('63');
    await slot.locator('input').nth(0).fill('67');
    await slot.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => findMutation(mutations, 'SLOT')).toBeTruthy();
    expect(findMutation(mutations, 'SLOT')).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { enabled: true, winChancePct: 67, payoutMult: 2.5, minBet: '25', maxBet: '2500' },
    });

    const coinflip = row(page, 'COINFLIP');
    await coinflip.locator('input').nth(0).fill('2.1');
    await coinflip.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => findMutation(mutations, 'COINFLIP')).toBeTruthy();
    const fixedBody = findMutation(mutations, 'COINFLIP')?.body ?? {};
    expect(fixedBody).toMatchObject({ enabled: true, payoutMult: 2.1, minBet: '10', maxBet: '1000' });
    expect(fixedBody).not.toHaveProperty('winChancePct');
  });

  test('Update-Fehler wird im Casino-Block sichtbar statt verschluckt', async ({ page }) => {
    await stubCasino(page, { updateErrorType: 'DICE' });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    const dice = row(page, 'DICE');
    await expect(dice.getByText('1/6', { exact: true })).toBeVisible();
    await dice.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByText(/CASINO_UPDATE_BLOCKED/)).toBeVisible();
  });
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px Casino bleibt ohne Seiten-Overflow`, async ({ page }) => {
    await stubCasino(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);
    await expect(page.getByRole('heading', { name: 'Casino-Games' })).toBeVisible();
    await expect(row(page, 'COINFLIP').getByText('50/50', { exact: true })).toBeVisible();
    await noPageOverflow(page);
  });
}
