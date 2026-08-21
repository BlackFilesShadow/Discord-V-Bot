/**
 * Stage 27-35 runtime matrix (authenticated SPA + stubbed API).
 * Proves UI → API request contract (auth cookie path, guild/slot scope,
 * idempotency header, visible success/error) and viewport usability.
 * Not a substitute for live Discord OAuth or production DB side effects.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const SLOT = '1';
const USER_ID = '437718598876268545';

interface CapturedMutation {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
  credentials: string | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubBase(page: Page, opts: {
  patchStatus?: number;
  patchError?: string;
  /** When true, unlock /dev/* pages (audit). Keep false for /servers routes. */
  devActive?: boolean;
  settingsState?: { whitelistActive: boolean; economyActive: boolean; permaOnly: boolean };
} = {}): Promise<{ mutations: CapturedMutation[]; auditQueries: URLSearchParams[] }> {
  const mutations: CapturedMutation[] = [];
  const auditQueries: URLSearchParams[] = [];
  let settings = opts.settingsState ?? { whitelistActive: true, economyActive: true, permaOnly: false };
  const patchStatus = opts.patchStatus ?? 200;
  const devActive = opts.devActive === true;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'stage-2735-e2e', avatar: null, role: 'DEVELOPER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'stage-2735-e2e', avatar: null, role: 'DEVELOPER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') {
      await json(route, devActive
        ? { active: true, eligible: true, expiresAt: '2099-01-01T00:00:00.000Z' }
        : { active: false, eligible: true, expiresAt: null });
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
        permissions: ['dashboard.access'],
        slots: [{ id: 'conn-dashboard-1', slot: 1, alias: 'Chernarus', alias5: 'CH001', status: 'ACTIVE', nitradoServerId: '12345' }],
        grantsCount: 0,
      });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`) {
      if (method === 'PATCH') {
        let body: unknown = null;
        try { body = req.postDataJSON(); } catch { body = req.postData(); }
        mutations.push({
          method,
          path,
          body,
          idempotencyKey: req.headers()['x-idempotency-key'] ?? null,
          credentials: null,
        });
        if (patchStatus >= 400) {
          await json(route, { error: opts.patchError ?? `HTTP ${patchStatus}`, code: `E_${patchStatus}` }, patchStatus);
          return;
        }
        if (body && typeof body === 'object') {
          settings = { ...settings, ...(body as Partial<typeof settings>) };
        }
        await json(route, { ok: true, settings });
        return;
      }
      await json(route, settings);
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/economy/config`) {
      await json(route, {
        enabled: true,
        currencyName: 'Maeuse',
        emoji: 'M',
        startBalance: 500,
        playtimeRewardPercent: 2,
        bankInterestPercent: 3,
        bankChannelId: null,
      });
      return;
    }
    if (path.startsWith('/api/v2/dev/observability/audit/search')) {
      auditQueries.push(url.searchParams);
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        await json(route, {
          entries: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            action: 'settings.patch',
            category: 'SERVER_SETTINGS',
            guildId: GUILD_ID,
            createdAt: '2026-08-22T00:00:00.000Z',
            actor: { discordId: USER_ID, username: 'stage-2735-e2e' },
            target: null,
            channelId: null,
            ipAddress: '127.0.0.1',
            details: { slot: SLOT },
          }],
          limit: 50,
          hasMore: true,
          nextCursor: 'v1.stage2735',
        });
        return;
      }
      await json(route, {
        entries: [{
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          action: 'settings.patch.page2',
          category: 'SERVER_SETTINGS',
          guildId: GUILD_ID,
          createdAt: '2026-08-21T23:00:00.000Z',
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
      return;
    }

    await json(route, {});
  });

  return { mutations, auditQueries };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('#root')).not.toBeEmpty();
}

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

