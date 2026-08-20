import { test, expect, type Locator, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-mirror', avatar: null, role: 'DEVELOPER' };
const GUILD_ID = '111111111111111111';
const CONN_ID = 'conn_1';
const SNAPSHOT_ID = 'snapshot_1';
const TRIGGERED_SNAPSHOT_ID = 'snapshot_new';

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

interface MirrorControls {
  triggerBodies: Array<Record<string, unknown>>;
}

async function stubMirror(page: Page): Promise<MirrorControls> {
  const triggerBodies: Array<Record<string, unknown>> = [];

  await page.route('**/api/v2/dev/nitrado-mirror/connections', route => json(route, {
    connections: [{
      id: CONN_ID,
      guildId: GUILD_ID,
      slot: 1,
      alias: 'VeryLongMirrorAliasForMobileOverflowRegression'.repeat(2),
      alias5: 'server1',
      serviceId: '12345678',
      status: 'ACTIVE',
    }],
    scope: { global: true },
  }));

  await page.route('**/api/v2/dev/nitrado-mirror/snapshots?*', route => json(route, {
    snapshots: [{
      id: SNAPSHOT_ID,
      startedAt: '2026-08-20T18:00:00.000Z',
      finishedAt: '2026-08-20T18:01:00.000Z',
      status: 'OK',
      totalFiles: 12,
      totalDirs: 3,
      totalBytes: '4096',
      storedBytes: '4096',
      oversizeFiles: 0,
      errorCount: 0,
    }],
  }));

  await page.route('**/api/v2/dev/nitrado-mirror/*/files?*', route => json(route, {
    dir: '/',
    entries: [
      {
        id: 'entry_dir',
        path: '/mission/'.concat('very-long-folder-name-'.repeat(8)),
        name: 'very-long-folder-name-'.repeat(8),
        parentDir: '/',
        isDir: true,
        sizeBytes: '0',
        modifiedAt: null,
        sha256: null,
        mimeGuess: null,
        isText: false,
        oversize: false,
        errorMsg: null,
        hasContent: false,
      },
      {
        id: 'entry_file',
        path: '/mission/'.concat('very-long-config-name-'.repeat(8), 'types.xml'),
        name: 'very-long-config-name-'.repeat(8).concat('types.xml'),
        parentDir: '/',
        isDir: false,
        sizeBytes: '1024',
        modifiedAt: null,
        sha256: 'abcdef1234567890',
        mimeGuess: 'application/xml',
        isText: true,
        oversize: false,
        errorMsg: null,
        hasContent: true,
      },
    ],
  }));

  await page.route('**/api/v2/dev/nitrado-mirror/*/file?*', route => json(route, {
    meta: {
      id: 'entry_file',
      path: '/mission/types.xml',
      name: 'types.xml',
      parentDir: '/mission',
      isDir: false,
      sizeBytes: '1024',
      modifiedAt: null,
      sha256: 'abcdef1234567890',
      mimeGuess: 'application/xml',
      isText: true,
      oversize: false,
      errorMsg: null,
      hasContent: true,
    },
    text: '<types><type name="LongMobileRegressionValue" /></types>',
    oversize: false,
  }));

  await page.route('**/api/v2/dev/nitrado-mirror/trigger', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    triggerBodies.push(body);
    await json(route, { snapshotId: TRIGGERED_SNAPSHOT_ID }, 202);
  });

  await page.route(`**/api/v2/dev/nitrado-mirror/progress/${TRIGGERED_SNAPSHOT_ID}?*`, route => json(route, {
    id: TRIGGERED_SNAPSHOT_ID,
    status: 'OK',
    totalFiles: 14,
    totalDirs: 4,
    totalBytes: '8192',
    storedBytes: '8192',
    oversizeFiles: 0,
    errorCount: 0,
  }));

  return { triggerBodies };
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectTouchTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(43.5);
  expect(box!.width).toBeGreaterThanOrEqual(43.5);
}

const VIEWPORTS = [320, 360, 375, 390, 430] as const;

for (const width of VIEWPORTS) {
  test(`DEV Nitrado Mirror ist bei ${width}px touch-tauglich und overflow-frei`, async ({ page }) => {
    await stubActiveDev(page);
    await stubMirror(page);
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/dev/nitrado-mirror');
    await expect(page.getByText('Nitrado Mirror (Server Read-Only)', { exact: true })).toBeVisible();

    const connection = page.getByRole('combobox', { name: 'Nitrado-Connection' });
    await expectTouchTarget(connection);
    await connection.selectOption(CONN_ID);

    const trigger = page.getByRole('button', { name: 'Snapshot starten' });
    await expectTouchTarget(trigger);
    await expect(page.getByText('Snapshots', { exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'Browse' }));
    await expectTouchTarget(page.getByRole('button', { name: 'Aktualisieren' }));
    await expectNoPageOverflow(page);

    await page.getByRole('button', { name: 'Browse' }).click();
    await expect(page.getByText(/very-long-config-name/)).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: 'ansehen' }));
    await expectTouchTarget(page.getByRole('button', { name: 'oeffnen', exact: true }));
    await expectNoPageOverflow(page);

    await page.getByRole('button', { name: 'ansehen' }).click();
    await expect(page.getByText(/LongMobileRegressionValue/)).toBeVisible();
    await expectNoPageOverflow(page);
  });
}

