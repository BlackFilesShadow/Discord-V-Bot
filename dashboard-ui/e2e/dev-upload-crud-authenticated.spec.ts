import { test, expect, type Page, type Route } from '@playwright/test';

const DEV_USER = { discordId: '123456789012345678', username: 'dev-test', avatar: null, role: 'DEVELOPER' };
const UPLOAD_ID = 'up-stage26-xml';

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Write {
  method: string;
  path: string;
  idempotencyKey: string | undefined;
  body?: unknown;
}

async function stubDevUpload(page: Page, initialUpload = false) {
  let exists = initialUpload;
  const writes: Write[] = [];
  const record = {
    id: UPLOAD_ID,
    userDiscordId: DEV_USER.discordId,
    kind: 'XML',
    originalName: 'types.xml',
    storedPath: '/tmp/redacted/types.xml',
    mimeType: 'application/xml',
    sizeBytes: 42,
    sha256: 'a'.repeat(64),
    createdAt: '2026-08-21T10:00:00.000Z',
    expiresAt: '2026-08-22T10:00:00.000Z',
  };

  await page.route('**/api/me', route => json(route, { user: DEV_USER }));
  await page.route('**/auth/status', route => json(route, { authenticated: true, user: DEV_USER }));
  await page.route('**/api/v2/bot-admin/status', route => json(route, { active: false, expiresAt: null }));
  await page.route('**/api/v2/dev/status', route => json(route, {
    active: true,
    eligible: true,
    expiresAt: '2026-08-21T18:00:00.000Z',
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/uploads' && method === 'GET') {
      await json(route, { uploads: exists ? [record] : [] });
      return;
    }
    if (path === '/api/v2/dev/uploads' && method === 'POST') {
      writes.push({ method, path, idempotencyKey: req.headers()['x-idempotency-key'] });
      exists = true;
      await json(route, { results: [{ ok: true, name: 'types.xml', id: UPLOAD_ID }] }, 201);
      return;
    }
    if (path === `/api/v2/dev/uploads/${UPLOAD_ID}` && method === 'DELETE') {
      writes.push({ method, path, idempotencyKey: req.headers()['x-idempotency-key'] });
      exists = false;
      await json(route, { ok: true });
      return;
    }
    if (path === '/api/v2/dev/analytics/validate/xml' && method === 'POST') {
      writes.push({
        method,
        path,
        idempotencyKey: req.headers()['x-idempotency-key'],
        body: req.postDataJSON(),
      });
      await json(route, {
        ok: true,
        type: 'xml',
        fileName: 'types.xml',
        sizeBytes: 42,
        sha256: 'a'.repeat(64),
        lineCount: 1,
        durationMs: 3,
        issues: [],
        summary: { errors: 0, warnings: 0, info: 0, suggestions: 0 },
      });
      return;
    }

    await json(route, {});
  });

  return { writes: () => [...writes], exists: () => exists };
}

async function openUploadMode(page: Page): Promise<void> {
  await page.goto('/dev/xml-validator');
  await expect(page.getByText('XML Validator', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Upload waehlen' }).click();
  await expect(page.getByText('XML-Upload', { exact: true })).toBeVisible();
}

function expectKey(write: Write): void {
  expect(write.idempotencyKey).toBeTruthy();
  expect(write.idempotencyKey!.length).toBeGreaterThan(8);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('DEV Upload CRUD: Create -> Read reload -> Auto-Select -> Analyse -> Delete', async ({ page }) => {
  const stub = await stubDevUpload(page);
  await openUploadMode(page);

  const validate = page.getByRole('button', { name: 'Validieren' });
  await expect(validate).toBeDisabled();

  await page.locator('input[type="file"]').setInputFiles({
    name: 'types.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from('<types><type name="Apple"/></types>'),
  });

  await expect(page.getByText('✓ types.xml')).toBeVisible();
  await expect(page.getByText('types.xml', { exact: true })).toBeVisible();
  await expect(validate).toBeEnabled();

  await validate.click();
  await expect(page.getByText('Gueltig', { exact: true })).toBeVisible();

  const afterAnalysis = stub.writes();
  expect(afterAnalysis).toHaveLength(2);
  expect(afterAnalysis[0].method).toBe('POST');
  expect(afterAnalysis[0].path).toBe('/api/v2/dev/uploads');
  expectKey(afterAnalysis[0]);
  expect(afterAnalysis[1].path).toBe('/api/v2/dev/analytics/validate/xml');
  expect(afterAnalysis[1].body).toEqual({ uploadId: UPLOAD_ID });
  expectKey(afterAnalysis[1]);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Loeschen' }).click();

  await expect.poll(() => stub.exists()).toBe(false);
  await expect(page.getByText('Noch keine Uploads.')).toBeVisible();
  await expect(validate).toBeDisabled();

  const writes = stub.writes();
  expect(writes).toHaveLength(3);
  expect(writes[2].method).toBe('DELETE');
  expect(writes[2].path).toBe(`/api/v2/dev/uploads/${UPLOAD_ID}`);
  expectKey(writes[2]);
});

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`DEV Upload CRUD bleibt bei ${viewport.width}px erreichbar und overflow-frei`, async ({ page }) => {
    await stubDevUpload(page, true);
    await page.setViewportSize(viewport);
    await openUploadMode(page);

    await expect(page.getByText('types.xml', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Loeschen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Validieren' })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
  });
}
