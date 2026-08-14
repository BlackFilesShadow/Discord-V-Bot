process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const findUnique = jest.fn();
const findMany = jest.fn();
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyScopeMigration: { findUnique },
    nitradoConnection: { findMany },
  },
}));

import { requireSafeDashboardEconomyScope } from '../../src/dashboard/middleware/economyScopeGuard';

const CONN_ID = 'c123456789012345678901234';
const CONN_ID_2 = 'c223456789012345678901234';

function makeReq(query: Record<string, string> = {}) {
  return {
    params: { guildId: '123456789012345678' },
    query,
    guildScope: { nitradoConnId: null },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; },
  };
  return res;
}

describe('Dashboard Economy Scope Guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([{ id: CONN_ID, slot: 1, alias: 'Server 1' }]);
  });

  it('laesst Guilds ohne Legacy-Migrationszustand passieren', async () => {
    findUnique.mockResolvedValue(null);
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq();
    await requireSafeDashboardEconomyScope(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.guildScope.nitradoConnId).toBe(CONN_ID);
    expect(res.statusCode).toBe(200);
  });

  it('blockiert MIGRATION_REQUIRED mit stabilem Fehlercode', async () => {
    findUnique.mockResolvedValue({
      status: 'MIGRATION_REQUIRED',
      primaryNitradoConnId: null,
      detectedActiveServerCount: 2,
    });
    const next = jest.fn();
    const res = makeRes();
    await requireSafeDashboardEconomyScope(makeReq() as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ code: 'ECONOMY_MIGRATION_REQUIRED' });
  });

  it('blockiert weiterhin guildweite Dashboard-Aggregate bei mehreren Servern', async () => {
    findMany.mockResolvedValue([
      { id: CONN_ID, slot: 1, alias: 'Server 1' },
      { id: CONN_ID_2, slot: 2, alias: 'Server 2' },
    ]);
    const next = jest.fn();
    const res = makeRes();
    await requireSafeDashboardEconomyScope(makeReq() as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ code: 'SERVER_SCOPE_REQUIRED' });
  });

  it('erlaubt aufgeloeste Ein-Server-Legacy-Guilds', async () => {
    findUnique.mockResolvedValue({
      status: 'RESOLVED',
      primaryNitradoConnId: CONN_ID,
      detectedActiveServerCount: 1,
    });
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq();
    await requireSafeDashboardEconomyScope(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.guildScope.nitradoConnId).toBe(CONN_ID);
    expect(res.statusCode).toBe(200);
  });
});
