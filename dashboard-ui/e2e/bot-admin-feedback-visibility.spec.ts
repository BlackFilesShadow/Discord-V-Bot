import { test, expect, type Page, type Route } from '@playwright/test';

const USER = { discordId: 'bot-admin-feedback-user', username: 'bot-admin-test', avatar: null, role: 'ADMIN' };

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubBotAdmin(page: Page, globalDeveloper: boolean): Promise<void> {
  await page.route('**/api/me', route => json(route, { user: USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: USER }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: true, expiresAt: '2026-09-12T04:00:00.000Z' }));
  await page.route('**/api/v2/dev/status', route => globalDeveloper
    ? json(route, { active: false, eligible: true, expiresAt: null })
    : json(route, { error: 'Keine globale DEV-Berechtigung.', code: 'DEV_IDENTITY_REQUIRED' }, 403));
  await page.route('**/api/v2/bot-admin/guilds', route => json(route, { items: [] }));
  await page.route('**/api/v2/bot-admin/overview', route => json(route, {
    stats: {
      openAppeals: 0,
      newFeedback: 3,
      pendingValidations: 0,
      uploadEnabled: true,
      suspendedUsers: 0,
      deletedPackages: 0,
      criticalWarnings: 0,
    },
    recentBroadcasts: [],
    recentExports: [],
    recentAdminActions: [],
  }));
  await page.route('**/api/v2/bot-admin/command-center/overview', route => json(route, {}));
  await page.route('**/api/v2/bot-admin/command-center/errors?**', route => json(route, {}));
}

test('globaler Developer sieht Feedback in Verwaltung und Command Center', async ({ page }) => {
  await stubBotAdmin(page, true);
  await page.goto('/bot-admin');

  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Neues Feedback/ })).toBeVisible();

  await page.getByRole('button', { name: 'Migrierte Bot-Commands' }).click();
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeVisible();
});

test('normaler BotAdmin sieht keinerlei Feedback-Verwaltung', async ({ page }) => {
  await stubBotAdmin(page, false);
  await page.goto('/bot-admin');

  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Neues Feedback/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Migrierte Bot-Commands' }).click();
  await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toHaveCount(0);
});
