import { test, expect, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-test', avatar: null, role: 'DEVELOPER' };
const GUILD_ID = '999999999999999999';
const ADMIN_ID = '888888888888888888';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Write {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | undefined;
}

async function stubCommandCenter(page: Page) {
  const writes: Write[] = [];
  let admins: Array<{ id: string; discordId: string; username: string; role: string }> = [];
  let configItems: unknown[] = [];

  await page.route('**/api/me', route => json(route, { user: DEV_USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: DEV_USER }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = req.postData() ? req.postDataJSON() : undefined;
    const record = (): void => {
      writes.push({ method, path, body, idempotencyKey: req.headers()['x-idempotency-key'] });
    };

    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === '/api/v2/dev/status') {
      await json(route, { active: true, eligible: true, expiresAt: '2026-08-21T18:00:00.000Z' });
      return;
    }
    if (path === '/api/v2/dev/command-center/diagnostics' && method === 'GET') {
      await json(route, { ok: true, database: 'up', cache: 'up' });
      return;
    }
    if (path === '/api/v2/dev/command-center/admins' && method === 'GET') {
      await json(route, { items: admins });
      return;
    }
    if (path === '/api/v2/dev/command-center/admins' && method === 'POST') {
      record();
      admins = [{ id: 'admin-row-1', discordId: ADMIN_ID, username: 'stage26-admin', role: 'ADMIN' }];
      await json(route, { ok: true }, 201);
      return;
    }
    if (path === `/api/v2/dev/command-center/admins/${ADMIN_ID}` && method === 'DELETE') {
      record();
      admins = [];
      await json(route, { ok: true });
      return;
    }

    if (path === '/api/v2/dev/command-center/config' && method === 'GET') {
      await json(route, { allowedKeys: ['FEATURE_FLAG'], items: configItems });
      return;
    }
    if (path === '/api/v2/dev/command-center/config/FEATURE_FLAG' && method === 'PUT') {
      record();
      configItems = [{ key: 'FEATURE_FLAG', value: 'true' }];
      await json(route, { ok: true });
      return;
    }
    if (path === '/api/v2/dev/command-center/config/FEATURE_FLAG' && method === 'DELETE') {
      record();
      configItems = [];
      await json(route, { ok: true });
      return;
    }

    if (path === '/api/v2/dev/command-center/security' && method === 'GET') {
      await json(route, { ipEntries: [], events: [] });
      return;
    }
    if (path === '/api/v2/dev/command-center/security/ip/203.0.113.5' && (method === 'PUT' || method === 'DELETE')) {
      record();
      await json(route, { ok: true });
      return;
    }
    if (path === '/api/v2/dev/command-center/security/events/sec-1/resolve' && method === 'POST') {
      record();
      await json(route, { ok: true });
      return;
    }

    if (path === '/api/v2/guilds' && method === 'GET') {
      await json(route, { guilds: [{ id: GUILD_ID, name: 'Stage 26 Guild', botPresent: true }] });
      return;
    }
    if (path === `/api/v2/dev/command-center/xp/${GUILD_ID}` && method === 'GET') {
      await json(route, {
        config: {
          id: 'xp-1',
          messageXpMin: 10,
          messageXpMax: 20,
          voiceXpPerMinute: 5,
          levelMultiplier: 1.5,
          maxLevel: 100,
          maxLevelRoleId: null,
          allowedRoleIds: [],
          allowedChannelIds: [],
        },
        levelRoles: [],
        roleOptions: [{ id: 'role-1', name: 'Veteran' }],
        channelOptions: [{ id: 'channel-1', name: 'chat', type: 0 }],
      });
      return;
    }
    if (path === `/api/v2/dev/command-center/xp/${GUILD_ID}` && method === 'PATCH') {
      record();
      await json(route, { ok: true });
      return;
    }
    if (path === `/api/v2/dev/command-center/xp/${GUILD_ID}/level-role/25` && (method === 'PUT' || method === 'DELETE')) {
      record();
      await json(route, { ok: true });
      return;
    }

    await json(route, {});
  });

  return { writes: () => [...writes] };
}

async function openCommandCenter(page: Page): Promise<void> {
  await page.goto('/dev/command-center');
  await expect(page.getByRole('heading', { name: 'DEV Command Center', exact: true })).toBeVisible();
}

function expectMutation(write: Write, method: string, path: string): void {
  expect(write.method).toBe(method);
  expect(write.path).toBe(path);
  expect(write.idempotencyKey).toBeTruthy();
  expect(write.idempotencyKey!.length).toBeGreaterThan(8);
}

async function fillReAuth(page: Page): Promise<void> {
  await page.getByPlaceholder('DEV-Passwort oder TOTP').fill('123456');
}

