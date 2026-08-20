import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';
const INFO_CHANNEL = '523456789012345678';
const REQUEST_CHANNEL = '623456789012345678';
const APPROVE_CHANNEL = '723456789012345678';
const DENY_CHANNEL = '823456789012345678';

interface CapturedMutation {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

interface StubOptions {
  channelsForbidden?: boolean;
  syncFailure?: boolean;
  addFailure?: boolean;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubWhitelistDashboard(page: Page, options: StubOptions = {}) {
  const mutations: CapturedMutation[] = [];
  let whitelistChannels: {
    infoChannelId: string | null;
    requestChannelId: string | null;
    approveLogChannelId: string | null;
    denyLogChannelId: string | null;
    infoMessageId: string | null;
  } = {
    infoChannelId: null,
    requestChannelId: null,
    approveLogChannelId: null,
    denyLogChannelId: null,
    infoMessageId: null,
  };

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'whitelist-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'whitelist-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const query = url.search;

    if (path === '/api/v2/dev/status') {
      await json(route, { active: false, eligible: true, expiresAt: null });
      return;
    }
    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      await json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: true,
        permissions: ['dashboard.access'],
        slots: [{ id: 'conn-dashboard-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE' }],
        grantsCount: 0,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      await json(route, { whitelistActive: true, economyActive: true, permaOnly: false });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      await json(route, {
        enabled: true,
        currencyName: 'Maeuse',
        emoji: '🐭',
        startBalance: 500,
        playtimeRewardPercent: 2,
        bankInterestPercent: 3,
        bankChannelId: null,
      });
      return;
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/channels` && method === 'GET') {
      if (options.channelsForbidden) {
        await json(route, { error: 'Forbidden' }, 403);
      } else {
        await json(route, {
          channels: [
            { id: INFO_CHANNEL, name: 'whitelist-info', type: 0, parentId: null },
            { id: REQUEST_CHANNEL, name: 'whitelist-requests', type: 0, parentId: null },
            { id: APPROVE_CHANNEL, name: 'whitelist-approved', type: 0, parentId: null },
            { id: DENY_CHANNEL, name: 'whitelist-denied', type: 0, parentId: null },
            { id: '923456789012345678', name: 'voice-only', type: 2, parentId: null },
          ],
        });
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/channels` && method === 'GET') {
      await json(route, whitelistChannels);
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist` && method === 'GET') {
      await json(route, {
        entries: [
          { gameId: 'AlphaOne', approvedBy: USER_ID, source: 'DASHBOARD', approvedAt: '2026-08-19T08:00:00.000Z' },
        ],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/requests` && method === 'GET') {
      await json(route, {
        requests: [
          { id: 'request-1', gameId: 'RequestOne', requesterDiscordId: '337718598876268545', status: 'PENDING', createdAt: '2026-08-19T08:05:00.000Z' },
          { id: 'request-2', gameId: 'RequestTwo', requesterDiscordId: '347718598876268545', status: 'PENDING', createdAt: '2026-08-19T08:06:00.000Z' },
        ],
      });
      return;
    }

    if (method !== 'GET') {
      let body: unknown = null;
      try { body = req.postDataJSON(); } catch { body = req.postData(); }
      mutations.push({ method, path, query, body });
    }

    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist` && method === 'POST') {
      if (options.addFailure) {
        await json(route, { error: 'ADD_BLOCKED' }, 409);
      } else {
        await json(route, { ok: true }, 201);
      }
      return;
    }
    if (path.startsWith(`/api/v2/guilds/${GUILD_ID}/whitelist/`) && method === 'DELETE') {
      await json(route, { ok: true });
      return;
    }
    if (/\/whitelist\/requests\/[^/]+\/decision$/.test(path) && method === 'POST') {
      await json(route, { ok: true });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/sync` && method === 'POST') {
      if (options.syncFailure) {
        await json(route, { error: 'Nitrado offline' }, 503);
      } else {
        const body = req.postDataJSON() as { mode: 'preview' | 'apply'; direction: 'pull' | 'push' | 'merge' };
        await json(route, {
          ok: true,
          preview: body.mode === 'preview',
          applied: body.mode === 'apply',
          diff: {
            direction: body.direction,
            mode: body.mode,
            counts: { local: 2, remote: 2, both: 1, onlyLocal: 1, onlyRemote: 1 },
            onlyLocal: ['LocalOnly'],
            onlyRemote: ['RemoteOnly'],
          },
          dbInserted: body.mode === 'apply' ? 1 : undefined,
          dbDeleted: body.mode === 'apply' ? 0 : undefined,
          jobsCreated: body.mode === 'apply' ? 1 : undefined,
        });
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/channels` && method === 'PUT') {
      const body = req.postDataJSON() as Omit<typeof whitelistChannels, 'infoMessageId'>;
      whitelistChannels = { ...body, infoMessageId: 'message-1' };
      await json(route, {
        ok: true,
        ...whitelistChannels,
        infoResult: { posted: true, updated: false, messageId: 'message-1' },
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/channels/info/repost` && method === 'POST') {
      await json(route, { ok: true, posted: true, updated: false });
      return;
    }

    await json(route, {});
  });

  return { mutations };
}

