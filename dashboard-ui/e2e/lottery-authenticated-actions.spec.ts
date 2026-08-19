import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const SLOT = '1';
const TEXT_CHANNEL_ID = '123456789012345679';
const ANNOUNCEMENT_CHANNEL_ID = '123456789012345680';
const MAX_TICKET_PRICE = '1000000000000';

type LotteryStatus = 'ACTIVE' | 'DRAWING' | 'REFUNDING' | 'FINISHED' | 'REFUNDED';

interface LotteryRound {
  id: string;
  potAccountId: string;
  channelId: string;
  messageId: string | null;
  ticketPrice: string;
  maxTicketsPerUser: number;
  minParticipants: number;
  status: LotteryStatus;
  endsAt: string;
  winnerDiscordId: string | null;
  winningTicketNumber: number | null;
  participantCount: number;
  totalTickets: number;
  finalPot: string | null;
  potBalance: string;
  createdAt: string;
}

interface Mutation {
  kind: 'create' | 'end';
  path: string;
  query: string;
  body: Record<string, unknown>;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function round(status: LotteryStatus = 'ACTIVE'): LotteryRound {
  return {
    id: 'round-12345678',
    potAccountId: 'pot-1',
    channelId: TEXT_CHANNEL_ID,
    messageId: 'message-1',
    ticketPrice: '250',
    maxTicketsPerUser: 10,
    minParticipants: 2,
    status,
    endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    winnerDiscordId: status === 'FINISHED' ? USER_ID : null,
    winningTicketNumber: status === 'FINISHED' ? 3 : null,
    participantCount: 4,
    totalTickets: 12,
    finalPot: status === 'FINISHED' ? '3000' : null,
    potBalance: status === 'FINISHED' ? '0' : '3000',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  };
}

async function stubLottery(page: Page, opts: { canManage: boolean; active?: boolean; createError?: boolean }) {
  const mutations: Mutation[] = [];
  let currentRound: LotteryRound | null = opts.active ? round('ACTIVE') : null;
  let history: LotteryRound[] = [round('FINISHED')];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: opts.canManage ? 'lottery-admin' : 'lottery-viewer', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: opts.canManage ? 'lottery-admin' : 'lottery-viewer', avatar: null, role: 'ADMIN' },
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
      slots: [{ id: 'conn-lottery-1', slot: 1, alias: 'Chernarus', alias5: 'LOT01', status: 'ACTIVE' }],
      grantsCount: 0,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) return json(route, {
      whitelistActive: true, economyActive: true, permaOnly: false,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) return json(route, {
      nitradoConnId: 'conn-lottery-1', enabled: true, currencyName: 'Maeuse', emoji: '🐭', startBalance: 500,
      playtimeRewardPercent: 2, bankInterestPercent: 3, bankChannelId: null,
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy-scope/status`) return json(route, {
      required: false,
      state: { status: 'RESOLVED', primaryNitradoConnId: 'conn-lottery-1', detectedActiveServerCount: 1, resolvedAt: new Date().toISOString() },
      servers: [],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/overview`) return json(route, {
      economy: { enabled: true, currencyName: 'Maeuse', emoji: '🐭', accounts: 2, links: 1, transactions: 4 },
      bank: { totalWallet: '12500', totalBank: '33000', interestPercent: 3, bankChannelId: null },
      casino: { gamesConfigured: 0, gamesEnabled: 0, rounds: 0, totalBet: '0', totalPayout: '0', houseEdge: '0', stats: [] },
      recentTransactions: [],
      coupling: { sharedCurrency: true, sharedBalance: true, directlyBooked: true, sharedModels: [], casinoStatsMovable: false, raceConditionsGuarded: true, centralTransactionService: 'ledger' },
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) return json(route, {
      channels: [
        { id: TEXT_CHANNEL_ID, name: 'lotterie', type: 0, parentId: null },
        { id: ANNOUNCEMENT_CHANNEL_ID, name: 'lotterie-news', type: 5, parentId: null },
        { id: '123456789012345681', name: 'Kategorie', type: 4, parentId: null },
        { id: '123456789012345682', name: 'Forum', type: 15, parentId: null },
      ],
    });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts`) return json(route, { accounts: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/virtual-accounts/members`) return json(route, { members: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/vendors`) return json(route, { vendors: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/listings`) return json(route, { listings: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/black-market/purchases`) return json(route, { purchases: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/games`) return json(route, { games: [] });
    if (path === `/api/v2/guilds/${GUILD_ID}/casino/stats`) return json(route, { stats: [] });

    const lotteryBase = `/api/v2/guilds/${GUILD_ID}/economy/lottery`;
    if (path === `${lotteryBase}/current` && method === 'GET') {
      return json(route, { nitradoConnId: 'conn-lottery-1', round: currentRound });
    }
    if (path === `${lotteryBase}/history` && method === 'GET') {
      return json(route, { nitradoConnId: 'conn-lottery-1', rounds: history });
    }
    if (path === `${lotteryBase}/rounds` && method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      mutations.push({ kind: 'create', path, query: url.search, body });
      if (opts.createError) return json(route, { error: 'Lotterie-Channel ist kein beschreibbarer Text-Channel.' }, 400);
      currentRound = {
        ...round('ACTIVE'),
        channelId: String(body.channelId),
        ticketPrice: String(body.ticketPrice),
        maxTicketsPerUser: Number(body.maxTicketsPerUser),
        minParticipants: Number(body.minParticipants),
        endsAt: String(body.endsAt),
      };
      return json(route, currentRound, 201);
    }
    if (path === `${lotteryBase}/round-12345678/end-now` && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      mutations.push({ kind: 'end', path, query: url.search, body });
      const finished = { ...(currentRound ?? round('ACTIVE')), status: 'FINISHED' as const, finalPot: '3000', potBalance: '0' };
      currentRound = null;
      history = [finished, ...history];
      return json(route, finished);
    }

    return json(route, {});
  });

  return { mutations };
}

function mutationOf(state: Awaited<ReturnType<typeof stubLottery>>, kind: Mutation['kind']): Mutation | undefined {
  return state.mutations.find(row => row.kind === kind);
}

async function browserLocalDateTime(page: Page, offsetMs: number): Promise<string> {
  return page.evaluate(ms => {
    const d = new Date(Date.now() + ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, offsetMs);
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Lottery authenticated dashboard contract', () => {
  test('economy.view sieht Status/History, aber keine Manage-Aktionen', async ({ page }) => {
    await stubLottery(page, { canManage: false, active: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Lotterie', { exact: true })).toBeVisible();
    await expect(page.getByText('Aktuelle Runde')).toBeVisible();
    await expect(page.getByText('Letzte Runden')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Jetzt beenden', exact: true })).toHaveCount(0);
    await expect(page.getByText('Neue Runde starten')).toHaveCount(0);
  });

  test('economy.view ohne aktive Runde bekommt ebenfalls kein Create-Formular', async ({ page }) => {
    await stubLottery(page, { canManage: false, active: false });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Keine aktive oder noch zu verarbeitende Runde.')).toBeVisible();
    await expect(page.getByText('Neue Runde starten')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lotterie starten', exact: true })).toHaveCount(0);
  });

  test('economy.manage erstellt und beendet eine Runde im exakten Guild+Slot-Contract', async ({ page }) => {
    const state = await stubLottery(page, { canManage: true, active: false });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await expect(page.getByText('Neue Runde starten')).toBeVisible();
    const channel = page.getByLabel('Discord-Channel', { exact: true });
    await expect(channel.locator('option')).toHaveCount(3); // Placeholder + Text + Announcement; Category/Forum ausgeschlossen.
    await channel.selectOption(TEXT_CHANNEL_ID);

    await page.getByLabel('Ticketpreis').fill(`${MAX_TICKET_PRICE}1`);
    await page.getByLabel('Endzeit (1 Minute bis 30 Tage)').fill(await browserLocalDateTime(page, 2 * 60 * 60 * 1000));
    await expect(page.getByRole('button', { name: 'Lotterie starten', exact: true })).toBeDisabled();

    await page.getByLabel('Ticketpreis').fill(MAX_TICKET_PRICE);
    await page.getByLabel('Endzeit (1 Minute bis 30 Tage)').fill(await browserLocalDateTime(page, 31 * 24 * 60 * 60 * 1000));
    await expect(page.getByRole('button', { name: 'Lotterie starten', exact: true })).toBeDisabled();

    const validEnd = await browserLocalDateTime(page, 2 * 60 * 60 * 1000);
    await page.getByLabel('Endzeit (1 Minute bis 30 Tage)').fill(validEnd);
    await page.getByRole('button', { name: 'Lotterie starten', exact: true }).click();

    await expect.poll(() => mutationOf(state, 'create')).toBeTruthy();
    const create = mutationOf(state, 'create')!;
    expect(create.path).toBe(`/api/v2/guilds/${GUILD_ID}/economy/lottery/rounds`);
    expect(create.query).toBe(`?slot=${SLOT}`);
    expect(create.body).toMatchObject({
      channelId: TEXT_CHANNEL_ID,
      ticketPrice: MAX_TICKET_PRICE,
      maxTicketsPerUser: 10,
      minParticipants: 2,
    });
    expect(Date.parse(String(create.body.endsAt))).toBeGreaterThan(Date.now() + 60_000);
    expect(Date.parse(String(create.body.endsAt))).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await expect(page.getByText(/Lotterie gestartet\. Runde round-12/)).toBeVisible();

    await expect(page.getByRole('button', { name: 'Jetzt beenden', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Jetzt beenden', exact: true }).click();
    await expect.poll(() => mutationOf(state, 'end')).toBeTruthy();
    expect(mutationOf(state, 'end')).toMatchObject({
      path: `/api/v2/guilds/${GUILD_ID}/economy/lottery/round-12345678/end-now`,
      query: `?slot=${SLOT}`,
      body: {},
    });
    await expect(page.getByText('Runde ausgewertet: FINISHED.')).toBeVisible();
  });

  test('zeigt Create-Backendfehler sichtbar und keinen False-Success', async ({ page }) => {
    await stubLottery(page, { canManage: true, active: false, createError: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);

    await page.getByLabel('Discord-Channel', { exact: true }).selectOption(TEXT_CHANNEL_ID);
    await page.getByLabel('Ticketpreis').fill('250');
    await page.getByLabel('Endzeit (1 Minute bis 30 Tage)').fill(await browserLocalDateTime(page, 2 * 60 * 60 * 1000));
    await page.getByRole('button', { name: 'Lotterie starten', exact: true }).click();

    await expect(page.getByText(/Lotterie konnte nicht gestartet werden: Lotterie-Channel ist kein beschreibbarer Text-Channel/)).toBeVisible();
    await expect(page.getByText(/Lotterie gestartet\. Runde/)).toHaveCount(0);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Manage-Create bleibt bei ${width}px ohne Seiten-Overflow`, async ({ page }) => {
      await stubLottery(page, { canManage: true, active: false });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=economy`);
      await expect(page.getByText('Neue Runde starten')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lotterie starten', exact: true })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
