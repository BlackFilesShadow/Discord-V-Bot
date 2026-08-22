/**
 * Stages 27–35 real browser → Express → OAuth/session → AuthZ → PostgreSQL proof.
 * Discord is simulated only at the server-side axios boundary; dashboard HTTP,
 * middleware, production routers, Prisma queries and side effects are real.
 */
import { test, expect, type Page } from '@playwright/test';
import { Pool } from 'pg';

const DISCORD_ID = ['913456789', '01234567', '8'].join('');
const GUILD_ID = ['923456789', '01234567', '0'].join('');
const AUDIT_PREFIX = 'settings.patch.e2e.';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required for the real dashboard Playwright project.');

const db = new Pool({ connectionString: DATABASE_URL, max: 2, idleTimeoutMillis: 5_000 });

test.describe.configure({ mode: 'serial' });

async function loginThroughRealOAuthCallback(page: Page): Promise<void> {
  const request = page.context().request;
  const login = await request.get('/auth/login', { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  const authorize = new URL(login.headers().location ?? '');
  const state = authorize.searchParams.get('state');
  expect(state).toBeTruthy();

  const callback = await request.get(
    `/auth/callback?code=stage-2735-code&state=${encodeURIComponent(String(state))}`,
    { maxRedirects: 0 },
  );
  expect(callback.status()).toBe(302);
  expect(callback.headers().location).toBe('http://127.0.0.1:4173/servers');

  const me = await request.get('/api/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    user: { discordId: DISCORD_ID, username: 'stage-2735-real-db', role: 'DEVELOPER' },
  });
}

async function resetSettings(): Promise<void> {
  await db.query(
    'UPDATE "ServerSettings" SET "whitelistActive" = TRUE WHERE "guildId" = $1',
    [GUILD_ID],
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.beforeEach(async () => {
  await resetSettings();
});

test.afterAll(async () => {
  await db.end();
});

test('Stage 27: real authenticated settings action commits one DB side effect', async ({ page }) => {
  await loginThroughRealOAuthCallback(page);
  const beforeClaims = Number((await db.query('SELECT COUNT(*)::int AS count FROM "IdempotencyKey"')).rows[0].count);
  const beforeAudit = Number((await db.query(
    'SELECT COUNT(*)::int AS count FROM "AuditLog" WHERE "guildId" = $1 AND action = $2',
    [GUILD_ID, 'SERVER_SETTINGS_UPDATED'],
  )).rows[0].count);

  await page.goto(`/servers/${GUILD_ID}/server/1?tab=settings`);
  await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
  const whitelist = page.getByRole('switch', { name: /Whitelist aktiv/i });
  await expect(whitelist).toBeChecked();
  await whitelist.click();

  await expect(page.getByText('Gespeichert').first()).toBeVisible();
  await expect(page.getByText('Server-Einstellungen aktualisiert.').first()).toBeVisible();
  await expect.poll(async () => {
    const row = await db.query(
      'SELECT "whitelistActive" FROM "ServerSettings" WHERE "guildId" = $1',
      [GUILD_ID],
    );
    return row.rows[0]?.whitelistActive;
  }).toBe(false);
  await expect.poll(async () => Number((await db.query(
    'SELECT COUNT(*)::int AS count FROM "IdempotencyKey"',
  )).rows[0].count)).toBe(beforeClaims + 1);
  await expect.poll(async () => Number((await db.query(
    'SELECT COUNT(*)::int AS count FROM "AuditLog" WHERE "guildId" = $1 AND action = $2',
    [GUILD_ID, 'SERVER_SETTINGS_UPDATED'],
  )).rows[0].count)).toBe(beforeAudit + 1);

  const claim = await db.query(
    'SELECT status, "responseStatus" FROM "IdempotencyKey" ORDER BY "createdAt" DESC LIMIT 1',
  );
  expect(claim.rows[0]).toMatchObject({ status: 'DONE', responseStatus: 200 });
  const authRows = await db.query(
    'SELECT (SELECT COUNT(*)::int FROM "Session" s JOIN "User" u ON u.id=s."userId" WHERE u."discordId"=$1 AND s."isActive"=TRUE) AS sessions, (SELECT COUNT(*)::int FROM "OAuthToken" o JOIN "User" u ON u.id=o."userId" WHERE u."discordId"=$1) AS oauth',
    [DISCORD_ID],
  );
  expect(Number(authRows.rows[0].sessions)).toBeGreaterThanOrEqual(1);
  expect(Number(authRows.rows[0].oauth)).toBeGreaterThanOrEqual(1);
});

test('Stage 28: real AuditLog search/filter/cursor appends page two without loss', async ({ page }) => {
  await loginThroughRealOAuthCallback(page);
  await page.goto('/dev/audit-logs');
  await expect(page.getByRole('heading', { name: 'Audit Logs', exact: true })).toBeVisible();
  await expect(page.getByText(`${AUDIT_PREFIX}00`, { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'Audit-Suche' }).fill(AUDIT_PREFIX);
  await page.getByRole('combobox', { name: 'Audit-Kategorie' }).selectOption('SERVER_SETTINGS');
  await page.getByRole('textbox', { name: 'Guild-ID' }).fill(GUILD_ID);
  await page.getByRole('button', { name: 'Suchen' }).click();

  await expect(page.getByText('50 geladen (Seitenlimit 50, mehr verfuegbar)')).toBeVisible();
  await page.getByRole('button', { name: 'Mehr laden' }).click();
  await expect(page.getByText(`${AUDIT_PREFIX}00`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${AUDIT_PREFIX}54`, { exact: true })).toBeVisible();
  await expect(page.getByText('55 geladen (Seitenlimit 50)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mehr laden' })).toHaveCount(0);
});

test('Stage 29: DB revocation reaches the real UI as 401 without false success', async ({ page }) => {
  await loginThroughRealOAuthCallback(page);
  await page.goto(`/servers/${GUILD_ID}/server/1?tab=settings`);
  await expect(page.getByRole('switch', { name: /Whitelist aktiv/i })).toBeVisible();

  await db.query(
    'UPDATE "Session" SET "isActive" = FALSE WHERE id = (SELECT s.id FROM "Session" s JOIN "User" u ON u.id=s."userId" WHERE u."discordId"=$1 AND s."isActive"=TRUE ORDER BY s."createdAt" DESC LIMIT 1)',
    [DISCORD_ID],
  );
  await page.getByRole('switch', { name: /Whitelist aktiv/i }).click();

  await expect(page.getByTestId('settings-save-error')).toContainText('Session abgelaufen oder widerrufen.');
  await expect(page.getByText('Nicht angemeldet').first()).toBeVisible();
  await expect(page.getByText('Gespeichert')).toHaveCount(0);
  const row = await db.query(
    'SELECT "whitelistActive" FROM "ServerSettings" WHERE "guildId" = $1',
    [GUILD_ID],
  );
  expect(row.rows[0].whitelistActive).toBe(true);
});

test('Stage 30: real authenticated desktop routes render DB-backed state', async ({ page }) => {
  await loginThroughRealOAuthCallback(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const route of [
    { path: '/servers', marker: 'Deine Server' },
    { path: `/servers/${GUILD_ID}`, marker: 'Nitrado-Slots (1/5)' },
    { path: `/servers/${GUILD_ID}/server/1?tab=settings`, marker: 'Server-Toggles' },
  ] as const) {
    await page.goto(route.path);
    await expect(page.getByText(route.marker, { exact: false }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test('Stages 31–35: real DB-backed settings route remains usable at every required width', async ({ page }) => {
  await loginThroughRealOAuthCallback(page);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/servers/${GUILD_ID}/server/1?tab=settings`);
    await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
    await expect(page.getByRole('switch', { name: /Whitelist aktiv/i })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Slot-Funktionen' }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
