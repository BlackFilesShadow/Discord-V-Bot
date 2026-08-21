import { test, expect, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-test', avatar: null, role: 'DEVELOPER' };
const TARGET_SESSION = 'session-stage26-0001';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Write {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | undefined;
}

async function stubDevSensitive(page: Page) {
  const writes: Write[] = [];
  let sessionActive = true;
  let maintenanceActive = false;

  await page.route('**/api/me', route => json(route, { user: DEV_USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: DEV_USER }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = req.postData() ? req.postDataJSON() : undefined;
    const record = (): void => writes.push({ method, path, body, idempotencyKey: req.headers()['x-idempotency-key'] });

    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === '/api/v2/dev/status') {
      await json(route, { active: true, eligible: true, expiresAt: '2026-08-21T18:00:00.000Z' });
      return;
    }

    if (path === '/api/v2/dev/sessions' && method === 'GET') {
      await json(route, {
        sessions: sessionActive ? [{
          id: TARGET_SESSION,
          userDiscordId: '888888888888888888',
          createdAt: '2026-08-21T09:00:00.000Z',
          expiresAt: '2026-08-21T12:00:00.000Z',
          scope: null,
          remainingMs: 3_600_000,
          totalLifetimeMs: 7_200_000,
        }] : [],
      });
      return;
    }
    if (path === `/api/v2/dev/sessions/${TARGET_SESSION}/revoke` && method === 'POST') {
      record();
      sessionActive = false;
      await json(route, { ok: true, revoked: true });
      return;
    }

    if (path === '/api/v2/dev/incident/state' && method === 'GET') {
      await json(route, {
        ok: true,
        toggles: maintenanceActive ? [{
          action: 'maintenance', active: true,
          activatedAt: '2026-08-21T10:00:00.000Z',
          expiresAt: '2026-08-21T11:00:00.000Z',
          reason: 'Stage 26 incident test',
          byUserId: 'u1', byDiscordId: DEV_USER.discordId,
        }] : [],
        limits: {
          'kill.ai': { maxDurationMs: 3_600_000, defaultMs: 900_000, kind: 'toggle' },
          'kill.automod': { maxDurationMs: 3_600_000, defaultMs: 900_000, kind: 'toggle' },
          'kill.translation': { maxDurationMs: 3_600_000, defaultMs: 900_000, kind: 'toggle' },
          'provider.force': { maxDurationMs: 14_400_000, defaultMs: 900_000, kind: 'toggle' },
          maintenance: { maxDurationMs: 14_400_000, defaultMs: 900_000, kind: 'toggle' },
          'cache.flush': { maxDurationMs: 0, defaultMs: 0, kind: 'oneshot' },
          'backup.trigger': { maxDurationMs: 0, defaultMs: 0, kind: 'oneshot' },
        },
      });
      return;
    }
    if (path === '/api/v2/dev/incident/activate' && method === 'POST') {
      record();
      maintenanceActive = true;
      await json(route, { ok: true });
      return;
    }

    if (path === '/api/v2/dev/stubs/debug' && method === 'GET') {
      await json(route, {
        heap: {
          total_heap_size: 1_000_000, used_heap_size: 500_000, heap_size_limit: 10_000_000,
          malloced_memory: 0, external_memory: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0,
        },
        heapSpaces: [],
        eventLoopDelay: { minMs: 0, maxMs: 1, meanMs: 0.2, p50Ms: 0.1, p95Ms: 0.5, p99Ms: 0.9 },
        resourceUsage: { userCPU: 1, systemCPU: 1, maxRSS: 1024, fsRead: 0, fsWrite: 0 },
        perfNow: 1,
        nodeVersion: 'v24.0.0',
        generatedAt: '2026-08-21T10:00:00.000Z',
      });
      return;
    }
    if (path === '/api/v2/dev/stubs/debug/heap-snapshot' && method === 'POST') {
      record();
      await json(route, { ok: true, file: '/tmp/heap-stage26.heapsnapshot' });
      return;
    }

    if (path.startsWith('/api/v2/dev/secure-export/') && method === 'POST') {
      record();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-disposition': 'attachment; filename="stage26-export.json"' },
        body: JSON.stringify({ ok: true, rows: [] }),
      });
      return;
    }

    await json(route, {});
  });

  return { writes: () => [...writes] };
}

