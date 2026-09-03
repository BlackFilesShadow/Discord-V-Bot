const mockGetBanlist = jest.fn();
const mockTryLock = jest.fn();
const mockEnqueueAdd = jest.fn();
const mockEnqueueRemove = jest.fn();
const mockLogAudit = jest.fn();
const mockNotifyDrift = jest.fn();
const mockClearDrift = jest.fn();

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ getBanlist: mockGetBanlist })),
}));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => mockTryLock(...args),
}));

jest.mock('../../src/modules/bans/banOutbox', () => ({
  enqueueServerBanAdd: (...args: unknown[]) => mockEnqueueAdd(...args),
  enqueueServerBanRemove: (...args: unknown[]) => mockEnqueueRemove(...args),
  SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS: 60 * 60 * 1000,
}));

jest.mock('../../src/modules/nitrado/driftDiscord', () => ({
  notifyNitradoBanDrift: (...args: unknown[]) => mockNotifyDrift(...args),
  clearNitradoDriftNotice: (...args: unknown[]) => mockClearDrift(...args),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: jest.fn(), findFirst: jest.fn() },
    serverBanEntry: { findMany: jest.fn(), updateMany: jest.fn() },
    serverBanRemoteIdentity: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  },
}));

import prisma from '../../src/database/prisma';
import { encrypt, decrypt } from '../../src/utils/security';
import { hashBanIdentifier } from '../../src/modules/bans/banTarget';
import { runBanReconciliationOnce } from '../../src/modules/bans/banReconciliation';

const db = prisma as any;
const KEY = '0'.repeat(64);
const NOW = new Date('2026-08-19T03:45:00.000Z');
const CONN = {
  id: 'conn-1', guildId: 'guild-1', encryptedToken: encrypt('token-12345678', KEY), nitradoServerId: '101',
};

function ban(id: string, identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    identityHash: hashBanIdentifier(identifier, KEY),
    active: true,
    expiresAt: null,
    appliedRemotely: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.nitradoConnection.findMany.mockResolvedValue([{ id: CONN.id, guildId: CONN.guildId }]);
  db.nitradoConnection.findFirst.mockResolvedValue(CONN);
  db.serverBanEntry.findMany.mockResolvedValue([]);
  db.serverBanEntry.updateMany.mockResolvedValue({ count: 1 });
  db.serverBanRemoteIdentity.findMany.mockResolvedValue([]);
  db.serverBanRemoteIdentity.upsert.mockResolvedValue({});
  db.serverBanRemoteIdentity.deleteMany.mockResolvedValue({ count: 1 });
  mockGetBanlist.mockResolvedValue([]);
  mockEnqueueAdd.mockResolvedValue(true);
  mockEnqueueRemove.mockResolvedValue(true);
  mockTryLock.mockResolvedValue({ release: jest.fn().mockResolvedValue(undefined) });
});

