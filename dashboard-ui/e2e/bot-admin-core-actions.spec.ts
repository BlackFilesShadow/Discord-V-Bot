import { test, expect, type Page, type Route } from '@playwright/test';

const USER = { discordId: '437718598876268545', username: 'bot-admin-test', avatar: null, role: 'DEVELOPER' };
const APPEAL_ID = 'appeal-1';
const FEEDBACK_ID = 'feedback-1';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubBase(page: Page): Promise<void> {
  await page.route('**/api/me', route => json(route, { user: USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: USER }));
  await page.route('**/api/v2/dev/status', route => json(route, { active: false, eligible: true, expiresAt: null }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: true, expiresAt: '2026-08-20T12:00:00.000Z' }));
  await page.route('**/api/v2/bot-admin/guilds', route => json(route, { items: [] }));
  await page.route('**/api/v2/bot-admin/overview', route => json(route, {
    stats: { openAppeals: 1, newFeedback: 1, pendingValidations: 0, uploadEnabled: true, suspendedUsers: 0, deletedPackages: 0, criticalWarnings: 0 },
    recentBroadcasts: [], recentExports: [], recentAdminActions: [],
  }));
}

test('eine alte Statusantwort kann eine frisch bestätigte Bot-Admin-Session nicht überschreiben', async ({ page }) => {
  let sessionActive = false;
  let holdNextStatus = false;
  let staleStatusRoute: Route | undefined;

  await page.route('**/api/me', route => json(route, { user: USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: USER }));
  await page.route('**/api/v2/dev/status', route => json(route, { active: false, eligible: true, expiresAt: null }));
  await page.route('**/api/v2/bot-admin/status', async route => {
    if (holdNextStatus) {
      holdNextStatus = false;
      staleStatusRoute = route;
      return;
    }
    await json(route, sessionActive
      ? { active: true, expiresAt: '2026-08-20T12:00:00.000Z' }
      : { active: false, expiresAt: null });
  });
  await page.route('**/api/v2/bot-admin/login', async route => {
    expect(route.request().postDataJSON()).toEqual({ password: 'richtiges-passwort' });
    sessionActive = true;
    await json(route, { ok: true, expiresAt: '2026-08-20T12:00:00.000Z' });
  });
  await page.route('**/api/v2/bot-admin/guilds', route => json(route, { items: [] }));
  await page.route('**/api/v2/bot-admin/overview', route => json(route, {
    stats: { openAppeals: 0, newFeedback: 0, pendingValidations: 0, uploadEnabled: true, suspendedUsers: 0, deletedPackages: 0, criticalWarnings: 0 },
    recentBroadcasts: [], recentExports: [], recentAdminActions: [],
  }));

  await page.goto('/bot-admin');
  await expect(page.getByLabel('Bot-Admin Passwort')).toBeVisible();

  // Ein Focus-Refresh startet noch vor dem Login und liefert erst danach den
  // alten inaktiven Status. Genau dieser Ablauf trat im Dashboard real auf.
  holdNextStatus = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => Boolean(staleStatusRoute)).toBe(true);

  await page.getByLabel('Bot-Admin Passwort').fill('richtiges-passwort');
  await page.getByRole('button', { name: 'Bot-Admin entsperren' }).click();
  await expect(page.getByTestId('botadmin-login-panel').locator('[data-state="ok"]')).toBeVisible();

  await staleStatusRoute!.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ active: false, expiresAt: null }),
  });

  // Die verzögerte Antwort wurde verarbeitet; der Sessionindikator muss auch
  // danach aktiv bleiben. Die eigentliche Seiten-Navigation hat auf Mobile
  // ein eigenes, bewusst reduziertes Layout und ist nicht Teil dieses Vertrags.
  await page.waitForTimeout(250);
  await expect(page.getByTestId('botadmin-login-panel').locator('[data-state="ok"]')).toBeVisible();
});

test('Appeal-Entscheidung sendet den exakten Intent und schließt erst nach Erfolg', async ({ page }) => {
  await stubBase(page);
  let body: unknown = null;
  await page.route('**/api/v2/bot-admin/appeals?status=PENDING', route => json(route, {
    items: [{
      id: APPEAL_ID, reason: 'Bitte prüfen', status: 'PENDING', reviewNote: null,
      createdAt: '2026-08-20T10:00:00.000Z', user: { username: 'Player', discordId: '1' },
      case: { reason: 'Testfall', action: 'WARN' },
    }], total: 1,
  }));
  await page.route(`**/api/v2/bot-admin/appeals/${APPEAL_ID}/decision`, async route => {
    body = route.request().postDataJSON();
    await json(route, { ok: true });
  });

  await page.goto('/bot-admin');
  await page.getByRole('button', { name: 'Appeals', exact: true }).click();
  await page.getByRole('button', { name: 'Entscheiden' }).click();
  await page.getByRole('combobox').last().selectOption('DENIED');
  await page.getByPlaceholder('Notiz (optional)').fill('Begründet abgelehnt');
  await page.getByRole('button', { name: 'Bestätigen' }).click();

  await expect.poll(() => body).toEqual({ decision: 'DENIED', note: 'Begründet abgelehnt' });
  await expect(page.getByRole('button', { name: 'Bestätigen' })).toHaveCount(0);
});