async function fillStepUp(page: Page, reason: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('z. B. Provider-Ausfall, Fallback erzwingen…').fill(reason);
  await dialog.getByPlaceholder('••••••••').fill('123456');
  await dialog.getByRole('button', { name: /Bestaetigen/ }).click();
}

function expectWrite(write: Write, method: string, path: string): void {
  expect(write.method).toBe(method);
  expect(write.path).toBe(path);
  expect(write.idempotencyKey).toBeTruthy();
  expect(write.idempotencyKey!.length).toBeGreaterThan(8);
}

test('Active Sessions Force-Revoke ist Step-Up geschützt und target-gescoped', async ({ page }) => {
  const stub = await stubDevSensitive(page);
  await page.goto('/dev/active-sessions');
  await expect(page.getByRole('heading', { name: 'Aktive DEV-Sessions', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Force-Revoke' }).click();
  await fillStepUp(page, 'Stage 26 session revoke');

  await expect.poll(() => stub.writes().length).toBe(1);
  const write = stub.writes()[0];
  expectWrite(write, 'POST', `/api/v2/dev/sessions/${TARGET_SESSION}/revoke`);
  expect(write.body).toEqual({ reason: 'Stage 26 session revoke', reAuth: '123456' });
  await expect(page.getByText('Keine aktiven Sessions', { exact: true })).toBeVisible();
});

test('Incident Wartungsmodus nutzt Step-Up plus doppelte Idempotenz-Sicherung', async ({ page }) => {
  const stub = await stubDevSensitive(page);
  await page.goto('/dev/incident-response');
  await expect(page.getByRole('heading', { name: 'Incident Response', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Aktivieren' }).last().click();
  await expect(page.getByRole('dialog')).toContainText('Wartungsmodus');
  await fillStepUp(page, 'Stage 26 maintenance');

  await expect.poll(() => stub.writes().length).toBe(1);
  const write = stub.writes()[0];
  expectWrite(write, 'POST', '/api/v2/dev/incident/activate');
  expect(write.body).toEqual(expect.objectContaining({
    action: 'maintenance',
    reason: 'Stage 26 maintenance',
    reAuth: '123456',
  }));
  expect((write.body as { idempotencyKey?: string }).idempotencyKey).toBeTruthy();
});

test('Heap-Snapshot ist Step-Up geschützt und API-idempotent', async ({ page }) => {
  const stub = await stubDevSensitive(page);
  await page.goto('/dev/debug-tools');
  await expect(page.getByRole('heading', { name: 'Debug Tools', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Heap-Snapshot' }).click();
  await fillStepUp(page, 'Stage 26 heap snapshot');

  await expect.poll(() => stub.writes().length).toBe(1);
  const write = stub.writes()[0];
  expectWrite(write, 'POST', '/api/v2/dev/stubs/debug/heap-snapshot');
  expect(write.body).toEqual({ reason: 'Stage 26 heap snapshot', reAuth: '123456' });
  await expect(page.getByText('/tmp/heap-stage26.heapsnapshot', { exact: true })).toBeVisible();
});

test('Secure Export bleibt POST-only, Re-Auth geschützt und idempotent', async ({ page }) => {
  const stub = await stubDevSensitive(page);
  await page.goto('/dev/secure-export?kind=logs&category=SECURITY&days=7');
  await expect(page.getByText('Sicherer DEV-Export', { exact: true })).toBeVisible();

  await page.getByPlaceholder('TOTP bei aktiver 2FA, sonst DEV-Passwort').fill('123456');
  await page.getByRole('button', { name: 'Export freigeben' }).click();

  await expect.poll(() => stub.writes().length).toBe(1);
  const write = stub.writes()[0];
  expectWrite(write, 'POST', '/api/v2/dev/secure-export/logs');
  expect(write.body).toEqual({ category: 'SECURITY', days: 7, reason: 'Sensibler DEV-Export', reAuth: '123456' });
  await expect(page.getByText('Export erfolgreich erstellt', { exact: true })).toBeVisible();
});

const VIEWPORTS = [320, 360, 375, 390, 430] as const;
for (const width of VIEWPORTS) {
  test(`Sensitive DEV actions bleiben bei ${width}px erreichbar und overflow-frei`, async ({ page }) => {
    await stubDevSensitive(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dev/active-sessions');
    await expect(page.getByRole('button', { name: 'Force-Revoke' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