describe('Nitrado-1W server-ban DB <-> Nitrado reconciliation', () => {
  it('pauses a previously confirmed active ban when it disappears remotely instead of silently restoring it', async () => {
    const row = ban('ban-1', 'PlayerOne');
    db.serverBanEntry.findMany.mockResolvedValue([row]);
    db.serverBanRemoteIdentity.findMany.mockResolvedValue([{
      banId: row.id,
      identifierEnc: encrypt('PlayerOne', KEY),
    }]);

    await runBanReconciliationOnce(NOW);

    expect(db.serverBanEntry.updateMany).not.toHaveBeenCalled();
    expect(mockEnqueueAdd).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      'SERVER_BAN_RECONCILED',
      'NITRADO',
      expect.objectContaining({
        guildId: 'guild-1',
        nitradoConnId: 'conn-1',
        manualRemoteMissingObserved: 1,
        repairedAdds: 0,
      }),
    );
  });

  it('still repairs an explicitly pending active ban whose remote state has never been confirmed', async () => {
    const row = ban('ban-pending', 'PendingPlayer', { appliedRemotely: false });
    db.serverBanEntry.findMany.mockResolvedValue([row]);
    db.serverBanRemoteIdentity.findMany.mockResolvedValue([{
      banId: row.id,
      identifierEnc: encrypt('PendingPlayer', KEY),
    }]);

    await runBanReconciliationOnce(NOW);

    expect(mockEnqueueAdd).toHaveBeenCalledWith(
      db,
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'ban-pending',
      'PendingPlayer',
      KEY,
      { recentDeadCooldownMs: 60 * 60 * 1000, now: NOW },
    );
  });

  it('confirms a remote active ban and backfills only an encrypted reconciliation identity', async () => {
    const row = ban('ban-2', 'PlayerTwo', { appliedRemotely: false });
    db.serverBanEntry.findMany.mockResolvedValue([row]);
    mockGetBanlist.mockResolvedValue([{ identifier: 'PlayerTwo' }]);

    await runBanReconciliationOnce(NOW);

    expect(db.serverBanEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'ban-2', guildId: 'guild-1', nitradoConnId: 'conn-1' }),
      data: { appliedRemotely: true },
    }));
    expect(db.serverBanRemoteIdentity.upsert).toHaveBeenCalledTimes(1);
    const args = db.serverBanRemoteIdentity.upsert.mock.calls[0][0];
    expect(args.create.banId).toBe('ban-2');
    expect(args.create.identifierEnc).not.toContain('PlayerTwo');
    expect(decrypt(args.create.identifierEnc, KEY)).toBe('PlayerTwo');
    expect(mockEnqueueAdd).not.toHaveBeenCalled();
  });

  it('queues removal only for a matching bot-owned inactive ban and never imports unknown remote bans', async () => {
    const row = ban('ban-3', 'OwnedPlayer', { active: false, appliedRemotely: false });
    db.serverBanEntry.findMany.mockResolvedValue([row]);
    mockGetBanlist.mockResolvedValue([
      { identifier: 'ExternalAdminBan' },
      { identifier: 'OwnedPlayer' },
    ]);

    await runBanReconciliationOnce(NOW);

    expect(mockEnqueueRemove).toHaveBeenCalledTimes(1);
    expect(mockEnqueueRemove).toHaveBeenCalledWith(
      db,
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'ban-3',
      { now: NOW },
    );
    expect(db.serverBanEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'ban-3', guildId: 'guild-1', nitradoConnId: 'conn-1' },
      data: { appliedRemotely: true },
    });
  });

  it('cleans remote confirmation and encrypted secret after inactive ban is confirmed absent', async () => {
    const row = ban('ban-4', 'OldPlayer', { active: false, appliedRemotely: true });
    db.serverBanEntry.findMany.mockResolvedValue([row]);
    db.serverBanRemoteIdentity.findMany.mockResolvedValue([{
      banId: row.id,
      identifierEnc: encrypt('OldPlayer', KEY),
    }]);

    await runBanReconciliationOnce(NOW);

    expect(db.serverBanEntry.updateMany).toHaveBeenCalledWith({
      where: { id: 'ban-4', guildId: 'guild-1', nitradoConnId: 'conn-1' },
      data: { appliedRemotely: false },
    });
    expect(db.serverBanRemoteIdentity.deleteMany).toHaveBeenCalledWith({ where: { banId: 'ban-4' } });
    expect(mockEnqueueRemove).not.toHaveBeenCalled();
  });

  it('fails closed when a pending active remote ban has no valid reconciliation secret', async () => {
    const row = ban('ban-5', 'SecretPlayer', { appliedRemotely: false });
    db.serverBanEntry.findMany.mockResolvedValue([row]);
    db.serverBanRemoteIdentity.findMany.mockResolvedValue([{ banId: row.id, identifierEnc: 'corrupt' }]);

    await runBanReconciliationOnce(NOW);

    expect(mockEnqueueAdd).not.toHaveBeenCalled();
    expect(db.serverBanRemoteIdentity.deleteMany).toHaveBeenCalledWith({ where: { banId: 'ban-5' } });
    expect(mockLogAudit).toHaveBeenCalledWith(
      'SERVER_BAN_RECONCILE_IDENTITY_CORRUPT',
      'NITRADO',
      expect.objectContaining({ guildId: 'guild-1', nitradoConnId: 'conn-1', banId: 'ban-5' }),
    );
  });

  it('leaves completely unknown remote bans untouched when no local bot ban exists', async () => {
    mockGetBanlist.mockResolvedValue([{ identifier: 'ExternalOnly' }]);
    db.serverBanEntry.findMany.mockResolvedValue([]);

    await runBanReconciliationOnce(NOW);

    expect(mockEnqueueAdd).not.toHaveBeenCalled();
    expect(mockEnqueueRemove).not.toHaveBeenCalled();
    expect(db.serverBanEntry.updateMany).not.toHaveBeenCalled();
    expect(db.serverBanRemoteIdentity.upsert).not.toHaveBeenCalled();
  });

  it('isolates two pending gameserver repairs by exact guild+connection scope after separate locks', async () => {
    const conn2 = {
      id: 'conn-2', guildId: 'guild-1', encryptedToken: encrypt('token-87654321', KEY), nitradoServerId: '202',
    };
    db.nitradoConnection.findMany.mockResolvedValue([
      { id: 'conn-1', guildId: 'guild-1' },
      { id: 'conn-2', guildId: 'guild-1' },
    ]);
    db.nitradoConnection.findFirst.mockImplementation(async ({ where }: any) => where.id === 'conn-1' ? CONN : conn2);
    db.serverBanEntry.findMany.mockImplementation(async ({ where }: any) => {
      if (where.nitradoConnId === 'conn-1') return [ban('ban-a', 'Alpha', { appliedRemotely: false })];
      if (where.nitradoConnId === 'conn-2') return [ban('ban-b', 'Beta', { appliedRemotely: false })];
      return [];
    });
    db.serverBanRemoteIdentity.findMany.mockImplementation(async ({ where }: any) => {
      const id = where.banId.in[0];
      return [{ banId: id, identifierEnc: encrypt(id === 'ban-a' ? 'Alpha' : 'Beta', KEY) }];
    });
    mockGetBanlist.mockResolvedValue([]);

    await runBanReconciliationOnce(NOW);

    expect(mockTryLock).toHaveBeenNthCalledWith(1, 'conn-1');
    expect(mockTryLock).toHaveBeenNthCalledWith(2, 'conn-2');
    expect(mockEnqueueAdd).toHaveBeenCalledWith(
      db, { guildId: 'guild-1', nitradoConnId: 'conn-1' }, 'ban-a', 'Alpha', KEY, expect.any(Object),
    );
    expect(mockEnqueueAdd).toHaveBeenCalledWith(
      db, { guildId: 'guild-1', nitradoConnId: 'conn-2' }, 'ban-b', 'Beta', KEY, expect.any(Object),
    );
  });
});
