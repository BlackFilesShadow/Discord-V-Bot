import { test, expect, type Page, type Route } from '@playwright/test';

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
    expiresAt: '2026-08-20T20:00:00.000Z',
  }));
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
      expect(box!.height).toBeGreaterThanOrEqual(43.99);
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