test('Appeal-Backendfehler bleibt sichtbar und schließt den Entscheidungsdialog nicht', async ({ page }) => {
  await stubBase(page);
  await page.route('**/api/v2/bot-admin/appeals?status=PENDING', route => json(route, {
    items: [{
      id: APPEAL_ID, reason: 'Bitte prüfen', status: 'PENDING', reviewNote: null,
      createdAt: '2026-08-20T10:00:00.000Z', user: { username: 'Player', discordId: '1' },
      case: { reason: null, action: null },
    }], total: 1,
  }));
  await page.route(`**/api/v2/bot-admin/appeals/${APPEAL_ID}/decision`, route => json(route, { error: 'Conflict' }, 409));

  await page.goto('/bot-admin');
  await page.getByRole('button', { name: 'Appeals', exact: true }).click();
  await page.getByRole('button', { name: 'Entscheiden' }).click();
  await page.getByRole('button', { name: 'Bestätigen' }).click();

  await expect(page.getByRole('button', { name: 'Bestätigen' })).toBeVisible();
});

test('Feedback-Update sendet Status und Admin-Notiz exakt', async ({ page }) => {
  await stubBase(page);
  let body: unknown = null;
  await page.route('**/api/v2/bot-admin/feedback?status=OPEN', route => json(route, {
    items: [{ id: FEEDBACK_ID, category: 'BUG', subject: 'Problem', message: 'Details', status: 'OPEN', username: 'Player', adminNote: null, createdAt: '2026-08-20T10:00:00.000Z' }],
  }));
  await page.route(`**/api/v2/bot-admin/feedback/${FEEDBACK_ID}`, async route => {
    expect(route.request().method()).toBe('PATCH');
    body = route.request().postDataJSON();
    await json(route, { ok: true });
  });

  await page.goto('/bot-admin');
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await page.getByRole('button', { name: 'Bearbeiten' }).click();
  await page.getByRole('combobox').last().selectOption('RESOLVED');
  await page.getByPlaceholder('Admin-Notiz').fill('Behoben');
  await page.getByRole('button', { name: 'Speichern' }).click();

  await expect.poll(() => body).toEqual({ status: 'RESOLVED', adminNote: 'Behoben' });
});

test('Broadcast trennt Probelauf und bestätigten Versand sauber', async ({ page }) => {
  await stubBase(page);
  const bodies: unknown[] = [];
  await page.route('**/api/v2/bot-admin/broadcast', async route => {
    if (route.request().method() === 'GET') return json(route, { recent: [] });
    const requestBody = route.request().postDataJSON();
    bodies.push(requestBody);
    return json(route, requestBody.dryRun ? { recipients: 4, dryRun: true } : { recipients: 4, sent: 4, failed: 0, dryRun: false });
  });

  await page.goto('/bot-admin');
  await page.getByRole('button', { name: 'Broadcast' }).click();
  await page.getByPlaceholder('Nachricht (max. 1900 Zeichen)').fill('Testnachricht');
  await page.getByRole('button', { name: 'Probelauf' }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ target: 'MANUFACTURER', message: 'Testnachricht', dryRun: true });

  await page.getByRole('button', { name: 'Senden' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Senden' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual({ target: 'MANUFACTURER', message: 'Testnachricht', dryRun: false });
});

test('Upload-Schalter sendet nur den inversen aktuellen Zustand', async ({ page }) => {
  await stubBase(page);
  let body: unknown = null;
  await page.route('**/api/v2/bot-admin/upload', route => json(route, { enabled: true, maxSize: 10485760, allowedTypes: ['xml', 'json'] }));
  await page.route('**/api/v2/bot-admin/upload/toggle', async route => {
    body = route.request().postDataJSON();
    await json(route, { ok: true });
  });

  await page.goto('/bot-admin');
  await page.getByRole('button', { name: 'Upload-Steuerung' }).click();
  await page.getByRole('button', { name: 'Uploads deaktivieren' }).click();
  await expect.poll(() => body).toEqual({ enable: false });
});
