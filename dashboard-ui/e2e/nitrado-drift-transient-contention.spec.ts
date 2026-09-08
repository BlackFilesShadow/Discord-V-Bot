import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';
const BUSY_ERROR = 'Nitrado-Verbindung wird gerade sicher verarbeitet oder parallel geaendert. Bitte erneut laden.';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface DriftStubState {
  whitelistCalls: () => number;
  banCalls: () => number;
}

async function stubAuthenticatedServer(
  page: Page,
  mode: 'transient-then-success' | 'non-transient-conflict',
): Promise<DriftStubState> {
  let whitelistCalls = 0;
  let banCalls = 0;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'drift-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'drift-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;

    if (path === '/api/v2/dev/status') {
      await json(route, { active: false, eligible: true, expiresAt: null });
      return;
    }
    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === '/api/v2/guilds') {
      await json(route, {
        guilds: [{
          id: GUILD_ID,
          name: 'Die Chaoten',
          iconUrl: null,
          memberCount: 42,
          botPresent: true,
          alias5: 'CHAOS',
          isOwner: true,
        }],
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      await json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: true,
        permissions: ['dashboard.access', 'whitelist.manage', 'bans.manage'],
        slots: [{
          id: 'conn-drift-1',
          slot: 1,
          alias: 'Chernarus',
          alias5: 'CH001',
          status: 'ACTIVE',
          nitradoServerId: '12345',
        }],
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
    if (path === `/api/v2/guilds/${GUILD_ID}/nitrado-drift/whitelist`) {
      whitelistCalls += 1;
      if (mode === 'non-transient-conflict') {
        await json(route, {
          error: 'Nitrado-Verbindung ist nicht ACTIVE oder besitzt keine Service-ID.',
        }, 409);
        return;
      }
      if (whitelistCalls === 1) {
        await json(route, { error: BUSY_ERROR }, 409);
        return;
      }
      await json(route, { observedAt: new Date().toISOString(), items: [] });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/nitrado-drift/bans`) {
      banCalls += 1;
      if (mode === 'transient-then-success' && banCalls === 1) {
        await json(route, {
          error: 'future localized binding conflict',
          code: 'NITRADO_BINDING_STALE',
        }, 409);
        return;
      }
      await json(route, { observedAt: new Date().toISOString(), items: [] });
      return;
    }

    await json(route, {});
  });

  return {
    whitelistCalls: () => whitelistCalls,
    banCalls: () => banCalls,
  };
}

test.describe('Nitrado drift transient contention', () => {
  test('known binding contention retries automatically and clears without a false drift alarm', async ({ page }) => {
    const state = await stubAuthenticatedServer(page, 'transient-then-success');
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);

    await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
    await expect.poll(state.whitelistCalls, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(state.banCalls, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);

    await expect(page.getByRole('heading', { name: 'Nitrado-Driftprüfung fehlgeschlagen' })).toHaveCount(0);
    await expect(page.getByTestId('nitrado-drift-banner')).toHaveCount(0);
  });

  test('an unrelated 409 remains fail-closed and visible instead of being auto-masked', async ({ page }) => {
    const state = await stubAuthenticatedServer(page, 'non-transient-conflict');
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);

    await expect(page.getByRole('heading', { name: 'Nitrado-Driftprüfung fehlgeschlagen' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Nitrado-Verbindung ist nicht ACTIVE oder besitzt keine Service-ID.');
    expect(state.whitelistCalls()).toBe(1);
  });
});
