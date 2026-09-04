import { test, expect, type Page } from '@playwright/test';

async function unauthenticated(page: Page) {
  await page.route('**/api/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Nicht angemeldet.' }) }));
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('Datenschutz und Nutzungsbedingungen sind ohne Login direkt erreichbar', async ({ page }) => {
  await unauthenticated(page);

  await page.goto('/legal/privacy');
  await expect(page).toHaveURL(/\/legal\/privacy$/);
  await expect(page.getByRole('heading', { name: 'Datenschutzerklärung', exact: true })).toBeVisible();
  await expect(page.getByText(/identify/)).toBeVisible();
  await expect(page.getByText(/Löschung/).first()).toBeVisible();

  await page.goto('/legal/terms');
  await expect(page).toHaveURL(/\/legal\/terms$/);
  await expect(page.getByRole('heading', { name: 'Nutzungsbedingungen', exact: true })).toBeVisible();
  await expect(page.getByText(/virtuelle Konten/i).first()).toBeVisible();
});

test('Login zeigt vor Discord OAuth keine zusaetzlichen Rechtstexte', async ({ page }) => {
  await unauthenticated(page);
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Datenschutz' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Nutzungsbedingungen' })).toHaveCount(0);
  await expect(page.getByText(/identify, guilds und email/)).toHaveCount(0);
});

for (const width of [320, 360, 375, 390, 430] as const) {
  test(`${width}px Legal-Seiten bleiben ohne horizontalen Overflow`, async ({ page }) => {
    await unauthenticated(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/legal/privacy');
    await expect(page.getByRole('heading', { name: 'Datenschutzerklärung', exact: true })).toBeVisible();
    await expectNoOverflow(page);
    await page.goto('/legal/terms');
    await expect(page.getByRole('heading', { name: 'Nutzungsbedingungen', exact: true })).toBeVisible();
    await expectNoOverflow(page);
  });
}
