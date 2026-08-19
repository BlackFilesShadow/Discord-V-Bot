import { test, expect, type Page, type Route } from '@playwright/test';

const GUILD_ID = '123456789012345678';
const USER_ID = '437718598876268545';
const CHANNEL_A = '123456789012345679';
const CHANNEL_B = '123456789012345680';
const MEMBER_A = '123456789012345681';
const MEMBER_B = '123456789012345682';
const ROLE_ID = '123456789012345683';

interface FactionRow {
  id: string;
  name: string;
  flagUrl: string | null;
  bannerUrl: string | null;
  mediaUrl: string | null;
  description: string | null;
  color: string | null;
  leaderDiscordId: string | null;
  deputyDiscordId: string | null;
  treasurerDiscordId: string | null;
  embedChannelId: string | null;
  embedMessageId: string | null;
  roleId: string | null;
  joinPolicy: string;
  status: string;
  isActive: boolean;
  memberCount: number;
  members: Array<{ userDiscordId: string; role: string; joinedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

interface Mutation {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function baseFaction(): FactionRow {
  const now = new Date().toISOString();
  return {
    id: 'fac-alpha',
    name: 'Alpha',
    flagUrl: null,
    bannerUrl: null,
    mediaUrl: null,
    description: 'Erste Fraktion',
    color: '#dc2626',
    leaderDiscordId: null,
    deputyDiscordId: null,
    treasurerDiscordId: null,
    embedChannelId: CHANNEL_A,
    embedMessageId: 'message-alpha',
    roleId: ROLE_ID,
    joinPolicy: 'REQUEST',
    status: 'ACTIVE',
    isActive: true,
    memberCount: 1,
    members: [{ userDiscordId: MEMBER_A, role: 'MEMBER', joinedAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

async function stubFactions(page: Page, opts: { canManage: boolean; republishError?: boolean }) {
  const mutations: Mutation[] = [];
  const manageLookupPaths: string[] = [];
  let factions: FactionRow[] = [baseFaction()];
  let factionChannelId: string | null = CHANNEL_A;

  await page.route('**/api/me', route => json(route, {
    user: { discordId: USER_ID, username: opts.canManage ? 'factions-admin' : 'factions-viewer', avatar: null, role: 'ADMIN' },
  }));
  await page.route('**/auth/status', route => json(route, {
    authenticated: true,
    user: { discordId: USER_ID, username: opts.canManage ? 'factions-admin' : 'factions-viewer', avatar: null, role: 'ADMIN' },
  }));

  await page.route('**/api/v2/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    if (path === '/api/v2/dev/status') return json(route, { active: false, eligible: false, expiresAt: null });
    if (path === '/api/v2/bot-admin/status') return json(route, { active: false, expiresAt: null });

    if (path === `/api/v2/guilds/${GUILD_ID}/dashboard`) {
      return json(route, {
        guildId: GUILD_ID,
        alias5: 'CHAOS',
        isOwner: false,
        permissions: opts.canManage ? ['factions.view', 'factions.manage'] : ['factions.view'],
        slots: [],
        grantsCount: 1,
      });
    }

    const base = `/api/v2/guilds/${GUILD_ID}/factions`;
    if (path === base && method === 'GET') return json(route, { factions });
    if (path === `${base}/system-config` && method === 'GET') {
      return json(route, { factionChannelId, listMessageId: 'list-message-1', updatedAt: new Date().toISOString() });
    }

    if (path === `${base}/lookups/channels` && method === 'GET') {
      manageLookupPaths.push(path);
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      return json(route, {
        channels: [
          { id: CHANNEL_A, name: 'fraktionen', type: 0 },
          { id: CHANNEL_B, name: 'fraktionen-news', type: 5 },
        ],
      });
    }
    if (path === `${base}/lookups/roles` && method === 'GET') {
      manageLookupPaths.push(path);
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      return json(route, { roles: [{ id: ROLE_ID, name: 'Fraktion', color: '#ffffff', assignable: true }] });
    }
    if (path === `${base}/lookups/members` && method === 'GET') {
      manageLookupPaths.push(path);
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      const q = url.searchParams.get('q')?.toLowerCase() ?? '';
      return json(route, {
        members: q.length >= 2
          ? [{ id: MEMBER_B, username: 'new-member', globalName: 'New Member', displayName: 'New Member', avatarUrl: null, bot: false }]
          : [],
      });
    }
    if (path === `${base}/lookups/members/${MEMBER_A}` && method === 'GET') {
      return json(route, { id: MEMBER_A, username: 'alpha-member', globalName: 'Alpha Member', displayName: 'Alpha Member', avatarUrl: null, bot: false });
    }
    if (path === `${base}/lookups/members/${MEMBER_B}` && method === 'GET') {
      return json(route, { id: MEMBER_B, username: 'new-member', globalName: 'New Member', displayName: 'New Member', avatarUrl: null, bot: false });
    }

    const mutationBody = (): Record<string, unknown> | null => {
      if (!req.postData()) return null;
      try { return req.postDataJSON() as Record<string, unknown>; } catch { return null; }
    };

    if (path === `${base}/system-config` && method === 'PUT') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      const body = mutationBody();
      mutations.push({ method, path, body });
      factionChannelId = typeof body?.factionChannelId === 'string' ? body.factionChannelId : null;
      return json(route, { factionChannelId, listMessageId: null, updatedAt: new Date().toISOString() });
    }

    if (path === base && method === 'POST') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      const body = mutationBody() ?? {};
      mutations.push({ method, path, body });
      const now = new Date().toISOString();
      const created: FactionRow = {
        ...baseFaction(),
        id: 'fac-bravo',
        name: String(body.name),
        description: typeof body.description === 'string' ? body.description : null,
        embedChannelId: typeof body.embedChannelId === 'string' ? body.embedChannelId : null,
        embedMessageId: null,
        roleId: typeof body.roleId === 'string' ? body.roleId : null,
        joinPolicy: String(body.joinPolicy ?? 'REQUEST'),
        status: String(body.status ?? 'ACTIVE'),
        memberCount: 0,
        members: [],
        createdAt: now,
        updatedAt: now,
      };
      factions = [...factions, created];
      return json(route, { id: created.id, name: created.name }, 201);
    }

    const republish = path.match(new RegExp(`^${base}/([^/]+)/republish$`));
    if (republish && method === 'POST') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      mutations.push({ method, path, body: mutationBody() });
      if (opts.republishError) return json(route, { error: 'Bot nicht bereit.' }, 503);
      return json(route, { messageId: 'message-republished' });
    }

    const members = path.match(new RegExp(`^${base}/([^/]+)/members$`));
    if (members && method === 'POST') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      const body = mutationBody() ?? {};
      mutations.push({ method, path, body });
      factions = factions.map(row => row.id === members[1]
        ? {
            ...row,
            members: [...row.members.filter(m => m.userDiscordId !== String(body.userDiscordId)), {
              userDiscordId: String(body.userDiscordId), role: String(body.role ?? 'MEMBER'), joinedAt: new Date().toISOString(),
            }],
            memberCount: row.members.some(m => m.userDiscordId === String(body.userDiscordId)) ? row.memberCount : row.memberCount + 1,
          }
        : row);
      return json(route, { ok: true }, 201);
    }

    const memberDelete = path.match(new RegExp(`^${base}/([^/]+)/members/(\\d{17,20})$`));
    if (memberDelete && method === 'DELETE') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      mutations.push({ method, path, body: null });
      factions = factions.map(row => row.id === memberDelete[1]
        ? { ...row, members: row.members.filter(m => m.userDiscordId !== memberDelete[2]), memberCount: Math.max(0, row.memberCount - 1) }
        : row);
      return json(route, { ok: true });
    }

    const factionId = path.match(new RegExp(`^${base}/([^/]+)$`));
    if (factionId && method === 'PATCH') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      const body = mutationBody() ?? {};
      mutations.push({ method, path, body });
      factions = factions.map(row => row.id === factionId[1]
        ? { ...row, ...body, updatedAt: new Date().toISOString() } as FactionRow
        : row);
      return json(route, { ok: true });
    }
    if (factionId && method === 'DELETE') {
      if (!opts.canManage) return json(route, { error: 'Keine Berechtigung.' }, 403);
      mutations.push({ method, path, body: null });
      factions = factions.filter(row => row.id !== factionId[1]);
      return json(route, { ok: true });
    }

    return json(route, {});
  });

