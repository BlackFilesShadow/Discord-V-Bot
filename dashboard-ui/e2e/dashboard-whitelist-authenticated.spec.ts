import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';
const SLOT_ROUTE = `/servers/${GUILD_ID}/server/${SLOT}?tab=whitelist`;

interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubWhitelistDashboard(page: Page, options?: { syncFails?: boolean }) {
  const writes: RecordedRequest[] = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'whitelist-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'whitelist-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;

    if (method !== 'GET') writes.push({ method, path, search: url.search, body });

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
        permissions: ['dashboard.access', 'whitelist.manage'],
        slots: [{ id: 'conn-whitelist-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE', nitradoServerId: '12345' }],
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
    if (path === `/api/v2/guilds/${GUILD_ID}/channels`) {
      await json(route, {
        channels: [
          { id: '111111111111111111', name: 'whitelist-info', type: 0, parentId: null },
          { id: '222222222222222222', name: 'whitelist-requests', type: 0, parentId: null },
          { id: '333333333333333333', name: 'voice-ignored', type: 2, parentId: null },
        ],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/channels`) {
      if (method === 'GET') {
        await json(route, {
          infoChannelId: null,
          requestChannelId: null,
          approveLogChannelId: null,
          denyLogChannelId: null,
          infoMessageId: null,
        });
      } else if (method === 'PUT') {
        await json(route, {
          ok: true,
          ...(body as Record<string, unknown>),
          infoMessageId: 'message-1',
          infoResult: { posted: true, updated: false, messageId: 'message-1' },
        });
      } else {
        await json(route, {});
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/channels/info/repost`) {
      await json(route, { ok: true, posted: true, updated: false });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/requests`) {
      await json(route, {
        requests: [{
          id: 'request-1',
          gameId: 'PendingPlayer',
          requesterDiscordId: '223456789012345678',
          status: 'PENDING',
          createdAt: '2026-08-19T08:00:00.000Z',
        }],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/requests/request-1/decision`) {
      await json(route, { ok: true });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/sync`) {
      if (options?.syncFails) {
        await json(route, { error: 'Nitrado offline' }, 503);
        return;
      }
      const syncBody = body as { mode?: string; direction?: string } | undefined;
      await json(route, {
        ok: true,
        preview: syncBody?.mode === 'preview',
        applied: syncBody?.mode === 'apply',
        diff: {
          direction: syncBody?.direction ?? 'merge',
          mode: syncBody?.mode ?? 'preview',
          counts: { local: 2, remote: 2, both: 1, onlyLocal: 1, onlyRemote: 1 },
          onlyLocal: ['OnlyLocal'],
          onlyRemote: ['OnlyRemote'],
        },
        dbInserted: syncBody?.mode === 'apply' ? 1 : undefined,
        dbDeleted: syncBody?.mode === 'apply' ? 0 : undefined,
        jobsCreated: syncBody?.mode === 'apply' ? 1 : undefined,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist`) {
      if (method === 'GET') {
        await json(route, {
          entries: [{
            gameId: 'ExistingPlayer',
            approvedBy: USER_ID,
            source: 'ADMIN',
            approvedAt: '2026-08-19T08:05:00.000Z',
          }],
        });
      } else {
        await json(route, { ok: true });
      }
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/whitelist/ExistingPlayer`) {
      await json(route, { ok: true });
      return;
    }

    await json(route, {});
  });

  return { writes };
}

function findWrite(
  writes: RecordedRequest[],
  method: string,
  path: string,
): RecordedRequest | undefined {
  return writes.find(row => row.method === method && row.path === path);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Dashboard whitelist authenticated CRUD', () => {
  test('add/remove bleiben Guild+Slot-scoped und senden den bestaetigten Audit-Contract', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(SLOT_ROUTE);

    await expect(page.getByRole('heading', { name: 'Whitelist (Spielername)' })).toBeVisible();
    await expect(page.getByText('ExistingPlayer', { exact: true })).toBeVisible();

    const addButton = page.getByRole('button', { name: /Hinzufuegen/i });
    await expect(addButton).toBeDisabled();
    await page.getByPlaceholder('Spielername (1-64 Zeichen)').fill('NewPlayer');
    await expect(addButton).toBeEnabled();
    await addButton.click();

    await expect.poll(() => findWrite(state.writes, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist`)).toBeTruthy();
    const addWrite = findWrite(state.writes, 'POST', `/api/v2/guilds/${GUILD_ID}/whitelist`)!;
    expect(addWrite.search).toBe(`?slot=${SLOT}`);
    expect(addWrite.body).toEqual({
      gameId: 'NewPlayer',
      confirm: true,
      reason: 'Whitelist-Eintrag hinzugefuegt: NewPlayer',
    });

    const existingRow = page.locator('div.bg-bg-elev').filter({ hasText: 'ExistingPlayer' }).first();
    await existingRow.getByRole('button').click();

    await expect.poll(() => findWrite(state.writes, 'DELETE', `/api/v2/guilds/${GUILD_ID}/whitelist/ExistingPlayer`)).toBeTruthy();
    const removeWrite = findWrite(state.writes, 'DELETE', `/api/v2/guilds/${GUILD_ID}/whitelist/ExistingPlayer`)!;
    expect(removeWrite.search).toBe(`?slot=${SLOT}`);
    expect(removeWrite.body).toEqual({
      confirm: true,
      reason: 'Whitelist-Eintrag entfernt: ExistingPlayer',
    });
  });

  test('Pending-Request Entscheidung bleibt scoped und transportiert Begruendung + Confirm', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(SLOT_ROUTE);

    await expect(page.getByRole('heading', { name: 'Pending-Requests' })).toBeVisible();
    const pendingRow = page.locator('div.bg-bg-elev').filter({ hasText: 'PendingPlayer' }).first();
    await pendingRow.getByPlaceholder('Begruendung (optional)').fill('Regeln bestaetigt');
    await pendingRow.getByRole('button').first().click();

    const decisionPath = `/api/v2/guilds/${GUILD_ID}/whitelist/requests/request-1/decision`;
    await expect.poll(() => findWrite(state.writes, 'POST', decisionPath)).toBeTruthy();
    const decision = findWrite(state.writes, 'POST', decisionPath)!;
    expect(decision.search).toBe(`?slot=${SLOT}`);
    expect(decision.body).toEqual({ approve: true, reason: 'Regeln bestaetigt', confirm: true });
  });

  test('Channel-Save und Repost verwenden nur Text-/Announcement-Kanaele und exakten Slot-Scope', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(SLOT_ROUTE);

    const info = page.getByLabel('Info-Kanal (1× Command-Erklaerung als Embed)');
    await expect(info).toBeVisible();
    await expect(info.locator('option')).toHaveCount(3);
    await info.selectOption('111111111111111111');
    await page.getByLabel('Whitelist-Annahme-Kanal (Approval mit Buttons)').selectOption('222222222222222222');

    await page.getByRole('button', { name: 'Speichern' }).click();
    const channelsPath = `/api/v2/guilds/${GUILD_ID}/whitelist/channels`;
    await expect.poll(() => findWrite(state.writes, 'PUT', channelsPath)).toBeTruthy();
    const save = findWrite(state.writes, 'PUT', channelsPath)!;
    expect(save.search).toBe(`?slot=${SLOT}`);
    expect(save.body).toEqual({
      infoChannelId: '111111111111111111',
      requestChannelId: '222222222222222222',
      approveLogChannelId: null,
      denyLogChannelId: null,
    });
    await expect(page.getByText(/Gespeichert\./)).toBeVisible();

    await page.getByRole('button', { name: 'Info-Embed neu posten' }).click();
    const repostPath = `/api/v2/guilds/${GUILD_ID}/whitelist/channels/info/repost`;
    await expect.poll(() => findWrite(state.writes, 'POST', repostPath)).toBeTruthy();
    expect(findWrite(state.writes, 'POST', repostPath)!.search).toBe(`?slot=${SLOT}`);
    await expect(page.getByText('Info-Embed neu gepostet.')).toBeVisible();
  });

  test('Sync Preview/Apply zeigt Diff und sendet Richtung, Begruendung und Confirm scoped', async ({ page }) => {
    const state = await stubWhitelistDashboard(page);
    await page.goto(SLOT_ROUTE);

    await page.getByRole('button', { name: 'Vorschau' }).click();
    const syncPath = `/api/v2/guilds/${GUILD_ID}/whitelist/sync`;
    await expect.poll(() => state.writes.filter(row => row.method === 'POST' && row.path === syncPath).length).toBe(1);
    expect(state.writes.find(row => row.path === syncPath)?.body).toEqual({ mode: 'preview', direction: 'merge', confirm: true });
    await expect(page.getByText('OnlyLocal', { exact: true })).toBeVisible();
    await expect(page.getByText('OnlyRemote', { exact: true })).toBeVisible();

    page.once('dialog', dialog => dialog.accept('Produktiver Sync')); 
    await page.getByRole('button', { name: 'Anwenden' }).click();
    await expect.poll(() => state.writes.filter(row => row.method === 'POST' && row.path === syncPath).length).toBe(2);
    const apply = state.writes.filter(row => row.method === 'POST' && row.path === syncPath)[1];
    expect(apply.search).toBe(`?slot=${SLOT}`);
    expect(apply.body).toEqual({ mode: 'apply', direction: 'merge', reason: 'Produktiver Sync', confirm: true });
    await expect(page.getByText(/1 lokal hinzugefuegt/)).toBeVisible();
    await expect(page.getByText(/1 Nitrado-Jobs erstellt/)).toBeVisible();
  });

  test('Sync-Backendfehler wird als sichtbarer Error-State dargestellt und nicht verschluckt', async ({ page }) => {
    await stubWhitelistDashboard(page, { syncFails: true });
    await page.goto(SLOT_ROUTE);

    await page.getByRole('button', { name: 'Vorschau' }).click();
    await expect(page.getByText('Fehler: Nitrado offline')).toBeVisible();
  });
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

test.describe('Whitelist mobile viewport matrix', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px Whitelist bleibt bedienbar ohne Seiten-Overflow`, async ({ page }) => {
      await stubWhitelistDashboard(page);
      await page.setViewportSize(viewport);
      await page.goto(SLOT_ROUTE);
      await expect(page.getByRole('heading', { name: 'Whitelist (Spielername)' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Vorschau' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
