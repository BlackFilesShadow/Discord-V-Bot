import { test, expect } from '@playwright/test';

/**
 * Frontend-Smoke: rendert die Login-Seite (einzige unauthentifizierte Route),
 * verifiziert dass das React-SPA mountet und die Kern-CTA sichtbar ist.
 *
 * Backend-Calls (/auth/status) schlagen ohne echten Bot fehl — das ist OK,
 * der `useAuth`-Hook setzt bei Fehler `user=null, loading=false` und zeigt
 * den Login-Button.
 */

test.describe('Login-Seite (SPA-Smoke)', () => {
  test('mountet React und zeigt Login-CTA', async ({ page }) => {
    // Network-Calls stubben, damit der Auth-Check sofort als "nicht eingeloggt"
    // resolved und nicht in den 30s-Timeout laeuft.
    await page.route('**/auth/status', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/');
    // SPA-Mount: #root wird mit Inhalt befuellt
    await expect(page.locator('#root')).not.toBeEmpty();
    // CTA sichtbar
    await expect(page.getByRole('button', { name: /Discord/i })).toBeVisible();
    // Heading sichtbar (verwendet \u2011 = non-breaking hyphen)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('hat lang-Attribut und dark-mode-Klasse (a11y/Theme-Smoke)', async ({ page }) => {
    await page.route('**/auth/status', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'de');
    await expect(html).toHaveClass(/dark/);
  });

  test('Login-Button triggert OAuth-Redirect zum Bot-Backend', async ({ page }) => {
    await page.route('**/auth/status', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/');
    const cta = page.getByRole('button', { name: /Discord/i });
    await expect(cta).toBeEnabled();
    // Wir registrieren einen Listener auf den naechsten Request und brechen
    // ihn ab, sobald er auf /auth/discord zeigt — so triggern wir keinen
    // echten Discord-OAuth-Roundtrip.
    const requestPromise = page.waitForRequest(
      (req) => req.url().includes('/auth/discord'),
      { timeout: 5_000 },
    );
    await page.route('**/auth/discord', (route) => route.abort());
    await cta.click();
    const req = await requestPromise;
    expect(req.url()).toContain('/auth/discord');
  });
});

test.describe('SPA-Robustheit', () => {
  test('unbekannte Route landet bei /servers Redirect (Protected->Login)', async ({ page }) => {
    await page.route('**/auth/status', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/this-does-not-exist');
    // SPA-Catchall navigiert zu /servers, ProtectedRoute -> /login (Login)
    await expect(page.getByRole('button', { name: /Discord/i })).toBeVisible({ timeout: 10_000 });
  });
});
