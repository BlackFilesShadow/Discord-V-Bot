import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const SLOT = '1';
const TYPES = ['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK', 'ROULETTE', 'HIGHLOW', 'BACCARAT', 'WHEEL'] as const;

interface Mutation {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function game(type: typeof TYPES[number], overrides: Record<string, unknown> = {}) {
  const meta = {
    SLOT: ['Slot', '🎰', 0], COINFLIP: ['Coinflip', '🪙', 0], DICE: ['Dice', '🎲', 0], BLACKJACK: ['Blackjack', '🃏', 10],
    ROULETTE: ['Roulette', '🎡', 0], HIGHLOW: ['High-Low', '🔼', 0], BACCARAT: ['Baccarat', '🎴', 8], WHEEL: ['Glücksrad', '🎯', 0],
  }[type];
  return {
    type, label: meta[0], emoji: meta[1], description: `${meta[0]} Beschreibung`,
    enabled: true, winChancePct: 40, payoutMult: 2, minBet: '10', maxBet: '1000', cooldownSeconds: 2,
    drawConditionalPct: meta[2], theoreticalRtpPct: 80, houseEdgePct: 20, ...overrides,
  };
}

async function stubCasino(page: Page, opts: { updateErrorType?: string } = {}) {
  const mutations: Mutation[] = [];
  await page.route('**/api/me', route => json(route, { user: { discordId: USER_ID, username: 'casino-admin', avatar: null, role: 'ADMIN' } }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: { discordId: USER_ID, username: 'casino-admin', avatar: null, role: 'ADMIN' } }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) return json(route, {
      guildId: GUILD_ID, alias5: 'CHAOS', isOwner: true,
      permissions: ['dashboard.access', 'economy.manage', 'casino.manage'],
      slots: [{ id: 'conn-casino-1', slot: 1, alias: 'Chernarus', alias5: 'CAS01', status: 'ACTIVE' }], grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500,
      playtimeRewardPer10Min: 20, playtimeRewardPercent: 20, bankInterestPercent: 3, bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, { channels: [] });

    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games` && method === 'GET') {
      return json(route, { nitradoConnId: 'conn-casino-1', games: [
        game('SLOT', { winChancePct: 35, payoutMult: 2.5, minBet: '25', maxBet: '2500' }),
        game('COINFLIP', { winChancePct: 48, payoutMult: 2 }),
        game('DICE', { enabled: false, winChancePct: 16, payoutMult: 5.5 }),
        game('BLACKJACK', { winChancePct: 42, payoutMult: 2, drawConditionalPct: 10, theoreticalRtpPct: 89.8, houseEdgePct: 10.2 }),
        game('ROULETTE', { winChancePct: 47, payoutMult: 2 }),
        game('HIGHLOW', { winChancePct: 48, payoutMult: 1.9 }),
        game('BACCARAT', { winChancePct: 45, payoutMult: 2, drawConditionalPct: 8 }),
        game('WHEEL', { winChancePct: 35, payoutMult: 2.5 }),
      ] });
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats` && method === 'GET') return json(route, {
      nitradoConnId: 'conn-casino-1', stats: [
        { type: 'SLOT', wins: 3, draws: 1, losses: 2, bet: '600', payout: '700' },
        { type: 'BLACKJACK', wins: 4, draws: 2, losses: 4, bet: '1000', payout: '950' },
      ],
    });

    const match = path.match(new RegExp(`^/api/v2/guilds/${GUILD_ID}/casino/games/(${TYPES.join('|')})$`));
    if (match && method === 'PUT') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ method, path, query: url.search, body });
      if (opts.updateErrorType === match[1]) return json(route, { error: 'CASINO_UPDATE_BLOCKED' }, 400);
      return json(route, { ...game(match[1] as typeof TYPES[number]), ...body });
    }
    return json(route, {});
  });
  return mutations;
}

function findMutation(mutations: Mutation[], type: string) {
  return mutations.find(m => m.path.endsWith(`/casino/games/${type}`));
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Casino V3 authenticated dashboard contract', () => {
  test('renders eight separate cards with server values and decided W/D/L stats', async ({ page }) => {
    await stubCasino(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);
    await expect(page.getByRole('heading', { name: '🎲 Casino-Games' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern' })).toHaveCount(8);
    for (const type of TYPES) await expect(page.getByLabel(`${type} Gewinnchance`)).toBeVisible();
    await expect(page.getByLabel('SLOT Gewinnchance')).toHaveValue('35');
    await expect(page.getByLabel('SLOT Auszahlung')).toHaveValue('2.5');
    await expect(page.getByLabel('SLOT Mindest-Einsatz')).toHaveValue('25');
    await expect(page.getByLabel('SLOT Maximal-Einsatz')).toHaveValue('2500');
    await expect(page.getByText('3 / 1 / 2', { exact: true })).toBeVisible();
    await expect(page.getByText('4 / 2 / 4', { exact: true })).toBeVisible();
  });

  test('all games send configurable chance, payout, min/max and cooldown', async ({ page }) => {
    const mutations = await stubCasino(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);

    await page.getByLabel('BLACKJACK Gewinnchance').fill('40');
    await page.getByLabel('BLACKJACK Auszahlung').fill('2.1');
    await page.getByLabel('BLACKJACK Cooldown').fill('7');
    await page.getByRole('button', { name: 'Speichern' }).nth(3).click();
    await expect.poll(() => findMutation(mutations, 'BLACKJACK')).toBeTruthy();
    expect(findMutation(mutations, 'BLACKJACK')).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { enabled: true, winChancePct: 40, payoutMult: 2.1, minBet: '10', maxBet: '1000', cooldownSeconds: 7 },
    });

    await page.getByLabel('ROULETTE Gewinnchance').fill('45');
    await page.getByRole('button', { name: 'Speichern' }).nth(4).click();
    await expect.poll(() => findMutation(mutations, 'ROULETTE')).toBeTruthy();
    expect(findMutation(mutations, 'ROULETTE')?.body).toHaveProperty('winChancePct', 45);
  });

  test('Blackjack RTP includes configured conditional draw refunds', async ({ page }) => {
    await stubCasino(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);
    // 42% * x2 + 58% * 10% refund = 89.8%.
    await expect(page.getByText('89.80%', { exact: true })).toBeVisible();
  });

  test('update errors surface to the user instead of being swallowed', async ({ page }) => {
    await stubCasino(page, { updateErrorType: 'DICE' });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);
    await page.getByRole('button', { name: 'Speichern' }).nth(2).click();
    await expect(page.getByText(/CASINO_UPDATE_BLOCKED/)).toBeVisible();
  });
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px casino cards stay without page overflow`, async ({ page }) => {
    await stubCasino(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=bank-casino`);
    await expect(page.getByRole('heading', { name: '🎲 Casino-Games' })).toBeVisible();
    await expect(page.getByLabel('BACCARAT Gewinnchance')).toBeVisible();
    await noPageOverflow(page);
  });
}
