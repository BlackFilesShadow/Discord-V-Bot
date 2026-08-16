import { test, expect, type Page } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const CONN_1 = 'clxknowledgeconn0001';
const CONN_2 = 'clxknowledgeconn0002';

async function stubBotAdmin(page: Page): Promise<void> {
  await page.route('**/api/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ user: { discordId: '437718598876268545', username: 'tester', avatar: null, role: 'DEVELOPER' } }),
  }));
  await page.route('**/api/v2/dev/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ active: false, eligible: true, expiresAt: null }),
  }));
  await page.route('**/api/v2/bot-admin/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ active: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  }));
  await page.route('**/api/v2/bot-admin/guilds', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: GUILD_ID, name: 'Scope Test Guild', memberCount: 42 }] }),
  }));
  await page.route('**/api/v2/bot-admin/knowledge**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/knowledge')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'global-1', label: 'Global Regeln', content: 'Gilt für alle.', createdBy: 'tester', isActive: true,
              createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z', hasEmbedding: true,
              embeddingModel: 'text-embedding', embeddedAt: '2026-08-17T00:00:00.000Z',
              scope: { type: 'GLOBAL', nitradoConnId: null, slot: null, alias: null, alias5: null },
            },
            {
              id: 'server-2', label: 'Livonia Loot', content: 'Nur Slot zwei.', createdBy: 'tester', isActive: true,
              createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z', hasEmbedding: false,
              embeddingModel: null, embeddedAt: null,
              scope: { type: 'GAMESERVER', nitradoConnId: CONN_2, slot: 2, alias: 'Livonia', alias5: 'LIV02' },
            },
          ],
          gameservers: [
            { id: CONN_1, slot: 1, alias: 'Chernarus', alias5: 'CHR01' },
            { id: CONN_2, slot: 2, alias: 'Livonia', alias5: 'LIV02' },
          ],
          persona: null,
          brief: null,
          briefAt: null,
          activeCount: 2,
          maxSnippets: 50,
        }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/knowledge')) {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-1', message: 'ok' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.describe('AI-10 Bot-Admin Knowledge Scope', () => {
  test('zeigt globale und Gameserver-Scopes und sendet die kanonische nitradoConnId', async ({ page }) => {
    await stubBotAdmin(page);
    let createBody: Record<string, unknown> | null = null;
    await page.route('**/api/v2/bot-admin/knowledge?guildId=*', async route => {
      if (route.request().method() === 'POST') {
        createBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-1', message: 'ok' }) });
        return;
      }
      await route.fallback();
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/bot-admin');
    await page.getByRole('button', { name: 'AI-Wissensbank' }).click();
    await page.getByRole('combobox', { name: 'Discord-Server für Wissensbank' }).selectOption(GUILD_ID);

    await expect(page.getByText('Global Regeln')).toBeVisible();
    await expect(page.getByText('Livonia Loot')).toBeVisible();
    await expect(page.getByText('Guild-global', { exact: true })).toBeVisible();
    await expect(page.getByText(/Slot 2.*Livonia/)).toBeVisible();

    const filter = page.getByRole('combobox', { name: 'Knowledge-Scope filtern' });
    await expect(filter.locator('option')).toHaveCount(4);
    await filter.selectOption(CONN_2);
    await expect(page.getByText('Livonia Loot')).toBeVisible();
    await expect(page.getByText('Global Regeln')).toBeHidden();

    await page.getByRole('button', { name: 'Neu', exact: true }).click();
    await page.getByPlaceholder('z. B. Loot-Regeln').fill('Slot Zwei Test');
    await page.getByPlaceholder('Verifizierte Fakten für diesen Scope').fill('Nur für den gewählten Gameserver.');
    await page.getByRole('combobox', { name: 'Knowledge Gameserver Scope' }).selectOption(CONN_2);
    await page.getByRole('button', { name: 'Hinzufügen' }).click();

    await expect.poll(() => createBody).not.toBeNull();
    expect(createBody).toMatchObject({
      label: 'Slot Zwei Test',
      content: 'Nur für den gewählten Gameserver.',
      nitradoConnId: CONN_2,
    });
  });

  test('bleibt bei 360px ohne horizontalen Overflow und Controls bleiben touch-tauglich', async ({ page }) => {
    await stubBotAdmin(page);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/bot-admin');
    await page.getByRole('button', { name: 'AI-Wissensbank' }).click();
    await page.getByRole('combobox', { name: 'Discord-Server für Wissensbank' }).selectOption(GUILD_ID);

    const controls = [
      page.getByRole('button', { name: 'AI-Wissensbank' }),
      page.getByRole('combobox', { name: 'Discord-Server für Wissensbank' }),
      page.getByRole('combobox', { name: 'Knowledge-Scope filtern' }),
      page.getByRole('button', { name: 'Neu', exact: true }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