  return { mutations, manageLookupPaths };
}

async function openFactions(page: Page): Promise<void> {
  await page.goto(`/servers/${GUILD_ID}`);
  await page.getByRole('button', { name: 'Fraktionssystem', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fraktionssystem' }).first()).toBeVisible();
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('Factions authenticated dashboard contract', () => {
  test('factions.view bleibt read-only und ruft keine manage-only Lookups oder Mutationen auf', async ({ page }) => {
    const state = await stubFactions(page, { canManage: false });
    await openFactions(page);

    await expect(page.getByText(/Nur-Lesezugriff/)).toBeVisible();
    await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
    await expect(page.getByText('Alpha Member', { exact: true })).toBeVisible();
    await expect(page.getByText('Neue Fraktion')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Sammel-Channel' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fraktion Alpha bearbeiten' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fraktion Alpha loeschen' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Embed Alpha neu posten' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Mitglied ${MEMBER_A} entfernen` })).toHaveCount(0);

    expect(state.manageLookupPaths).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  test('factions.manage deckt Config, Republish, Member, Edit, Create und Delete im exakten Guild-Scope ab', async ({ page }) => {
    const state = await stubFactions(page, { canManage: true });
    page.on('dialog', dialog => { void dialog.accept(); });
    await openFactions(page);

    const systemChannel = page.getByRole('combobox', { name: 'Sammel-Channel' });
    await expect(systemChannel).toBeVisible();
    await systemChannel.selectOption(CHANNEL_B);
    await page.getByRole('button', { name: 'Speichern', exact: true }).first().click();
    await expect.poll(() => state.mutations.some(m => m.method === 'PUT' && m.path.endsWith('/system-config'))).toBe(true);

    await page.getByRole('button', { name: 'Embed Alpha neu posten' }).click();
    await expect(page.getByText('Embed neu gepostet.')).toBeVisible();

    const memberSearch = page.getByRole('textbox', { name: 'Mitglied fuer Alpha suchen…' }).first();
    await memberSearch.fill('New');
    await expect(page.getByRole('button', { name: /New Member/ }).first()).toBeVisible();
    await page.getByRole('button', { name: /New Member/ }).first().click();
    await page.getByRole('button', { name: 'Mitglied zu Alpha hinzufuegen' }).click();
    await expect(page.getByText('Mitglied hinzugefuegt.')).toBeVisible();
    await expect.poll(() => state.mutations.some(m => m.method === 'POST' && m.path.endsWith('/fac-alpha/members'))).toBe(true);

    await page.getByRole('button', { name: `Mitglied ${MEMBER_A} entfernen` }).first().click();
    await expect(page.getByText('Mitglied entfernt.')).toBeVisible();
    await expect.poll(() => state.mutations.some(m => m.method === 'DELETE' && m.path.endsWith(`/fac-alpha/members/${MEMBER_A}`))).toBe(true);

    await page.getByRole('button', { name: 'Fraktion Alpha bearbeiten' }).click();
    const name = page.getByRole('textbox', { name: 'Fraktionsname' });
    await name.fill('Alpha Prime');
    await page.getByRole('button', { name: 'Speichern', exact: true }).last().click();
    await expect(page.getByText('Fraktion gespeichert.')).toBeVisible();
    await expect.poll(() => state.mutations.some(m => m.method === 'PATCH' && m.path.endsWith('/fac-alpha'))).toBe(true);

    await name.fill('Bravo');
    await page.getByRole('button', { name: 'Erstellen', exact: true }).click();
    await expect(page.getByText('Fraktion erstellt.')).toBeVisible();
    await expect(page.getByText('Bravo', { exact: true })).toBeVisible();
    await expect.poll(() => state.mutations.some(m => m.method === 'POST' && m.path.endsWith('/factions'))).toBe(true);

    await page.getByRole('button', { name: 'Fraktion Bravo loeschen' }).click();
    await expect(page.getByText('Fraktion geloescht.')).toBeVisible();
    await expect.poll(() => state.mutations.some(m => m.method === 'DELETE' && m.path.endsWith('/fac-bravo'))).toBe(true);

    for (const mutation of state.mutations) {
      expect(mutation.path).toContain(`/api/v2/guilds/${GUILD_ID}/factions`);
    }
  });

  test('Republish-Backendfehler wird sichtbar und nicht als Erfolg dargestellt', async ({ page }) => {
    await stubFactions(page, { canManage: true, republishError: true });
    await openFactions(page);

    await page.getByRole('button', { name: 'Embed Alpha neu posten' }).click();
    await expect(page.getByText('Bot nicht bereit.')).toBeVisible();
    await expect(page.getByText('Embed neu gepostet.')).toHaveCount(0);
  });

  for (const width of [320, 360, 375, 390, 430]) {
    test(`Factions Manage bleibt bei ${width}px ohne Seiten-Overflow bedienbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubFactions(page, { canManage: true });
      await openFactions(page);

      await expect(page.getByRole('combobox', { name: 'Sammel-Channel' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Fraktionsname' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Fraktion Alpha bearbeiten' })).toBeVisible();
      await noPageOverflow(page);
    });
  }
});