function matchingMutation(
  mutations: CapturedMutation[],
  method: string,
  path: string,
): CapturedMutation | undefined {
  return mutations.find(row => row.method === method && row.path === path);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Authenticated Whitelist actions', () => {
  test('Add, Remove, Approve und Deny bleiben exakt Guild+Slot-gescoped', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`);

    await expect(page.getByRole('heading', { name: 'Whitelist (Spielername)' })).toBeVisible();
    await expect(page.getByText('AlphaOne', { exact: true })).toBeVisible();
    await expect(page.getByText('RequestOne', { exact: true })).toBeVisible();

    const addInput = page.getByPlaceholder('Spielername (1-64 Zeichen)');
    await addInput.fill('BravoTwo');
    await page.getByRole('button', { name: 'Hinzufuegen' }).click();
    await expect.poll(() => matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist`)).toBeTruthy();
    expect(matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist`)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { gameId: 'BravoTwo', confirm: true, reason: 'Whitelist-Eintrag hinzugefuegt: BravoTwo' },
    });

    const entryRow = page.getByText('AlphaOne', { exact: true }).locator('xpath=ancestor::div[.//button][1]');
    await entryRow.getByRole('button').click();
    await expect.poll(() => matchingMutation(state.mutations, 'DELETE', `/api/v2/guilds/${GUILD_ID}/whitelist/AlphaOne`)).toBeTruthy();
    expect(matchingMutation(state.mutations, 'DELETE', `/api/v2/guilds/${GUILD_ID}/whitelist/AlphaOne`)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { confirm: true, reason: 'Whitelist-Eintrag entfernt: AlphaOne' },
    });

    const approveCard = page.getByText('RequestOne', { exact: true }).locator('xpath=ancestor::div[.//input and count(.//button)>=2][1]');
    await approveCard.getByPlaceholder('Begruendung (optional)').fill('passt');
    await approveCard.getByRole('button').nth(0).click();
    await expect.poll(() => matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist/requests/request-1/decision`)).toBeTruthy();
    expect(matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist/requests/request-1/decision`)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { approve: true, reason: 'passt', confirm: true },
    });

    const denyCard = page.getByText('RequestTwo', { exact: true }).locator('xpath=ancestor::div[.//input and count(.//button)>=2][1]');
    await denyCard.getByRole('button').nth(1).click();
    await expect.poll(() => matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist/requests/request-2/decision`)).toBeTruthy();
    expect(matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist/requests/request-2/decision`)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { approve: false, confirm: true },
    });
  });

  test('Sync preview/apply prüft Richtung, Bestätigung, Ergebnis und Recovery-Fehler', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`);

    await page.getByRole('button', { name: 'Pull (Nitrado -> DB)' }).click();
    await page.getByRole('button', { name: 'Vorschau' }).click();
    await expect(page.getByText('Nur in DB (1):')).toBeVisible();
    await expect(page.getByText('LocalOnly')).toBeVisible();
    const preview = state.mutations.find(row =>
      row.method === 'POST' && row.path.endsWith('/whitelist/sync') && (row.body as { mode?: string })?.mode === 'preview',
    );
    expect(preview).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { mode: 'preview', direction: 'pull', confirm: true },
    });

    await page.getByRole('button', { name: 'Push (DB -> Nitrado)' }).click();
    page.once('dialog', dialog => dialog.accept('Audit Sync'));
    await page.getByRole('button', { name: 'Anwenden' }).click();
    await expect(page.getByText(/1 lokal hinzugefuegt/)).toBeVisible();
    const apply = state.mutations.find(row =>
      row.method === 'POST' && row.path.endsWith('/whitelist/sync') && (row.body as { mode?: string })?.mode === 'apply',
    );
    expect(apply).toMatchObject({
      query: `?slot=${SLOT}`,
      body: { mode: 'apply', direction: 'push', reason: 'Audit Sync', confirm: true },
    });
  });

  test('Channel-Auswahl speichert nur Text/Announcement und Repost bleibt slot-gescoped', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`);

    const info = page.getByLabel('Info-Kanal (1× Command-Erklaerung als Embed)');
    const request = page.getByLabel('Whitelist-Annahme-Kanal (Approval mit Buttons)');
    const approved = page.getByLabel('Log-Kanal: ANGENOMMEN');
    const denied = page.getByLabel('Log-Kanal: ABGELEHNT');

    await expect(info.getByRole('option', { name: '#voice-only' })).toHaveCount(0);
    await info.selectOption(INFO_CHANNEL);
    await request.selectOption(REQUEST_CHANNEL);
    await approved.selectOption(APPROVE_CHANNEL);
    await denied.selectOption(DENY_CHANNEL);
    await page.getByRole('button', { name: 'Speichern' }).click();

    await expect(page.getByText(/Gespeichert\. Info-Embed neu gepostet\./)).toBeVisible();
    expect(matchingMutation(state.mutations, 'PUT', `/api/v2/guilds/${GUILD_ID}/whitelist/channels`)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: {
        infoChannelId: INFO_CHANNEL,
        requestChannelId: REQUEST_CHANNEL,
        approveLogChannelId: APPROVE_CHANNEL,
        denyLogChannelId: DENY_CHANNEL,
      },
    });

    await page.getByRole('button', { name: 'Info-Embed neu posten' }).click();
    await expect.poll(() => matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist/channels/info/repost`)).toBeTruthy();
    expect(matchingMutation(state.mutations, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist/channels/info/repost`)).toMatchObject({
      query: `?slot=${SLOT}`,
      body: {},
    });
  });

  test('Forbidden-/Mutation-Fehler werden sichtbar und verhindern blinde Folgeaktionen', async ({ page }) => {
    await stubWhitelistDashboard(page, { channelsForbidden: true, addFailure: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`);

    await expect(page.getByText('Channel-Liste nicht verfuegbar (nur Owner kann Kanaele waehlen).')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Speichern' })).toBeDisabled();

    await page.getByPlaceholder('Spielername (1-64 Zeichen)').fill('BlockedPlayer');
    await page.getByRole('button', { name: 'Hinzufuegen' }).click();
    await expect(page.getByText(/ADD_BLOCKED/)).toBeVisible();
  });

  test('Nitrado-Sync-Fehler bleibt sichtbar statt Erfolg zu simulieren', async ({ page }) => {
    await stubWhitelistDashboard(page, { syncFailure: true });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`);

    await page.getByRole('button', { name: 'Pull (Nitrado -> DB)' }).click();
    await page.getByRole('button', { name: 'Vorschau' }).click();
    await expect(page.getByText(/Fehler:/)).toBeVisible();
  });
});

const MOBILE_WIDTHS = [320, 360, 375, 390, 430] as const;

test.describe('Whitelist mobile matrix', () => {
  for (const width of MOBILE_WIDTHS) {
    test(`${width}px Whitelist bleibt bedienbar ohne Seiten-Overflow`, async ({ page }) => {
      await stubWhitelistDashboard(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`);
      await expect(page.getByRole('heading', { name: 'Whitelist (Spielername)' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Kanal-Integration (Whitelist)' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Hinzufuegen' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