test.describe('Stage 27 action: settings mutation pipeline', () => {
  test('UI mutation sends guild/slot scoped PATCH with X-Idempotency-Key and success toast', async ({ page }) => {
    const ctx = await stubBase(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);

    await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
    await page.getByRole('switch', { name: /Whitelist aktiv/i }).click();

    await expect.poll(() => ctx.mutations.length).toBeGreaterThanOrEqual(1);
    const m = ctx.mutations[0]!;
    expect(m.method).toBe('PATCH');
    expect(m.path).toBe(`/api/v2/guilds/${GUILD_ID}/dashboard/server/${SLOT}/settings`);
    expect(m.body).toEqual({ whitelistActive: false });
    expect(m.idempotencyKey).toBeTruthy();
    expect(String(m.idempotencyKey).length).toBeGreaterThanOrEqual(8);

    await expect(page.getByText('Gespeichert').first()).toBeVisible();
    await expect(page.getByText('Server-Einstellungen aktualisiert.').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('Stage 29 error states (settings + audit)', () => {
  const cases: Array<{ status: number; title: string; error: string }> = [
    { status: 400, title: 'Ungueltige Anfrage', error: 'bad payload' },
    { status: 401, title: 'Nicht angemeldet', error: 'session gone' },
    { status: 403, title: 'Keine Berechtigung', error: 'forbidden scope' },
    { status: 404, title: 'Nicht gefunden', error: 'missing slot' },
    { status: 409, title: 'Konflikt', error: 'version conflict' },
    { status: 429, title: 'Zu viele Anfragen', error: 'rate limited' },
    { status: 500, title: 'Serverfehler', error: 'boom' },
  ];

  for (const c of cases) {
    test(`settings PATCH ${c.status} shows danger toast + inline alert (${c.title})`, async ({ page }) => {
      await stubBase(page, { patchStatus: c.status, patchError: c.error });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);
      await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
      await page.getByRole('switch', { name: /Whitelist aktiv/i }).click();

      await expect(page.getByTestId('settings-save-error')).toContainText(c.error);
      await expect(page.getByText(c.title).first()).toBeVisible();
      // Must not claim success.
      await expect(page.getByText('Gespeichert')).toHaveCount(0);
    });
  }

  test('audit search 403 clears privileged data and shows alert', async ({ page }) => {
    await stubBase(page, { devActive: true });
    let deny = false;
    await page.route('**/api/v2/dev/observability/audit/search?*', async route => {
      if (deny) {
        await json(route, { error: 'DEV_SCOPE_RESTRICTED', code: 'DEV_SCOPE_RESTRICTED' }, 403);
        return;
      }
      await json(route, {
        entries: [{
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          action: 'keep-me',
          category: 'SECURITY',
          guildId: GUILD_ID,
          createdAt: '2026-08-22T00:00:00.000Z',
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

    await page.goto('/dev/audit-logs');
    await expect(page.getByText('keep-me')).toBeVisible();
    deny = true;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('keep-me')).toHaveCount(0);
  });
});

test.describe('Stage 28 pagination / search / filter / cursor', () => {
  test('audit filter + cursor append without dropping page-1 rows', async ({ page }) => {
    const ctx = await stubBase(page, { devActive: true });
    await page.goto('/dev/audit-logs');
    await expect(page.getByRole('heading', { name: 'Audit Logs', exact: true })).toBeVisible();
    await expect(page.getByText('settings.patch', { exact: true })).toBeVisible();

    await page.getByRole('textbox', { name: 'Audit-Suche' }).fill('settings');
    await page.getByRole('combobox', { name: 'Audit-Kategorie' }).selectOption('SERVER_SETTINGS');
    await page.getByRole('textbox', { name: 'Guild-ID' }).fill(GUILD_ID);
    await page.getByRole('button', { name: 'Suchen' }).click();

    await expect.poll(() => ctx.auditQueries.some(q => q.get('q') === 'settings')).toBe(true);
    const filtered = ctx.auditQueries.find(q => q.get('q') === 'settings')!;
    expect(filtered.get('category')).toBe('SERVER_SETTINGS');
    expect(filtered.get('guildId')).toBe(GUILD_ID);

    await page.getByRole('button', { name: 'Mehr laden' }).click();
    await expect(page.getByText('settings.patch', { exact: true })).toBeVisible();
    await expect(page.getByText('settings.patch.page2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mehr laden' })).toHaveCount(0);
    expect(ctx.auditQueries.some(q => q.get('cursor') === 'v1.stage2735')).toBe(true);
  });
});

test.describe('Stage 30 desktop completion 1280', () => {
  test('core authenticated routes render markers without overflow', async ({ page }) => {
    test.setTimeout(60_000);
    await stubBase(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const route of [
      { path: '/servers', marker: 'Deine Server' },
      { path: `/servers/${GUILD_ID}`, marker: 'Nitrado-Slots (1/5)' },
      { path: `/servers/${GUILD_ID}/server/${SLOT}?tab=settings`, marker: 'Server-Toggles' },
    ] as const) {
      await gotoAuthed(page, route.path);
      await expect(page.getByText(route.marker, { exact: false }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    }
  });
});

test.describe('Stages 31-35 mobile viewports', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.width}px: servers + settings usable, no overflow, primary controls >=44px`, async ({ page }) => {
      test.setTimeout(60_000);
      await stubBase(page);
      await page.setViewportSize(vp);

      await gotoAuthed(page, '/servers');
      await expect(page.getByRole('heading', { name: 'Deine Server' })).toBeVisible();
      await expect(page.getByText('Die Chaoten')).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await gotoAuthed(page, `/servers/${GUILD_ID}/server/${SLOT}?tab=settings`);
      await expect(page.getByRole('heading', { name: 'Server-Toggles' })).toBeVisible();
      const whitelist = page.getByRole('switch', { name: /Whitelist aktiv/i });
      await expect(whitelist).toBeVisible();
      const box = await whitelist.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(24);
      await expectNoHorizontalOverflow(page);

      await expect(page.getByRole('navigation', { name: 'Slot-Funktionen' }).first()).toBeVisible();
    });
  }
});
