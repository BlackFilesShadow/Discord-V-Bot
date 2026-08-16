process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import fs from 'node:fs';
import path from 'node:path';

const mockPermissionFindUnique = jest.fn();
const mockRoleFindMany = jest.fn();
const mockMigrationFindUnique = jest.fn();
const mockNitradoFindMany = jest.fn();
const mockMember = { roles: { cache: new Map<string, unknown>() } };
const mockGuild = {
  ownerId: '999999999999999999',
  members: {
    cache: { get: jest.fn(() => mockMember) },
    fetch: jest.fn(async () => mockMember),
  },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildPermissionGrant: { findUnique: mockPermissionFindUnique },
    guildPermissionRoleGrant: { findMany: mockRoleFindMany },
    economyScopeMigration: { findUnique: mockMigrationFindUnique },
    nitradoConnection: { findMany: mockNitradoFindMany },
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  getDashboardClient: () => ({ guilds: { cache: { get: () => mockGuild } } }),
}));

import { requireGuildPermission } from '../../src/dashboard/middleware/auth';
import { requireGuildAnyPermission } from '../../src/dashboard/middleware/guildDomainAccess';
import { requireSafeDashboardEconomyScope } from '../../src/dashboard/middleware/economyScopeGuard';

const GUILD_ID = '123456789012345678';
const USER_ID = '111111111111111111';
const CONN_ID = 'c123456789012345678901234';

function makeReq(query: Record<string, string> = { slot: '1' }) {
  return {
    auth: { userId: 'db-user', discordId: USER_ID, role: 'USER' },
    params: { guildId: GUILD_ID },
    query,
  } as any;
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; },
  } as any;
}

describe('Economy dashboard auth -> gameserver scope ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRoleFindMany.mockResolvedValue([]);
    mockMigrationFindUnique.mockResolvedValue(null);
    mockNitradoFindMany.mockResolvedValue([{ id: CONN_ID, slot: 1, alias: 'Server 1' }]);
  });

  it('baut Guild-Scope vor dem Economy-Guard auf und behaelt den validierten Gameserver bei der exakten Permission-Revalidierung', async () => {
    mockPermissionFindUnique.mockResolvedValue({ permissions: ['economy.view'] });
    const req = makeReq();
    const res = makeRes();

    const domainNext = jest.fn();
    await requireGuildAnyPermission('economy.view', 'economy.manage')(req, res, domainNext);
    expect(domainNext).toHaveBeenCalledTimes(1);
    expect(req.guildScope).toMatchObject({ guildId: GUILD_ID, actorDiscordId: USER_ID, nitradoConnId: null });

    const scopeNext = jest.fn();
    await requireSafeDashboardEconomyScope(req, res, scopeNext);
    expect(scopeNext).toHaveBeenCalledTimes(1);
    expect(req.guildScope.nitradoConnId).toBe(CONN_ID);

    const exactNext = jest.fn();
    await requireGuildPermission('economy.view')(req, res, exactNext);
    expect(exactNext).toHaveBeenCalledTimes(1);
    expect(req.guildScope.nitradoConnId).toBe(CONN_ID);
    expect(res.statusCode).toBe(200);
  });

  it('blockiert fremde Guild-Domains bereits vor dem Economy-Scope-Guard', async () => {
    mockPermissionFindUnique.mockResolvedValue({ permissions: ['whitelist.view'] });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireGuildAnyPermission('economy.view', 'economy.manage')(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(mockNitradoFindMany).not.toHaveBeenCalled();
  });

  it('montiert Economy und Casino immer mit Domain-Auth vor dem Gameserver-Scope-Guard', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'dashboard', 'routes', 'v2.ts'), 'utf8');
    expect(source).toContain("'/guilds/:guildId/economy/virtual-accounts', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope");
    expect(source).toContain("'/guilds/:guildId/economy/lottery', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope");
    expect(source).toContain("'/guilds/:guildId/economy/black-market', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope");
    expect(source).toContain("'/guilds/:guildId/economy', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope");
    expect(source).toContain("'/guilds/:guildId/casino', requireCasinoDashboardAccess, requireSafeDashboardEconomyScope");
  });
});
