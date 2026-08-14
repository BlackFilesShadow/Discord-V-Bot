process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const findUnique = jest.fn();
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { economyScopeMigration: { findUnique } },
}));

import { requireSafeDashboardEconomyScope } from '../../src/dashboard/middleware/economyScopeGuard';

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
  beforeEach(() => jest.clearAllMocks());

  it('laesst Guilds ohne Legacy-Migrationszustand passieren', async () => {
    findUnique.mockResolvedValue(null);
    const next = jest.fn();
    const res = makeRes();
    await requireSafeDashboardEconomyScope(
      { params: { guildId: '123456789012345678' } } as never,
      res as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
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
    await requireSafeDashboardEconomyScope(
      { params: { guildId: '123456789012345678' } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ code: 'ECONOMY_MIGRATION_REQUIRED' });
  });

  it('blockiert weiterhin guildweite Dashboard-Aggregate bei mehreren Servern', async () => {
    findUnique.mockResolvedValue({
      status: 'RESOLVED',
      primaryNitradoConnId: 'clx1234567890123456789012',
      detectedActiveServerCount: 2,
    });
    const next = jest.fn();
    const res = makeRes();
    await requireSafeDashboardEconomyScope(
      { params: { guildId: '123456789012345678' } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload).toMatchObject({ code: 'SERVER_SCOPE_REQUIRED' });
  });

  it('erlaubt aufgeloeste Ein-Server-Legacy-Guilds', async () => {
    findUnique.mockResolvedValue({
      status: 'RESOLVED',
      primaryNitradoConnId: 'clx1234567890123456789012',
      detectedActiveServerCount: 1,
    });
    const next = jest.fn();
    const res = makeRes();
    await requireSafeDashboardEconomyScope(
      { params: { guildId: '123456789012345678' } } as never,
      res as never,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
