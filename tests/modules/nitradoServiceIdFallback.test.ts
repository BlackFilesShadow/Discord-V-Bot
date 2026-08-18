process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const snapshotUpdateMany = jest.fn(async () => ({ count: 1 }));
const snapshotFileCreate = jest.fn(async () => ({}));
const readCurrentAdmBinding = jest.fn();
const withFreshAdmBinding = jest.fn();
const readClientCtor = jest.fn();
const acquireLease = jest.fn();
const renewLease = jest.fn();
const finalizeLease = jest.fn();
const releaseLease = jest.fn();

const prismaMock = {
  nitradoSnapshot: { updateMany: snapshotUpdateMany },
  nitradoSnapshotFile: { create: snapshotFileCreate },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/utils/security', () => ({ __esModule: true, decrypt: () => 'decrypted-token' }));
jest.mock('../../src/modules/nitrado/adm/bindingFence', () => ({
  __esModule: true,
  readCurrentAdmBinding: (...args: unknown[]) => readCurrentAdmBinding(...args),
  withFreshAdmBinding: (...args: unknown[]) => withFreshAdmBinding(...args),
}));
jest.mock('../../src/modules/nitrado/mirror/mirrorLease', () => ({
  __esModule: true,
  MIRROR_HEARTBEAT_MS: 30_000,
  acquireMirrorSnapshotLease: (...args: unknown[]) => acquireLease(...args),
  renewMirrorSnapshotLease: (...args: unknown[]) => renewLease(...args),
  finalizeMirrorSnapshotLease: (...args: unknown[]) => finalizeLease(...args),
  releaseMirrorSnapshotLease: (...args: unknown[]) => releaseLease(...args),
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
  withFreshAdmBinding.mockImplementation(async (_binding: unknown, work: () => Promise<unknown>) => work());
  acquireLease.mockResolvedValue({ snapshotId: 'snap-1', leaseToken: 'lease-1', reused: false });
  renewLease.mockResolvedValue(undefined);
  finalizeLease.mockResolvedValue(true);
  releaseLease.mockResolvedValue(true);
});

describe('NIT-012 / Nitrado-1R/1T — canonical snapshot binding', () => {
  it('uses the canonical ACTIVE binding to establish exactly the mirror lease target', async () => {
    const res = await startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' });

    expect(res.snapshotId).toBe('snap-1');
    expect(readCurrentAdmBinding).toHaveBeenCalledWith({ id: 'c1', guildId: 'g1' });
    expect(acquireLease).toHaveBeenCalledWith({
      guildId: 'g1', nitradoConnId: 'c1', serviceId: '123', triggeredBy: 'u1',
    });
    expect(withFreshAdmBinding).toHaveBeenCalledWith(BINDING, expect.any(Function));
    await new Promise((r) => setImmediate(r));
    expect(readClientCtor).toHaveBeenCalledWith('decrypted-token');
  });

  it('reuses an active per-connection snapshot without spawning a second remote reader', async () => {
    acquireLease.mockResolvedValueOnce({ snapshotId: 'snap-existing', leaseToken: null, reused: true });

    const res = await startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u2' });

    expect(res.snapshotId).toBe('snap-existing');
    expect(withFreshAdmBinding).not.toHaveBeenCalled();
    expect(readClientCtor).not.toHaveBeenCalled();
  });

  it('fails closed when no ACTIVE canonical binding exists', async () => {
    readCurrentAdmBinding.mockResolvedValue(null);

    await expect(startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' }))
      .rejects.toThrow(/nicht ACTIVE|kanonische Service-ID/);

    expect(acquireLease).not.toHaveBeenCalled();
    expect(readClientCtor).not.toHaveBeenCalled();
  });

  it('propagates binding infrastructure errors without creating a mirror lease', async () => {
    readCurrentAdmBinding.mockRejectedValue(new Error('binding lock failed'));

    await expect(startSnapshot({ guildId: 'g1', nitradoConnId: 'c1', triggeredBy: 'u1' }))
      .rejects.toThrow('binding lock failed');

    expect(acquireLease).not.toHaveBeenCalled();
  });
});
