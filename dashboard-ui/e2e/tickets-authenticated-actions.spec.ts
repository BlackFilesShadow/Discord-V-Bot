import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const POST_CHANNEL = '123456789012345679';
const TRANSCRIPT_CHANNEL = '123456789012345680';
const ARCHIVE_CHANNEL = '123456789012345681';
const CATEGORY_ID = '123456789012345682';
const STAFF_ROLE = '123456789012345683';

interface TicketTemplate {
  id: string;
  slot: number;
  label: string;
  buttonLabel: string | null;
  welcomeText: string;
  welcomeMessages: string[];
  embedTitle: string;
  embedDescription: string | null;
  embedColor: string;
  postChannelId: string;
  postedMessageId: string | null;
  categoryId: string | null;
  staffRoleId: string | null;
  managerRoleIds: string[];
  mentionRoleIds: string[];
  transcriptChannelId: string;
  archiveChannelId: string | null;
  isActive: boolean;
  ticketCounter: number;
}

interface SeenMutation {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function initialTemplate(): TicketTemplate {
  return {
    id: 'ticket-1',
    slot: 1,
    label: 'Support',
    buttonLabel: 'Ticket öffnen',
    welcomeText: 'Hallo! Ein Team-Mitglied meldet sich gleich.',
    welcomeMessages: ['Hallo! Ein Team-Mitglied meldet sich gleich.'],
    embedTitle: 'Support-Ticket öffnen',
    embedDescription: 'Du brauchst Hilfe?',
    embedColor: '#dc2626',
    postChannelId: POST_CHANNEL,
    postedMessageId: '123456789012345699',
    categoryId: CATEGORY_ID,
    staffRoleId: STAFF_ROLE,
    managerRoleIds: [STAFF_ROLE],
    mentionRoleIds: [STAFF_ROLE],
    transcriptChannelId: TRANSCRIPT_CHANNEL,
    archiveChannelId: ARCHIVE_CHANNEL,
    isActive: true,
    ticketCounter: 12,
  };
}

async function stubTickets(
  page: Page,
  permissions: string[],
  options: { getForbidden?: boolean; failEditWith409?: boolean } = {},
) {
  let templates: TicketTemplate[] = [initialTemplate()];
  const mutations: SeenMutation[] = [];
  const lookups: string[] = [];
  let ticketGets = 0;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: 'ticket-user', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: 'ticket-user', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });
    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: false,
        permissions,
        slots: [],
        grantsCount: 1,
      });
    }

    const base = `/api/v2/guilds/${GUILD_ID}`;
    if (path === `${base}/tickets` && method === 'GET') {
      ticketGets += 1;
      if (options.getForbidden) return json(route, { error: 'Permission fehlt: tickets.manage' }, 403);
      return json(route, { templates, max: 5 });
    }
    if (path === `${base}/channels` && method === 'GET') {
      lookups.push(path);
      return json(route, {
        channels: [
          { id: POST_CHANNEL, name: 'ticket-post', type: 0, parentId: null },
          { id: TRANSCRIPT_CHANNEL, name: 'ticket-transcript', type: 0, parentId: null },
          { id: ARCHIVE_CHANNEL, name: 'ticket-archiv', type: 0, parentId: null },
          { id: CATEGORY_ID, name: 'Tickets', type: 4, parentId: null },
        ],
      });
    }
    if (path === `${base}/roles` && method === 'GET') {
      lookups.push(path);
      return json(route, { roles: [{ id: STAFF_ROLE, name: 'Support-Team', color: '#ffffff', position: 5, managed: false }] });
    }

    const parseBody = (): Record<string, unknown> | null => {
      if (!req.postData()) return null;
      try { return req.postDataJSON() as Record<string, unknown>; } catch { return null; }
    };

    if (path === `${base}/tickets` && method === 'POST') {
      const body = parseBody() ?? {};
      mutations.push({ method, path, body });
      const created: TicketTemplate = {
        id: 'ticket-2',
        slot: Number(body.slot ?? 2),
        label: String(body.label ?? 'Neu'),
        buttonLabel: typeof body.buttonLabel === 'string' ? body.buttonLabel : null,
        welcomeText: String(body.welcomeText ?? ''),
        welcomeMessages: Array.isArray(body.welcomeMessages) ? body.welcomeMessages.map(String) : [String(body.welcomeText ?? '')],
        embedTitle: String(body.embedTitle ?? ''),
        embedDescription: typeof body.embedDescription === 'string' ? body.embedDescription : null,
        embedColor: String(body.embedColor ?? '#dc2626'),
        postChannelId: String(body.postChannelId ?? POST_CHANNEL),
        postedMessageId: null,
        categoryId: typeof body.categoryId === 'string' ? body.categoryId : null,
        staffRoleId: typeof body.staffRoleId === 'string' ? body.staffRoleId : null,
        managerRoleIds: Array.isArray(body.managerRoleIds) ? body.managerRoleIds.map(String) : [],
        mentionRoleIds: Array.isArray(body.mentionRoleIds) ? body.mentionRoleIds.map(String) : [],
        transcriptChannelId: String(body.transcriptChannelId ?? TRANSCRIPT_CHANNEL),
        archiveChannelId: typeof body.archiveChannelId === 'string' ? body.archiveChannelId : null,
        isActive: true,
        ticketCounter: 0,
      };
      templates = [...templates, created];
      return json(route, created, 201);
    }

    const itemMatch = path.match(new RegExp(`^${base}/tickets/([^/]+)$`));
    if (itemMatch && method === 'PUT') {
      const body = parseBody() ?? {};
      mutations.push({ method, path, body });
      if (options.failEditWith409 && itemMatch[1] === 'ticket-1' && Object.prototype.hasOwnProperty.call(body, 'label')) {
        return json(route, { error: 'Slot bereits belegt.' }, 409);
      }
      const index = templates.findIndex(t => t.id === itemMatch[1]);
      if (index < 0) return json(route, { error: 'Template nicht gefunden.' }, 404);
      templates[index] = { ...templates[index], ...body } as TicketTemplate;
      return json(route, templates[index]);
    }
    if (itemMatch && method === 'DELETE') {
      const body = parseBody();
      mutations.push({ method, path, body });
      templates = templates.filter(t => t.id !== itemMatch[1]);
      return json(route, { ok: true });
    }
    if (path === `${base}/tickets/ticket-1/post` && method === 'POST') {
      mutations.push({ method, path, body: parseBody() });
      return json(route, { ok: true, messageId: '123456789012345699' });
    }
    if (path === `${base}/tickets/ticket-1/reset-counter` && method === 'POST') {
      mutations.push({ method, path, body: parseBody() });
      templates = templates.map(t => t.id === 'ticket-1' ? { ...t, ticketCounter: 0 } : t);
      return json(route, { ok: true });
    }

    if (method !== 'GET') {
      mutations.push({ method, path, body: parseBody() });
      return json(route, { ok: true });
    }
    return json(route, {});
  });

  return {
    mutations,
    lookups,
    get ticketGets() { return ticketGets; },
  };
}

