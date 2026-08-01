process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * NIT-012: NitradoConnection.serviceId (Mirror) und nitradoServerId (kanonisch)
 * bezeichnen dieselbe Service-ID. Der Snapshot fiel frueher aus, wenn nur
 * nitradoServerId gesetzt war. Jetzt greift serviceId ?? nitradoServerId.
 */
let connRow: Record<string, unknown> | null = null;
const createMock = jest.fn(async () => ({ id: 'snap-1' }));
const prismaMock = {
  nitradoConnection: { findFirst: jest.fn(async () => connRow) },
  nitradoSnapshot: {
    create: createMock,
    update: jest.fn(async () => ({})),
  },
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/utils/security', () => ({ __esModule: true, decrypt: () => 'decrypted-token' }));
jest.mock('../../src/modules/nitrado/mirror/readClient', () => ({
  __esModule: true,
  NitradoReadClient: jest.fn().mockImplementation(() => ({
    listDir: jest.fn().mockResolvedValue([]),
    getServiceMeta: jest.fn().mockResolvedValue(null),
    getGameserver: jest.fn().mockResolvedValue(null),
  })),
}));

import { startSnapshot } from '../../src/modules/nitrado/mirror/snapshotService';

beforeEach(() => { jest.clearAllMocks(); });

describe('NIT-012 — Snapshot Service-ID Fallback', () => {
  it('nutzt nitradoServerId, wenn serviceId (noch) null ist', async () => {
    connRow = { id: 'c1', encryptedToken: 'enc', serviceId: null, nitradoServerId: '123', status: 'OK', guildId: 'g1' };
    const res = await startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' });
    expect(res.snapshotId).toBe('snap-1');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ serviceId: '123' }) }));
    await new Promise((r) => setImmediate(r));
  });

  it('bevorzugt eine explizit gesetzte serviceId', async () => {
    connRow = { id: 'c1', encryptedToken: 'enc', serviceId: '456', nitradoServerId: '123', status: 'OK', guildId: 'g1' };
    await startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ serviceId: '456' }) }));
    await new Promise((r) => setImmediate(r));
  });

  it('wirft, wenn weder serviceId noch nitradoServerId gesetzt ist', async () => {
    connRow = { id: 'c1', encryptedToken: 'enc', serviceId: null, nitradoServerId: null, status: 'OK', guildId: 'g1' };
    await expect(startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' }))
      .rejects.toThrow(/Service-ID/);
  });
});
