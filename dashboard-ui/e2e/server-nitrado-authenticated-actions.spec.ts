import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const TOKEN = 'n'.repeat(40);

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface SlotStub {
  id: string;
  slot: number;
  alias: string;
  alias5: string;
  status: 'ACTIVE';
  nitradoServerId: string | null;
}

interface NitradoStubOptions {
  isOwner?: boolean;
  initialSlots?: SlotStub[];
  tokenPatchStatus?: number;
}

async function stubNitradoDashboard(page: Page, options: NitradoStubOptions = {}) {
  const isOwner = options.isOwner ?? true;
  let slots: SlotStub[] = options.initialSlots ? [...options.initialSlots] : [];
  const writes: Array<{ method: string; path: string; body: unknown; idempotencyKey: string | undefined }> = [];

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'dashboard-e2e', avatar: null, role: 'USER' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'dashboard-e2e', avatar: null, role: 'USER' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') {
      await json(route, { active: false, eligible: false, expiresAt: null });
      return;
    }
    if (path === '/api/v2/bot-admin/status') {
      await json(route, { active: false, expiresAt: null });
      return;
    }
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard` && method === 'GET') {
      await json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner,
        permissions: isOwner ? ['dashboard.access'] : ['dashboard.view'],
        slots,
        grantsCount: 0,
      });
      return;
    }

    const nitradoPrefix = `/api/v2/guilds/${GUILD_ID}/nitrado`;
    if (path.startsWith(nitradoPrefix) && method !== 'GET') {
      writes.push({
        method,
        path,
        body: req.postData() ? req.postDataJSON() : undefined,
        idempotencyKey: req.headers()['x-idempotency-key'],
      });
      if (!isOwner) {
        await json(route, { error: 'Nur der Guild-Owner darf diese Aktion ausführen.' }, 403);
        return;
      }
    }

    if (path === nitradoPrefix && method === 'POST') {
      const body = req.postDataJSON() as { slot: number; alias: string; nitradoServerId?: string };
      const created: SlotStub = {
        id: 'conn-created',
        slot: body.slot,
        alias: body.alias.trim(),
        alias5: 'NEW01',
        status: 'ACTIVE',
        nitradoServerId: body.nitradoServerId ?? null,
      };
      slots = [...slots, created].sort((a, b) => a.slot - b.slot);
      await json(route, created, 201);
      return;
    }

    if (path.match(new RegExp(`^${nitradoPrefix}/\\d+/services$`)) && method === 'GET') {
      await json(route, {
        services: [
          { id: 12345, status: 'ACTIVE', details: { name: 'DayZ Main', game: 'dayz' } },
          { id: 67890, status: 'ACTIVE', details: { name: 'DayZ Event', game: 'dayz' } },
        ],
      });
      return;
    }

    const tokenMatch = path.match(new RegExp(`^${nitradoPrefix}/(\\d+)/token$`));
    if (tokenMatch && method === 'PATCH') {
      if (options.tokenPatchStatus && options.tokenPatchStatus !== 200) {
        await json(route, { error: 'Nitrado-Slot wurde parallel geändert. Bitte neu laden.' }, options.tokenPatchStatus);
        return;
      }
      await json(route, { ok: true, slot: Number(tokenMatch[1]), status: 'ACTIVE', serviceReset: false });
      return;
    }

    const serviceMatch = path.match(new RegExp(`^${nitradoPrefix}/(\\d+)/service$`));
    if (serviceMatch && method === 'PATCH') {
      const body = req.postDataJSON() as { nitradoServerId: string | null };
      slots = slots.map(s => s.slot === Number(serviceMatch[1]) ? { ...s, nitradoServerId: body.nitradoServerId } : s);
      await json(route, { ok: true, slot: Number(serviceMatch[1]), nitradoServerId: body.nitradoServerId });
      return;
    }

    const deleteMatch = path.match(new RegExp(`^${nitradoPrefix}/(\\d+)$`));
    if (deleteMatch && method === 'DELETE') {
      const slot = Number(deleteMatch[1]);
      slots = slots.filter(s => s.slot !== slot);
      await json(route, { ok: true, deletedId: `conn-${slot}` });
      return;
    }

    await json(route, {});
  });

  return {
    writes: () => [...writes],
    slots: () => [...slots],
  };
}

function existingSlot(): SlotStub {
  return {
    id: 'conn-1',
    slot: 1,
    alias: 'Chernarus',
    alias5: 'CH001',
    status: 'ACTIVE',
    nitradoServerId: '12345',
  };
}

async function openNitrado(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await expect(page.getByRole('heading', { name: /Nitrado-Slots/ })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

function expectMutationKey(write: { idempotencyKey: string | undefined }): void {
  expect(write.idempotencyKey).toBeTruthy();
  expect(write.idempotencyKey!.length).toBeGreaterThan(8);
}

test.describe('Nitrado authenticated owner CRUD contract', () => {
  test('Create nutzt exakten Guild-Scope und einen Idempotency-Key', async ({ page }) => {
    const stub = await stubNitradoDashboard(page);
    await openNitrado(page);

    await page.getByRole('button', { name: 'Slot hinzufuegen' }).click();
    await page.getByLabel('Alias (1-40 Zeichen)').fill('  Chernarus  ');
    await page.getByLabel('Nitrado API-Token').fill(TOKEN);
    await page.getByLabel('Nitrado Service-ID (optional)').fill('12345');
    await page.getByRole('button', { name: 'Slot anlegen', exact: true }).click();

    await expect.poll(() => stub.writes().length).toBe(1);
    const [write] = stub.writes();
    expect(write.method).toBe('POST');
    expect(write.path).toBe(`/api/v2/guilds/${GUILD_ID}/nitrado`);
    expect(write.body).toEqual({ slot: 1, alias: '  Chernarus  ', token: TOKEN, nitradoServerId: '12345' });
    expectMutationKey(write);
    await expect(page.getByText('Chernarus', { exact: true })).toBeVisible();
  });

  test('Token-Update bleibt Slot-gescoped und zeigt 409 sichtbar statt Erfolg zu maskieren', async ({ page }) => {
    const stub = await stubNitradoDashboard(page, { initialSlots: [existingSlot()], tokenPatchStatus: 409 });
    await openNitrado(page);

    await page.getByRole('button', { name: 'Token für Slot 1 rotieren' }).click();
    await page.getByPlaceholder('Nitrado API-Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Aktualisieren' }).click();

    await expect.poll(() => stub.writes().length).toBe(1);
    const [write] = stub.writes();
    expect(write.method).toBe('PATCH');
    expect(write.path).toBe(`/api/v2/guilds/${GUILD_ID}/nitrado/1/token`);
    expect(write.body).toEqual({ token: TOKEN });
    expectMutationKey(write);
    await expect(page.getByText('Nitrado-Slot wurde parallel geändert. Bitte neu laden.')).toBeVisible();
  });

  test('Service-Update nutzt exakt Guild+Slot und aktualisiert den sichtbaren Read-State', async ({ page }) => {
    const stub = await stubNitradoDashboard(page, { initialSlots: [existingSlot()] });
    await openNitrado(page);

    await page.getByRole('button', { name: 'Nitrado-Service für Slot 1 verknüpfen' }).click();
    const serviceSelect = page.getByRole('combobox').last();
    await expect(serviceSelect).toBeVisible();
    await serviceSelect.selectOption('67890');
    await page.getByRole('button', { name: 'Speichern' }).click();

    await expect.poll(() => stub.writes().length).toBe(1);
    const [write] = stub.writes();
    expect(write.method).toBe('PATCH');
    expect(write.path).toBe(`/api/v2/guilds/${GUILD_ID}/nitrado/1/service`);
    expect(write.body).toEqual({ nitradoServerId: '67890' });
    expectMutationKey(write);
    await expect(page.getByText('Nitrado-Service: 67890')).toBeVisible();
  });

  test('Delete verlangt Bestätigung, bleibt Slot-gescoped und entfernt den Read-State', async ({ page }) => {
    const stub = await stubNitradoDashboard(page, { initialSlots: [existingSlot()] });
    await openNitrado(page);

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Nitrado-Slot 1 löschen' }).click();

    await expect.poll(() => stub.writes().length).toBe(1);
    const [write] = stub.writes();
    expect(write.method).toBe('DELETE');
    expect(write.path).toBe(`/api/v2/guilds/${GUILD_ID}/nitrado/1`);
    expectMutationKey(write);
    await expect(page.getByText('Noch keine Slots')).toBeVisible();
  });

  test('Nicht-Owner bleibt fail-closed und erreicht keine Mutation', async ({ page }) => {
    const stub = await stubNitradoDashboard(page, { isOwner: false, initialSlots: [existingSlot()] });
    await page.goto(`/servers/${GUILD_ID}`);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Slot hinzufuegen' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nitrado-Slot 1 löschen' })).toHaveCount(0);
    expect(stub.writes()).toHaveLength(0);
  });
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

test.describe('Nitrado CRUD mobile matrix', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}px bleibt vollständig erreichbar und overflow-frei`, async ({ page }) => {
      await stubNitradoDashboard(page, { initialSlots: [existingSlot()] });
      await page.setViewportSize(viewport);
      await openNitrado(page);

      await expect(page.getByRole('button', { name: 'Token für Slot 1 rotieren' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Nitrado-Service für Slot 1 verknüpfen' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Nitrado-Slot 1 löschen' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