test('Command Center Admin CRUD bleibt exakt gescoped und idempotent', async ({ page }) => {
  const stub = await stubCommandCenter(page);
  await openCommandCenter(page);
  await page.getByRole('button', { name: 'Admins', exact: true }).click();
  await fillReAuth(page);
  await page.getByPlaceholder('Discord-ID').fill(ADMIN_ID);
  await page.getByRole('button', { name: 'ADMIN hinzufügen' }).click();

  await expect(page.getByText('stage26-admin', { exact: true })).toBeVisible();
  await expect.poll(() => stub.writes().length).toBe(1);
  expectMutation(stub.writes()[0], 'POST', '/api/v2/dev/command-center/admins');
  expect(stub.writes()[0].body).toEqual({ discordId: ADMIN_ID, reason: 'Adminverwaltung', reAuth: '123456' });

  await page.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect.poll(() => stub.writes().length).toBe(2);
  expectMutation(stub.writes()[1], 'DELETE', `/api/v2/dev/command-center/admins/${ADMIN_ID}`);
});

test('Command Center Live-Konfiguration deckt Read/Upsert/Delete ab', async ({ page }) => {
  const stub = await stubCommandCenter(page);
  await openCommandCenter(page);
  await page.getByRole('button', { name: 'Konfiguration', exact: true }).click();
  await fillReAuth(page);

  await page.getByRole('combobox').selectOption('FEATURE_FLAG');
  await page.getByPlaceholder('Wert (JSON oder Text)').fill('true');
  await page.getByPlaceholder('Beschreibung optional').fill('Stage 26 CRUD');
  await page.getByRole('button', { name: 'Setzen', exact: true }).click();

  await expect.poll(() => stub.writes().length).toBe(1);
  expectMutation(stub.writes()[0], 'PUT', '/api/v2/dev/command-center/config/FEATURE_FLAG');
  expect(stub.writes()[0].body).toEqual({
    value: 'true',
    description: 'Stage 26 CRUD',
    reason: 'Konfiguration ändern',
    reAuth: '123456',
  });

  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect.poll(() => stub.writes().length).toBe(2);
  expectMutation(stub.writes()[1], 'DELETE', '/api/v2/dev/command-center/config/FEATURE_FLAG');
});

test('Command Center Security CRUD und Resolve bleiben target-gescoped', async ({ page }) => {
  const stub = await stubCommandCenter(page);
  await openCommandCenter(page);
  await page.getByRole('button', { name: 'Security', exact: true }).click();
  await fillReAuth(page);

  await page.getByPlaceholder('IPv4 / IPv6').fill('203.0.113.5');
  await page.getByPlaceholder('Listen-Begründung').fill('Stage 26 test');
  await page.getByRole('button', { name: 'IP setzen' }).click();
  await expect.poll(() => stub.writes().length).toBe(1);
  expectMutation(stub.writes()[0], 'PUT', '/api/v2/dev/command-center/security/ip/203.0.113.5');

  await page.getByRole('button', { name: 'IP entfernen' }).click();
  await expect.poll(() => stub.writes().length).toBe(2);
  expectMutation(stub.writes()[1], 'DELETE', '/api/v2/dev/command-center/security/ip/203.0.113.5');

  await page.getByPlaceholder('SecurityEvent-ID').fill('sec-1');
  await page.getByRole('button', { name: 'Event als gelöst markieren' }).click();
  await expect.poll(() => stub.writes().length).toBe(3);
  expectMutation(stub.writes()[2], 'POST', '/api/v2/dev/command-center/security/events/sec-1/resolve');
});

test('Command Center XP CRUD bleibt Guild+Level-gescoped', async ({ page }) => {
  const stub = await stubCommandCenter(page);
  await openCommandCenter(page);
  await page.getByRole('button', { name: 'XP-Konfiguration', exact: true }).click();

  await page.getByRole('combobox').first().selectOption(GUILD_ID);
  await expect(page.getByPlaceholder('Message XP min')).toHaveValue('10');
  await fillReAuth(page);

  await page.getByPlaceholder('Message XP min').fill('12');
  await page.getByRole('button', { name: 'XP speichern' }).click();
  await expect.poll(() => stub.writes().length).toBe(1);
  expectMutation(stub.writes()[0], 'PATCH', `/api/v2/dev/command-center/xp/${GUILD_ID}`);
  expect(stub.writes()[0].body).toEqual(expect.objectContaining({ messageXpMin: 12, reason: 'XP Konfiguration', reAuth: '123456' }));

  await page.getByPlaceholder('Level', { exact: true }).fill('25');
  const levelRoleSelect = page.locator('select').filter({ has: page.locator('option[value="role-1"]') }).last();
  await levelRoleSelect.selectOption('role-1');
  await page.getByRole('button', { name: 'Level-Rolle setzen' }).click();
  await expect.poll(() => stub.writes().length).toBe(2);
  expectMutation(stub.writes()[1], 'PUT', `/api/v2/dev/command-center/xp/${GUILD_ID}/level-role/25`);

  await page.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await expect.poll(() => stub.writes().length).toBe(3);
  expectMutation(stub.writes()[2], 'DELETE', `/api/v2/dev/command-center/xp/${GUILD_ID}/level-role/25`);
});

const VIEWPORTS = [320, 360, 375, 390, 430] as const;
for (const width of VIEWPORTS) {
  test(`Command Center CRUD bleibt bei ${width}px ohne horizontalen Seiten-Overflow`, async ({ page }) => {
    await stubCommandCenter(page);
    await page.setViewportSize({ width, height: 900 });
    await openCommandCenter(page);
    await page.getByRole('button', { name: 'Konfiguration', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Setzen', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Löschen', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