test('Snapshot-Trigger sendet Reason und Re-Auth erst nach Step-Up-Bestaetigung', async ({ page }) => {
  await stubActiveDev(page);
  const controls = await stubMirror(page);

  await page.goto('/dev/nitrado-mirror');
  await page.getByRole('combobox', { name: 'Nitrado-Connection' }).selectOption(CONN_ID);
  await page.getByRole('button', { name: 'Snapshot starten' }).click();

  await expect(page.getByText('Nitrado-Snapshot starten', { exact: true })).toBeVisible();
  await page.getByPlaceholder(/Provider-Ausfall/).fill('manual mirror audit capture');
  await page.getByPlaceholder('••••••••', { exact: true }).fill('123456');
  await page.getByRole('button', { name: /Bestaetigen/ }).click();

  await expect.poll(() => controls.triggerBodies.length).toBe(1);
  expect(controls.triggerBodies[0]).toEqual({
    guildId: GUILD_ID,
    connId: CONN_ID,
    reason: 'manual mirror audit capture',
    reAuth: '123456',
  });
  await expect(page.getByRole('heading', {
    name: `Snapshot ${TRIGGERED_SNAPSHOT_ID.slice(0, 8)} · OK`,
  })).toBeVisible();
});

test('spaete Snapshot-Antwort einer alten Connection kann die neue Auswahl nicht ueberschreiben', async ({ page }) => {
  await stubActiveDev(page);
  const secondConnId = 'conn_2';
  const secondGuildId = '222222222222222222';
  let firstRequestStarted = false;

  await page.route('**/api/v2/dev/nitrado-mirror/connections', route => json(route, {
    connections: [
      { id: CONN_ID, guildId: GUILD_ID, slot: 1, alias: 'first', alias5: 'server1', serviceId: '12345678', status: 'ACTIVE' },
      { id: secondConnId, guildId: secondGuildId, slot: 2, alias: 'second', alias5: 'server2', serviceId: '87654321', status: 'ACTIVE' },
    ],
    scope: { global: true },
  }));
  await page.route('**/api/v2/dev/nitrado-mirror/snapshots?*', async route => {
    const connId = new URL(route.request().url()).searchParams.get('connId');
    if (connId === CONN_ID) {
      firstRequestStarted = true;
      await new Promise(resolve => setTimeout(resolve, 250));
      await json(route, {
        snapshots: [{
          id: 'stale_snapshot', startedAt: '2026-08-20T18:00:00.000Z', finishedAt: '2026-08-20T18:01:00.000Z',
          status: 'OK', totalFiles: 111, totalDirs: 1, totalBytes: '111', storedBytes: '111', oversizeFiles: 0, errorCount: 0,
        }],
      });
      return;
    }
    await json(route, {
      snapshots: [{
        id: 'current_snapshot', startedAt: '2026-08-20T19:00:00.000Z', finishedAt: '2026-08-20T19:01:00.000Z',
        status: 'OK', totalFiles: 222, totalDirs: 2, totalBytes: '222', storedBytes: '222', oversizeFiles: 0, errorCount: 0,
      }],
    });
  });

  await page.goto('/dev/nitrado-mirror');
  const connection = page.getByRole('combobox', { name: 'Nitrado-Connection' });
  await connection.selectOption(CONN_ID);
  await expect.poll(() => firstRequestStarted).toBe(true);
  await connection.selectOption(secondConnId);

  await expect(page.getByText('222', { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  await expect(page.getByText('111', { exact: true })).toHaveCount(0);
  await expect(page.getByText('222', { exact: true })).toBeVisible();
});

test('Scope-/Backendfehler verwirft Connection-Daten sichtbar', async ({ page }) => {
  await stubActiveDev(page);
  await page.route('**/api/v2/dev/nitrado-mirror/connections', route => json(route, {
    error: 'Diese DEV-Session ist auf eine andere Guild beschraenkt.',
    code: 'DEV_SCOPE_RESTRICTED',
  }, 403));

  await page.goto('/dev/nitrado-mirror');
  await expect(page.getByRole('alert')).toContainText('andere Guild');
  await expect(page.getByRole('combobox', { name: 'Nitrado-Connection' }).locator('option')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Snapshot starten' })).toBeDisabled();
});
