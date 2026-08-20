import { test, expect, type Locator, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-observability', avatar: null, role: 'DEVELOPER' };

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

async function stubObservability(page: Page): Promise<{ denyLogs: () => void }> {
  let logsDenied = false;

  await page.route('**/api/v2/dev/observability/metrics/prisma', route => json(route, {
    buckets: [{
      key: 'VeryLongPrismaModelNameForMobileOverflowRegression:findManyWithLongAction',
      count: 42,
      totalCount: 42,
      errorCount: 1,
      errorRate: 1 / 42,
      p50: 4,
      p95: 12,
      p99: 30,
      lastTs: Date.now(),
    }],
  }));

  await page.route('**/api/v2/dev/observability/metrics/ai', route => json(route, {
    buckets: [{
      provider: 'provider-with-a-very-long-mobile-overflow-name',
      action: 'retrieval-with-a-very-long-action-name',
      count: 12,
      totalCount: 12,
      errorCount: 0,
      errorRate: 0,
      p50: 80,
      p95: 140,
      p99: 190,
      lastTs: Date.now(),
    }],
  }));

  await page.route('**/api/v2/dev/observability/logs?*', route => {
    if (logsDenied) {
      return json(route, { error: 'Diese globale DEV-Diagnose ist in einer Guild-beschraenkten Session gesperrt.', code: 'DEV_SCOPE_RESTRICTED' }, 403);
    }
    return json(route, {
      entries: [{
        ts: Date.now(),
        level: 'info',
        message: 'observability-log '.repeat(12),
        meta: 'meta-with-a-very-long-value '.repeat(12),
      }],
      count: 1,
    });
  });

  await page.route('**/api/v2/dev/observability/backup/status', route => json(route, {
    dir: '/opt/discord-v-bot/backup/a-very-long-directory-segment/'.repeat(4),
    exists: true,
    count: 1,
    totalBytes: 2048,
    newest: null,
    oldest: null,
    entries: [{
      name: 'backup_2026_08_20_with_a_very_long_mobile_regression_name',
      bytes: 2048,
      files: 3,
      mtimeMs: Date.now(),
      ageMs: 30_000,
    }],
  }));

  return { denyLogs: () => { logsDenied = true; } };
}

async function stubAudit(page: Page): Promise<void> {
  await page.route('**/api/v2/dev/observability/audit/search?*', route => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    if (!cursor) {
      return json(route, {
        entries: [{
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          action: 'AUDIT_FIRST_WITH_A_VERY_LONG_ACTION_FOR_MOBILE_OVERFLOW',
          category: 'SECURITY',
          guildId: '111111111111111111',
          createdAt: '2026-08-20T18:00:00.000Z',
          actor: { discordId: '123456789012345678', username: 'first-actor-with-long-name' },
          target: null,
          channelId: null,
          ipAddress: '127.0.0.1',
          details: { safe: true },
        }],
        limit: 50,
        hasMore: true,
        nextCursor: 'v1.test-cursor',
      });
    }

    return json(route, {
      entries: [{
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        action: 'AUDIT_SECOND',
        category: 'SYSTEM',
        guildId: '222222222222222222',
        createdAt: '2026-08-20T17:59:59.000Z',
        actor: null,
        target: null,
        channelId: null,
        ipAddress: null,
        details: null,
      }],
      limit: 50,
      hasMore: false,
      nextCursor: null,
    });
  });
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
  test(`DEV Observability und Audit Logs sind bei ${width}px touch-tauglich, paginierbar und overflow-frei`, async ({ page }) => {
    await stubActiveDev(page);
    await stubObservability(page);
    await stubAudit(page);
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/dev/observability');
    await expect(page.getByRole('heading', { name: 'Observability', exact: true })).toBeVisible();
    await expect(page.getByText(/observability-log/)).toBeVisible();
    await expectTouchTarget(page.getByRole('combobox', { name: 'Log-Level' }));
    await expectTouchTarget(page.getByRole('textbox', { name: 'Live-Logs durchsuchen' }));
    await expectTouchTarget(page.getByRole('button', { name: 'Refresh' }));
    await expectNoPageOverflow(page);

    await page.goto('/dev/audit-logs');
    await expect(page.getByRole('heading', { name: 'Audit Logs', exact: true })).toBeVisible();
    await expect(page.getByText(/AUDIT_FIRST_WITH_A_VERY_LONG_ACTION/)).toBeVisible();
    await expectTouchTarget(page.getByRole('textbox', { name: 'Audit-Suche' }));
    await expectTouchTarget(page.getByRole('combobox', { name: 'Audit-Kategorie' }));
    await expectTouchTarget(page.getByRole('textbox', { name: 'Guild-ID' }));
    await expectTouchTarget(page.getByRole('button', { name: 'Suchen' }));
    await expectTouchTarget(page.getByRole('button', { name: 'Refresh' }));
    await expectTouchTarget(page.getByRole('button', { name: 'Mehr laden' }));
    await expectNoPageOverflow(page);

    await page.getByRole('button', { name: 'Mehr laden' }).click();
    await expect(page.getByText(/AUDIT_FIRST_WITH_A_VERY_LONG_ACTION/)).toBeVisible();
    await expect(page.getByText('AUDIT_SECOND', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mehr laden' })).toHaveCount(0);
    await expectNoPageOverflow(page);
  });
}

test('Observability verwirft privilegierte Log-Daten sichtbar bei serverseitigem Scope-Verlust', async ({ page }) => {
  await stubActiveDev(page);
  const controls = await stubObservability(page);
  await page.goto('/dev/observability');

  await expect(page.getByText(/observability-log/)).toBeVisible();
  controls.denyLogs();
  await page.getByRole('button', { name: 'Refresh' }).click();

  await expect(page.getByRole('alert')).toContainText('Guild-beschraenkten Session gesperrt');
  await expect(page.getByText(/observability-log/)).toHaveCount(0);
});
