import { test, expect, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-test', avatar: null, role: 'DEVELOPER' };
const NORMAL_USER = { discordId: '223456789012345678', username: 'user-test', avatar: null, role: 'USER' };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface DevStubOptions {
  user?: typeof DEV_USER | typeof NORMAL_USER;
  status?: number;
  active?: boolean;
}

async function stubDevShell(page: Page, options: DevStubOptions = {}): Promise<{ snapshotReads: () => number }> {
  const user = options.user ?? DEV_USER;
  const status = options.status ?? 200;
  const active = options.active ?? false;
  let snapshotReads = 0;

  await page.route('**/api/me', route => json(route, { user }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: false, expiresAt: null }));
  await page.route('**/api/v2/dev/status', route => {
    if (status !== 200) return json(route, { error: 'DEV-Status nicht verfügbar.' }, status);
    return json(route, {
      active,
      eligible: user.role === 'DEVELOPER',
      expiresAt: active ? '2026-08-20T12:00:00.000Z' : null,
    });
  });
  await page.route('**/api/v2/dev/snapshot', route => {
    snapshotReads += 1;
    return json(route, {
      botReady: true,
      uptimeSec: 7200,
      guildCount: 3,
      memory: { rss: 1, heapUsed: 2, heapTotal: 3 },
      nodeVersion: 'v24.0.0',
    });
  });
  await page.route('**/api/v2/dev/logout', route => json(route, { ok: true, revoked: 1 }));

  return { snapshotReads: () => snapshotReads };
}

async function expectTouchTarget(locator: import('@playwright/test').Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

async function expectDevLocked(page: Page): Promise<void> {
  await expect(
    page.getByRole('main').getByText('DEV-Session erforderlich', { exact: true }),
  ).toBeVisible();
}

test('normaler USER sieht keine DEV-Login-Affordance und lädt bei Direktzugriff kein DEV-Tool', async ({ page }) => {
  const stub = await stubDevShell(page, { user: NORMAL_USER, active: false });
  await page.goto('/dev');

  await expect(page.getByText('Kein Zugriff')).toBeVisible();
  await expect(page.getByTestId('dev-login-panel')).toHaveCount(0);
  await expect.poll(stub.snapshotReads).toBe(0);
});

test('DEVELOPER ohne bestätigte Session bleibt vor allen Tool-Reads gesperrt', async ({ page }) => {
  const stub = await stubDevShell(page, { active: false });
  await page.goto('/dev');

  await expectDevLocked(page);
  await expect(page.getByTestId('dev-login-panel')).toBeVisible();
  await expect.poll(stub.snapshotReads).toBe(0);
});

test('staler optimistic Hint plus Status-503 fällt fail-closed zurück und löst keinen Snapshot aus', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('devSession.optimistic', '1'));
  const stub = await stubDevShell(page, { active: true, status: 503 });
  await page.goto('/dev');

  await expectDevLocked(page);
  await expect.poll(stub.snapshotReads).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('devSession.optimistic'))).toBeNull();
});

test('bestätigte DEV-Session öffnet den Index, lädt das Tool und Logout sperrt die Shell wieder', async ({ page }) => {
  const stub = await stubDevShell(page, { active: true });
  await page.goto('/dev');

  await expect(page).toHaveURL(/\/dev\/bot-status$/);
  await expect(page.getByText('online', { exact: true })).toBeVisible();
  await expect.poll(stub.snapshotReads).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'DEV-Logout' }).click();
  await expectDevLocked(page);
});

const VIEWPORTS = [320, 360, 375, 390, 430] as const;

for (const width of VIEWPORTS) {
  test(`DEV-Sidebar bleibt bei ${width}px touch-tauglich, semantisch getrennt und overflow-frei`, async ({ page }) => {
    await stubDevShell(page, { active: true });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dev');
    await expect(page).toHaveURL(/\/dev\/bot-status$/);

    await page.getByRole('button', { name: 'Menue oeffnen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Navigation' });
    const nav = dialog.getByRole('navigation', { name: 'DEV Tools' });
    await expect(nav).toBeVisible();

    const commandCenter = nav.getByRole('link', { name: 'DEV Command Center', exact: true });
    const secureExport = nav.getByRole('link', { name: 'Sichere Exporte', exact: true });
    const liveStatus = nav.getByRole('link', { name: 'Live Bot Status', exact: true });
    const pin = nav.getByRole('button', { name: 'Live Bot Status pinnen' });
    const search = nav.getByRole('textbox', { name: 'Tools suchen' });
    const logout = nav.getByRole('button', { name: 'DEV-Logout' });

    await Promise.all([
      expectTouchTarget(commandCenter),
      expectTouchTarget(secureExport),
      expectTouchTarget(liveStatus),
      expectTouchTarget(pin),
      expectTouchTarget(search),
      expectTouchTarget(logout),
    ]);

    const beforePin = page.url();
    await pin.click();
    expect(page.url()).toBe(beforePin);

    const pinnedList = nav.getByRole('list', { name: 'Angepinnte DEV Tools' });
    const pinnedLink = pinnedList.getByRole('link', { name: 'Live Bot Status', exact: true });
    const unpin = pinnedList.getByRole('button', { name: 'Live Bot Status entpinnen' });
    await Promise.all([expectTouchTarget(pinnedLink), expectTouchTarget(unpin)]);
    await unpin.click();
    await expect(pinnedList).toHaveCount(0);
    expect(page.url()).toBe(beforePin);

    await search.fill('bot');
    const clear = nav.getByRole('button', { name: 'Suche leeren' });
    await expectTouchTarget(clear);
    await clear.click();
    await expect(search).toHaveValue('');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
