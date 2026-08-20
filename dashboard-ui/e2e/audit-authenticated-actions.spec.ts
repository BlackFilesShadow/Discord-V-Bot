import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const OWNER_ID = '437718598876268545';
const TS = '2026-08-20T03:00:00.123Z';
const FIRST_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '11111111-1111-4111-8111-111111111111';
const NEXT_CURSOR = 'v1.eyJ0IjoiMjAyNi0wOC0yMFQwMzowMDowMC4xMjNaIiwiaWQiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIifQ';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface AuditStubOptions {
  owner?: boolean;
  page2Error?: boolean;
}

async function stubAudit(page: Page, options: AuditStubOptions = {}) {
  const owner = options.owner ?? true;
  const auditQueries: string[] = [];
  let categoryReads = 0;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: OWNER_ID, username: owner ? 'audit-owner' : 'audit-delegate', avatar: null, role: 'USER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: OWNER_ID, username: owner ? 'audit-owner' : 'audit-delegate', avatar: null, role: 'USER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const base = `/api/v2/guilds/${GUILD_ID}`;

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `${base}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: owner,
        permissions: owner ? [] : ['dashboard.access'],
        slots: [],
        grantsCount: 0,
      });
    }

    if (path === `${base}/audit/categories`) {
      categoryReads += 1;
      if (!owner) return json(route, { error: 'Nur der Server-Owner darf das.' }, 403);
      return json(route, {
        categories: [
          { category: 'ADMIN', count: 3 },
          { category: 'TICKET', count: 2 },
        ],
      });
    }

    if (path === `${base}/audit`) {
      auditQueries.push(url.search);
      if (!owner) return json(route, { error: 'Nur der Server-Owner darf das.' }, 403);
      if (url.searchParams.get('action') === 'FAIL') {
        return json(route, { error: 'Audit backend unavailable' }, 503);
      }
      if (url.searchParams.get('cursor') === NEXT_CURSOR) {
        if (options.page2Error) return json(route, { error: 'Audit page unavailable' }, 503);
        return json(route, {
          entries: [{
            id: THIRD_ID,
            action: 'ROLE_REVOKED',
            category: 'ADMIN',
            createdAt: '2026-08-20T02:59:59.999Z',
            actor: { discordId: OWNER_ID, username: 'audit-owner' },
            target: null,
            channelId: null,
            details: { token: '[REDACTED]', note: 'page-2' },
          }],
          limit: 2,
          hasMore: false,
          nextCursor: null,
        });
      }

      return json(route, {
        entries: [
          {
            id: FIRST_ID,
            action: 'PERM_GRANTED',
            category: 'ADMIN',
            createdAt: TS,
            actor: { discordId: OWNER_ID, username: 'audit-owner' },
            target: { discordId: '111111111111111111', username: 'alice' },
            channelId: null,
            details: { authorization: '[REDACTED]', safe: 'visible' },
          },
          {
            id: SECOND_ID,
            action: 'PERM_ROLE_GRANTED',
            category: 'ADMIN',
            createdAt: TS,
            actor: { discordId: OWNER_ID, username: 'audit-owner' },
            target: null,
            channelId: null,
            details: ['same timestamp', { password: '[REDACTED]' }],
          },
        ],
        limit: 2,
        hasMore: true,
        nextCursor: NEXT_CURSOR,
      });
    }

    return json(route, {});
  });

  return {
    auditQueries: () => [...auditQueries],
    categoryReads: () => categoryReads,
  };
}

async function openAudit(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  const tab = page.getByRole('button', { name: 'Audit-Log' }).first();
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByRole('heading', { name: 'Audit-Log' })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Audit authenticated Owner contract', () => {
  test('Owner bekommt Kategorien, verlustfreie Cursor-Pagination, Details und applied search', async ({ page }) => {
    const state = await stubAudit(page);
    await openAudit(page);

    await expect(page.getByText('PERM_GRANTED', { exact: true })).toBeVisible();
    await expect(page.getByText('PERM_ROLE_GRANTED', { exact: true })).toBeVisible();
    await expect.poll(state.categoryReads).toBeGreaterThan(0);
    await expect.poll(() => state.auditQueries().length).toBeGreaterThan(0);

    // Gleicher Timestamp auf Seite 1 darf die zweite Zeile nicht verschlucken.
    await page.getByText('PERM_GRANTED', { exact: true }).click();
    await expect(page.getByText(/\[REDACTED\]/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Mehr laden' }).click();
    await expect(page.getByText('ROLE_REVOKED', { exact: true })).toBeVisible();
    await expect.poll(() => state.auditQueries().some(query => new URLSearchParams(query).get('cursor') === NEXT_CURSOR)).toBe(true);

    // Tippen allein darf keinen neuen Request mit einem alten Cursor ausloesen.
    const readsBeforeTyping = state.auditQueries().length;
    await page.getByLabel('Audit-Aktion').fill('TICKET_');
    await page.waitForTimeout(300);
    expect(state.auditQueries().length).toBe(readsBeforeTyping);

    await page.getByRole('button', { name: 'Suchen' }).click();
    await expect.poll(() => state.auditQueries().length).toBeGreaterThan(readsBeforeTyping);
    const searchQuery = new URLSearchParams(state.auditQueries().at(-1));
    expect(searchQuery.get('action')).toBe('TICKET_');
    expect(searchQuery.has('cursor')).toBe(false);

    await page.getByLabel('Audit-Kategorie').selectOption('ADMIN');
    await expect.poll(() => {
      const params = new URLSearchParams(state.auditQueries().at(-1));
      return params.get('category') === 'ADMIN' && !params.has('cursor');
    }).toBe(true);
  });

  test('Backend-Fehler bleibt sichtbar statt einen alten Audit-Stand als Erfolg zu maskieren', async ({ page }) => {
    await stubAudit(page);
    await openAudit(page);

    await page.getByLabel('Audit-Aktion').fill('FAIL');
    await page.getByRole('button', { name: 'Suchen' }).click();
    await expect(page.getByText('Fehler: Audit backend unavailable')).toBeVisible();
  });

  test('Fehler beim Nachladen bleibt sichtbar und vorhandene Seite bleibt erhalten', async ({ page }) => {
    await stubAudit(page, { page2Error: true });
    await openAudit(page);

    await page.getByRole('button', { name: 'Mehr laden' }).click();
    await expect(page.getByText('Fehler beim Nachladen: Audit page unavailable')).toBeVisible();
    await expect(page.getByText('PERM_GRANTED', { exact: true })).toBeVisible();
    await expect(page.getByText('PERM_ROLE_GRANTED', { exact: true })).toBeVisible();
    await expect(page.getByText('ROLE_REVOKED', { exact: true })).toHaveCount(0);
  });

  test('Nicht-Owner mit dashboard.access sieht keinen Audit-Tab und ruft keine Audit-API auf', async ({ page }) => {
    const state = await stubAudit(page, { owner: false });
    await page.goto(`/servers/${GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'CHAOS' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Audit-Log' })).toHaveCount(0);
    expect(state.categoryReads()).toBe(0);
    expect(state.auditQueries()).toEqual([]);
  });
});

for (const width of [320, 360, 375, 390, 430]) {
  test(`Audit Owner-UI bleibt bei ${width}px ohne Seiten-Overflow`, async ({ page }) => {
    await stubAudit(page);
    await page.setViewportSize({ width, height: 900 });
    await openAudit(page);
    await expect(page.getByText('PERM_GRANTED', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}
