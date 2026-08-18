process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * NIT-012/1R: Das historische `serviceId`-Mirrorfeld darf nicht mehr selbst
 * bestimmen, welchen Server ein neuer Snapshot liest. Der Startpfad verwendet
 * ausschliesslich den kanonischen, versionierten ACTIVE-Binding-Snapshot.
 */
const createMock = jest.fn(async () => ({ id: 'snap-1' }));
const updateMock = jest.fn(async () => ({}));
const snapshotFileCreate = jest.fn(async () => ({}));
const readCurrentAdmBinding = jest.fn();
const readClientCtor = jest.fn();

const prismaMock = {
  nitradoSnapshot: {
    create: createMock,
    update: updateMock,
  },
  nitradoSnapshotFile: { create: snapshotFileCreate },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/utils/security', () => ({ __esModule: true, decrypt: () => 'decrypted-token' }));
jest.mock('../../src/modules/nitrado/adm/bindingFence', () => ({
  __esModule: true,
  readCurrentAdmBinding: (...args: unknown[]) => readCurrentAdmBinding(...args),
}));
jest.mock('../../src/modules/nitrado/mirror/readClient', () => ({
  __esModule: true,
  NitradoReadClient: jest.fn().mockImplementation((...args: unknown[]) => {
    readClientCtor(...args);
    return {
      listDir: jest.fn().mockResolvedValue([]),
      getServiceMeta: jest.fn().mockResolvedValue(null),
      getGameserver: jest.fn().mockResolvedValue(null),
      downloadFile: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    };
  }),
}));

import { startSnapshot } from '../../src/modules/nitrado/mirror/snapshotService';

const BINDING = {
  id: 'c1',
  guildId: 'g1',
  encryptedToken: 'enc',
  nitradoServerId: '123',
  bindingVersion: 7,
};

beforeEach(() => {
  jest.clearAllMocks();
  readCurrentAdmBinding.mockResolvedValue(BINDING);
});

describe('NIT-012 / Nitrado-1R — canonical snapshot binding', () => {
  it('liest den kanonischen ACTIVE-Binding-Snapshot und persistiert exakt dessen Service-ID', async () => {
    const res = await startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' });

    expect(res.snapshotId).toBe('snap-1');
    expect(readCurrentAdmBinding).toHaveBeenCalledWith({ id: 'c1', guildId: 'g1' });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        guildId: 'g1',
        nitradoConnId: 'c1',
        serviceId: '123',
        status: 'RUNNING',
      }),
    }));
    await new Promise((r) => setImmediate(r));
    expect(readClientCtor).toHaveBeenCalledWith('decrypted-token');
  });

  it('failt geschlossen, wenn kein ACTIVE kanonisches Binding existiert', async () => {
    readCurrentAdmBinding.mockResolvedValue(null);

    await expect(startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' }))
      .rejects.toThrow(/nicht ACTIVE|kanonische Service-ID/);

    expect(createMock).not.toHaveBeenCalled();
    expect(readClientCtor).not.toHaveBeenCalled();
  });

  it('propagiert Lock-/Binding-Infrastrukturfehler ohne Snapshot-Teilzustand', async () => {
    readCurrentAdmBinding.mockRejectedValue(new Error('binding lock failed'));

    await expect(startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' }))
      .rejects.toThrow('binding lock failed');

    expect(createMock).not.toHaveBeenCalled();
  });
});
