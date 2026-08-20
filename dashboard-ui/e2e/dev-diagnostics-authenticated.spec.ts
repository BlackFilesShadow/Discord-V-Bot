import { test, expect, type Locator, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-diagnostics', avatar: null, role: 'DEVELOPER' };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubActiveDev(page: Page): Promise<void> {
  await page.route('**/api/me', route => json(route, { user: DEV_USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: DEV_USER }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: false, expiresAt: null }));
  await page.route('**/api/v2/dev/status', route => json(route, {
    active: true,
    eligible: true,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }));
  await page.route('**/api/v2/dev/logout', route => json(route, { ok: true, revoked: 1 }));
}

const GOOD_SNAPSHOT = {
  botReady: true,
  uptimeSec: 7200,
  guildCount: 3,
  memory: { rss: 128 * 1024 * 1024, heapUsed: 32 * 1024 * 1024, heapTotal: 64 * 1024 * 1024 },
  nodeVersion: 'v24.0.0',
};

test('Snapshot-Fehler invalidiert den vorherigen Live-Stand statt stale online/offline weiterzuzeigen', async ({ page }) => {
  await stubActiveDev(page);
  let reads = 0;
  await page.route('**/api/v2/dev/snapshot', route => {
    reads += 1;
    if (reads === 1) return json(route, GOOD_SNAPSHOT);
    return json(route, { error: 'Snapshot vorübergehend nicht verfügbar.' }, 503);
  });

  await page.goto('/dev/bot-status');
  await expect(page.getByText('online', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Aktualisieren' }).click();
  await expect(page.getByRole('alert')).toContainText('Snapshot vorübergehend nicht verfügbar.');
  await expect(page.getByText('unbekannt', { exact: true })).toBeVisible();
  await expect(page.getByText('online', { exact: true })).toHaveCount(0);
  await expect(page.getByText('offline', { exact: true })).toHaveCount(0);
});

test('malformed erfolgreicher Snapshot wird clientseitig fail-closed verworfen', async ({ page }) => {
  await stubActiveDev(page);
  await page.route('**/api/v2/dev/snapshot', route => json(route, {
    ...GOOD_SNAPSHOT,
    guildCount: -1,
    memory: { ...GOOD_SNAPSHOT.memory, heapUsed: 100, heapTotal: 10 },
  }));

  await page.goto('/dev/bot-status');
  await expect(page.getByRole('alert')).toContainText('Ungültige Snapshot-Antwort');
  await expect(page.getByText('unbekannt', { exact: true })).toBeVisible();
});

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

// Chromium kann ein CSS-44px-Ziel durch Subpixel-Rasterung geringfuegig unter
// 44.00px melden. 0.5px Toleranz verhindert Flakes, ohne kleinere Touch-Ziele
// durchzulassen.
async function expectTouchTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(43.5);
  expect(box!.width).toBeGreaterThanOrEqual(43.5);
}

const VIEWPORTS = [320, 360, 375, 390, 430] as const;

for (const width of VIEWPORTS) {
  test(`Live-Diagnose ist bei ${width}px touch-tauglich und overflow-frei`, async ({ page }) => {
    await stubActiveDev(page);
    await page.route('**/api/v2/dev/snapshot', route => json(route, GOOD_SNAPSHOT));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dev/bot-status');
    await expect(page.getByText('online', { exact: true })).toBeVisible();

    const controls = [
      page.getByRole('button', { name: 'Aktualisieren' }),
      page.getByRole('button', { name: 'error', exact: true }),
      page.getByRole('button', { name: 'warn', exact: true }),
      page.getByRole('button', { name: 'info', exact: true }),
      page.getByRole('button', { name: 'debug', exact: true }),
      page.getByRole('textbox', { name: 'Live-Logs durchsuchen' }),
      page.getByRole('button', { name: 'Pause' }),
      page.getByRole('button', { name: 'Leeren' }),
    ];

    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
    }

    await expectNoPageOverflow(page);
  });

  test(`DEV Diagnoseoberflaechen sind bei ${width}px stabil, touch-tauglich und overflow-frei`, async ({ page }) => {
    await stubActiveDev(page);
    await stubDiagnostics(page);
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/dev/database-status');
    await expect(page.getByRole('heading', { name: 'Datenbank Status', exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);

    await page.goto('/dev/discord-status');
    await expect(page.getByRole('heading', { name: 'Discord API Status', exact: true })).toBeVisible();
    await expect(page.getByText('Discord-Client nicht gebunden.', { exact: true })).toBeVisible();
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);

    await page.goto('/dev/nitrado-status');
    await expect(page.getByRole('heading', { name: 'Nitrado API Status', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ADM-V2 Status', exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);
  });
}

test('DEV Diagnose-Snapshot verschwindet unmittelbar bei serverseitigem Identity-Verlust', async ({ page }) => {
  await stubActiveDev(page);
  const controls = await stubDiagnostics(page);
  await page.goto('/dev/database-status');

  await expect(page.getByText('42', { exact: true })).toBeVisible();
  controls.denyDatabase();
  await page.getByRole('button', { name: 'Aktualisieren' }).click();

  await expect(page.getByRole('alert')).toContainText('Keine globale DEV-Berechtigung.');
  await expect(page.getByText('42', { exact: true })).toHaveCount(0);
});