async function openTickets(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Tickets', exact: true }).click();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Ticket templates authenticated action contract', () => {
  test('ohne tickets.manage bleibt die Oberfläche fail-closed', async ({ page }) => {
    const state = await stubTickets(page, ['feeds.view']);
    await openTickets(page);

    await expect(page.getByRole('heading', { name: 'Nicht erlaubt' })).toBeVisible();
    await expect(page.getByText(/tickets\.manage/)).toBeVisible();
    expect(state.lookups).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('Backend-403 wird für einen vermeintlichen Manager sichtbar statt verschluckt', async ({ page }) => {
    await stubTickets(page, ['tickets.manage'], { getForbidden: true });
    await openTickets(page);

    await expect(page.getByText('Fehler beim Laden.')).toBeVisible();
    await expect(page.getByText(/Permission fehlt: tickets\.manage/)).toBeVisible();
  });

  test('tickets.manage lädt Templates sowie Channel-/Rollen-Lookups im exakten Guild-Scope', async ({ page }) => {
    const state = await stubTickets(page, ['tickets.manage']);
    await openTickets(page);

    await expect(page.getByRole('heading', { name: /Ticket-Templates \(1\/5\)/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible();
    await expect(page.getByText(/ticket-post/)).toBeVisible();
    await expect(page.getByText(/ticket-transcript/)).toBeVisible();
    await expect.poll(() => state.lookups).toEqual(expect.arrayContaining([
      `/api/v2/guilds/${GUILD_ID}/channels`,
      `/api/v2/guilds/${GUILD_ID}/roles`,
    ]));
    expect(state.mutations).toEqual([]);
  });

  test('Post/Toggle/Counter-Reset/Delete treffen ausschließlich das gewählte Guild-Template', async ({ page }) => {
    const state = await stubTickets(page, ['tickets.manage']);
    page.on('dialog', dialog => void dialog.accept());
    await openTickets(page);

    await page.getByRole('button', { name: 'Posten', exact: true }).click();
    await expect.poll(() => state.mutations.some(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets/ticket-1/post`)).toBe(true);

    await page.getByRole('button', { name: 'Template deaktivieren' }).click();
    await expect.poll(() => state.mutations.some(m => m.method === 'PUT' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets/ticket-1` && m.body?.isActive === false)).toBe(true);

    await page.getByRole('button', { name: 'Ticket-Nummer zuruecksetzen' }).click();
    await expect.poll(() => state.mutations.some(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets/ticket-1/reset-counter`)).toBe(true);

    await page.getByRole('button', { name: 'Template loeschen' }).click();
    await expect.poll(() => state.mutations.some(m => m.method === 'DELETE' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets/ticket-1`)).toBe(true);

    for (const mutation of state.mutations) {
      expect(mutation.path).toContain(`/api/v2/guilds/${GUILD_ID}/tickets`);
    }
  });

  test('bestehendes Template wird mit dem vollständigen Formular im exakten Guild-Scope editiert', async ({ page }) => {
    const state = await stubTickets(page, ['tickets.manage']);
    await openTickets(page);

    await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Template bearbeiten' })).toBeVisible();
    const label = page.getByLabel(/Label \(Channel-Name & Transcript\)/);
    await label.fill('Support Neu');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();

    await expect.poll(() => state.mutations.find(m => m.method === 'PUT' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets/ticket-1`)?.body?.label).toBe('Support Neu');
    const update = state.mutations.find(m => m.method === 'PUT' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets/ticket-1` && m.body?.label === 'Support Neu');
    expect(update?.body).toMatchObject({
      slot: 1,
      postChannelId: POST_CHANNEL,
      transcriptChannelId: TRANSCRIPT_CHANNEL,
      archiveChannelId: ARCHIVE_CHANNEL,
      categoryId: CATEGORY_ID,
    });
  });

  test('freier Slot lässt sich mit getrennten Channels neu anlegen', async ({ page }) => {
    const state = await stubTickets(page, ['tickets.manage']);
    await openTickets(page);

    await page.getByRole('button', { name: 'Anlegen', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Neues Template' })).toBeVisible();
    await page.getByLabel(/Post-Channel/).selectOption(POST_CHANNEL);
    await page.getByLabel(/Transcript-Channel/).selectOption(TRANSCRIPT_CHANNEL);
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();

    await expect.poll(() => state.mutations.find(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets`)?.body?.slot).toBe(2);
    const create = state.mutations.find(m => m.method === 'POST' && m.path === `/api/v2/guilds/${GUILD_ID}/tickets`);
    expect(create?.body).toMatchObject({ slot: 2, postChannelId: POST_CHANNEL, transcriptChannelId: TRANSCRIPT_CHANNEL });
  });

  test('409 beim Editieren bleibt als sichtbarer Fehler im Modal', async ({ page }) => {
    await stubTickets(page, ['tickets.manage'], { failEditWith409: true });
    await openTickets(page);

    await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
    await page.getByLabel(/Label \(Channel-Name & Transcript\)/).fill('Konflikt');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByText('Slot bereits belegt.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Template bearbeiten' })).toBeVisible();
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Ticket-Templates bleiben bei ${width}px ohne Seiten-Overflow bedienbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubTickets(page, ['tickets.manage']);
      await openTickets(page);

      await expect(page.getByRole('heading', { name: /Ticket-Templates/ })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
