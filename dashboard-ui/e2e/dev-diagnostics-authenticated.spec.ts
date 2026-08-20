import { test, expect, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-test', avatar: null, role: 'DEVELOPER' };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubDevShell(page: Page): Promise<void> {
  await page.route('**/api/me', route => json(route, { user: DEV_USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: DEV_USER }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: false, expiresAt: null }));
  await page.route('**/api/v2/dev/status', route => json(route, {
    active: true,
    eligible: true,
    expiresAt: '2026-08-20T18:00:00.000Z',
  }));
  await page.route('**/api/v2/dev/logout', route => json(route, { ok: true, revoked: 1 }));
}

async function stubDiagnostics(page: Page): Promise<{ denyDatabase: () => void }> {
  let databaseDenied = false;
  await page.route('**/api/v2/dev/status/database', route => {
    if (databaseDenied) {
      return json(route, { error: 'Keine globale DEV-Berechtigung.', code: 'DEV_IDENTITY_REQUIRED' }, 403);
    }
    return json(route, {
      ok: true,
      degraded: false,
      pingMs: 4,
      pingError: null,
      sizePretty: '128 MB',
      sizeBytes: 134217728,
      migrationsApplied: 42,
      connections: [{ state: 'idle in transaction (aborted)', count: 3 }],
      topTables: [{ name: 'ExtremLangerTabellennameFuerMobileOverflowRegression'.repeat(2), liveRows: 123456, deadRows: 123 }],
      errors: { ping: null, tables: null, size: null, connections: null, migrations: null },
    });
  });
  await page.route('**/api/v2/dev/status/discord', route => json(route, {
    ok: false,
    error: 'Discord-Client nicht gebunden.',
    statusCode: null,
    averagePingMs: null,
    shards: [],
    cache: { guilds: 0, users: 0, channels: 0 },
    user: null,
  }));
  await page.route('**/api/v2/dev/status/nitrado', route => json(route, {
    counts: { PENDING: 1, RUNNING: 0, DONE: 4, FAILED: 1, DEAD: 0 },
    queryMs: 3,
    recentFailures: [{
      id: 'job1',
      operation: 'WHITELIST_ADD_WITH_A_VERY_LONG_OPERATION_NAME',
      guildId: '111111111111111111',
      status: 'FAILED',
      attempts: 2,
      lastError: 'Ein sehr langer bereits redigierter Diagnosefehler '.repeat(8),
      updatedAt: '2026-08-20T12:00:00.000Z',
    }],
    oldestPendingAt: '2026-08-20T12:00:00.000Z',
    oldestPendingAgeSec: 900,
  }));
  await page.route('**/api/v2/dev/status/adm', route => json(route, {
    sourceMode: 'PER_SERVER_V2',
    pollIntervalSec: 30,
    publicGameplayFeedEnabled: true,
    queryMs: 5,
    connections: [{
      nitradoConnId: 'conn1',
      guildId: '111111111111111111',
      slot: 1,
      alias: 'SehrLangerServerAliasFuerMobile',
      alias5: 'slot1',
      serviceId: '1234567',
      admLinked: true,
      source: {
        profileDir: '/gameserver/profile/'.repeat(12),
        source: 'nitrado',
        timeZone: 'Europe/Berlin',
        lastVerifiedAt: '2026-08-20T12:00:00.000Z',
        lastError: null,
        updatedAt: '2026-08-20T12:00:00.000Z',
      },
      cursor: {
        fileName: 'DayZServer_X1_x64_very_long_adm_filename.ADM',
        lastModifiedAt: 1,
        lastModifiedIso: '2026-08-20T12:00:00.000Z',
        lastKnownSize: 999999,
        processedByteOffset: 888888,
        lastSuccessAt: '2026-08-20T12:00:00.000Z',
        lastError: null,
        updatedAt: '2026-08-20T12:00:00.000Z',
      },
    }],
  }));
  return { denyDatabase: () => { databaseDenied = true; } };
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectTouchTarget(locator: import('@playwright/test').Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(43.99);
  expect(box!.width).toBeGreaterThanOrEqual(43.99);
}

const VIEWPORTS = [320, 360, 375, 390, 430] as const;

for (const width of VIEWPORTS) {
  test(`DEV Diagnoseoberflaechen sind bei ${width}px stabil, touch-tauglich und overflow-frei`, async ({ page }) => {
    await stubDevShell(page);
    await stubDiagnostics(page);
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/dev/database-status');
    await expect(page.getByText('Datenbank Status', { exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);

    await page.goto('/dev/discord-status');
    await expect(page.getByText('Discord API Status', { exact: true })).toBeVisible();
    await expect(page.getByText('Discord-Client nicht gebunden.', { exact: true })).toBeVisible();
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);

    await page.goto('/dev/nitrado-status');
    await expect(page.getByText('Nitrado API Status', { exact: true })).toBeVisible();
    await expect(page.getByText('ADM-V2 Status', { exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);
  });
}

test('DEV Diagnose-Snapshot verschwindet unmittelbar bei serverseitigem Identity-Verlust', async ({ page }) => {
  await stubDevShell(page);
  const controls = await stubDiagnostics(page);
  await page.goto('/dev/database-status');

  await expect(page.getByText('42', { exact: true })).toBeVisible();
  controls.denyDatabase();
  await page.getByRole('button', { name: 'Aktualisieren' }).click();

  await expect(page.getByRole('alert')).toContainText('Keine globale DEV-Berechtigung.');
  await expect(page.getByText('42', { exact: true })).toHaveCount(0);
});
