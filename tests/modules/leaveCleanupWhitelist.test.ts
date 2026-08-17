const mockGameIdentityFindMany = jest.fn();
const mockPlayerSessionFindMany = jest.fn();
const mockConnectionFindFirst = jest.fn();
const mockWhitelistEntryFindMany = jest.fn();
const mockWhitelistRequestFindMany = jest.fn();
const mockWhitelistRequestDeleteMany = jest.fn();
const mockNitradoJobFindMany = jest.fn();
const mockWhitelistEntryUpdateMany = jest.fn();
const mockWhitelistEntryDeleteMany = jest.fn();
const mockWhitelistRequestUpdateMany = jest.fn();
const mockTxWhitelistRequestDeleteMany = jest.fn();
const mockNitradoJobUpdateMany = jest.fn();
const mockNitradoJobCreate = jest.fn();
const mockTransaction = jest.fn();
const mockGetWhitelist = jest.fn();
const mockDecrypt = jest.fn();

const mockTx = {
  whitelistEntry: {
    updateMany: mockWhitelistEntryUpdateMany,
    deleteMany: mockWhitelistEntryDeleteMany,
  },
  whitelistRequest: {
    updateMany: mockWhitelistRequestUpdateMany,
    deleteMany: mockTxWhitelistRequestDeleteMany,
  },
  nitradoJob: {
    updateMany: mockNitradoJobUpdateMany,
    create: mockNitradoJobCreate,
  },
};

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: 'leave-test-secret-0123456789abcdef' } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: mockDecrypt,
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ getWhitelist: mockGetWhitelist })),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: mockTransaction,
    gameIdentityLink: { findMany: mockGameIdentityFindMany },
    playerSession: { findMany: mockPlayerSessionFindMany },
    nitradoConnection: { findFirst: mockConnectionFindFirst },
    whitelistEntry: { findMany: mockWhitelistEntryFindMany },
    whitelistRequest: {
      findMany: mockWhitelistRequestFindMany,
      deleteMany: mockWhitelistRequestDeleteMany,
    },
    nitradoJob: { findMany: mockNitradoJobFindMany },
  },
}));

import { identityHash } from '../../src/modules/linking/identity';
import { runLeaveWhitelistCleanupStep } from '../../src/modules/moderation/leaveCleanupWhitelist';

const GUILD = '12345678901234567';
const OTHER_GUILD = '22345678901234567';
const USER = '32345678901234567';
const CONN = 'conn-a';
const SECRET = 'leave-test-secret-0123456789abcdef';
const GUID = 'DAYZ-GUID-001';
const LINK_HASH = identityHash(GUID, SECRET);

function activeConnection() {
  return {
    id: CONN,
    encryptedToken: 'encrypted-token',
    nitradoServerId: 'service-1',
    status: 'ACTIVE',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTransaction.mockImplementation(async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx));
  mockGameIdentityFindMany.mockResolvedValue([{ nitradoConnId: CONN, identityHash: LINK_HASH }]);
  mockPlayerSessionFindMany.mockResolvedValue([{ gameId: GUID, playerName: 'TargetPlayer' }]);
  mockConnectionFindFirst.mockResolvedValue(activeConnection());
  mockWhitelistEntryFindMany.mockResolvedValue([]);
  mockWhitelistRequestFindMany.mockResolvedValue([]);
  mockWhitelistRequestDeleteMany.mockResolvedValue({ count: 0 });
  mockNitradoJobFindMany.mockResolvedValue([]);
  mockWhitelistEntryUpdateMany.mockResolvedValue({ count: 1 });
  mockWhitelistEntryDeleteMany.mockResolvedValue({ count: 1 });
  mockWhitelistRequestUpdateMany.mockResolvedValue({ count: 1 });
  mockTxWhitelistRequestDeleteMany.mockResolvedValue({ count: 1 });
  mockNitradoJobUpdateMany.mockResolvedValue({ count: 1 });
  mockNitradoJobCreate.mockResolvedValue({ id: 'remove-job' });
  mockDecrypt.mockReturnValue('plain-nitrado-token');
  mockGetWhitelist.mockResolvedValue([]);
});

describe('Leave-1B identity-safe whitelist cleanup', () => {
  it('derives whitelist names only from a session GUID matching the verified link HMAC', async () => {
    mockPlayerSessionFindMany.mockResolvedValue([
      { gameId: 'FOREIGN-GUID', playerName: 'ForeignPlayer' },
      { gameId: GUID, playerName: 'TargetPlayer' },
    ]);
    mockWhitelistEntryFindMany.mockResolvedValue([
      { id: 'target', gameId: 'targetplayer', syncState: 'SYNCED' },
      { id: 'foreign', gameId: 'ForeignPlayer', syncState: 'SYNCED' },
    ]);
    mockGetWhitelist.mockResolvedValue([{ identifier: 'TARGETPLAYER' }]);

    const result = await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(result.state).toBe('WAITING');
    expect(result.removeJobsQueued).toBe(1);
    expect(mockWhitelistEntryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ['target'] },
        guildId: GUILD,
        nitradoConnId: CONN,
      }),
    }));
    expect(mockNitradoJobCreate).toHaveBeenCalledWith({
      data: {
        guildId: GUILD,
        nitradoConnId: CONN,
        operation: 'WHITELIST_REMOVE',
        payload: { gameId: 'TARGETPLAYER' },
      },
    });
  });

  it('fails closed when a verified GUID can no longer be mapped to a trusted session name', async () => {
    mockPlayerSessionFindMany.mockResolvedValue([{ gameId: 'FOREIGN-GUID', playerName: 'TargetPlayer' }]);

    await expect(runLeaveWhitelistCleanupStep(GUILD, USER)).rejects.toThrow(/nicht mehr sicher/);
    expect(mockConnectionFindFirst).not.toHaveBeenCalled();
    expect(mockNitradoJobCreate).not.toHaveBeenCalled();
  });

  it('waits for a running WHITELIST_ADD instead of scheduling a removal behind a possible re-add', async () => {
    mockWhitelistEntryFindMany.mockResolvedValue([{ id: 'target', gameId: 'TargetPlayer', syncState: 'SYNCED' }]);
    mockNitradoJobFindMany.mockResolvedValueOnce([
      { id: 'add-running', operation: 'WHITELIST_ADD', status: 'RUNNING', payload: { gameId: 'TargetPlayer' } },
    ]);
    mockGetWhitelist.mockResolvedValue([{ identifier: 'TargetPlayer' }]);

    const result = await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(result.state).toBe('WAITING');
    expect(result.removeJobsQueued).toBe(0);
    expect(mockNitradoJobCreate).not.toHaveBeenCalled();
  });

  it('neutralizes a pending add before queuing the remote remove', async () => {
    mockWhitelistEntryFindMany.mockResolvedValue([{ id: 'target', gameId: 'TargetPlayer', syncState: 'LOCAL_ONLY' }]);
    mockNitradoJobFindMany.mockResolvedValueOnce([
      { id: 'add-pending', operation: 'WHITELIST_ADD', status: 'PENDING', payload: { gameId: 'TargetPlayer' } },
    ]);
    mockGetWhitelist.mockResolvedValue([{ identifier: 'TargetPlayer' }]);

    const result = await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(result.state).toBe('WAITING');
    expect(result.addJobsNeutralized).toBe(1);
    expect(mockNitradoJobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['add-pending'] }, status: 'PENDING' }),
      data: expect.objectContaining({ status: 'DONE', payload: {} }),
    }));
    expect(mockNitradoJobCreate).toHaveBeenCalledTimes(1);
  });

  it('finalizes local rows only after a fresh remote read confirms absence', async () => {
    const pendingRemove = {
      id: 'remove-pending', operation: 'WHITELIST_REMOVE', status: 'PENDING', payload: { gameId: 'TargetPlayer' },
    };
    mockWhitelistEntryFindMany.mockResolvedValue([{ id: 'target', gameId: 'TargetPlayer', syncState: 'PENDING_REMOVE' }]);
    mockWhitelistRequestFindMany.mockResolvedValue([{ id: 'request-1', gameId: 'TargetPlayer', requesterDiscordId: USER }]);
    mockNitradoJobFindMany
      .mockResolvedValueOnce([pendingRemove])
      .mockResolvedValueOnce([pendingRemove]);
    mockGetWhitelist.mockResolvedValue([]);

    const result = await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(result.state).toBe('DONE');
    expect(mockWhitelistEntryDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['target'] },
        guildId: GUILD,
        nitradoConnId: CONN,
        syncState: 'PENDING_REMOVE',
      },
    });
    expect(mockTxWhitelistRequestDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['request-1'] }, guildId: GUILD, nitradoConnId: CONN },
    });
    expect(mockNitradoJobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['remove-pending'] }, status: 'PENDING' }),
      data: expect.objectContaining({ status: 'DONE', payload: {} }),
    }));
    expect(mockWhitelistRequestDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, requesterDiscordId: USER },
    });
  });

  it('does not finalize while a fresh matching outbox job is running', async () => {
    mockWhitelistEntryFindMany.mockResolvedValue([{ id: 'target', gameId: 'TargetPlayer', syncState: 'PENDING_REMOVE' }]);
    mockNitradoJobFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'fresh-running', operation: 'WHITELIST_REMOVE', status: 'RUNNING', payload: { gameId: 'TargetPlayer' } },
      ]);
    mockGetWhitelist.mockResolvedValue([]);

    const result = await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(result.state).toBe('WAITING');
    expect(mockWhitelistEntryDeleteMany).not.toHaveBeenCalled();
    expect(mockWhitelistRequestDeleteMany).not.toHaveBeenCalled();
  });

  it('fails instead of silently replacing an exhausted DEAD remove while remote still contains the player', async () => {
    mockNitradoJobFindMany.mockResolvedValueOnce([
      { id: 'dead-remove', operation: 'WHITELIST_REMOVE', status: 'DEAD', payload: { gameId: 'TargetPlayer' } },
    ]);
    mockGetWhitelist.mockResolvedValue([{ identifier: 'TargetPlayer' }]);

    await expect(runLeaveWhitelistCleanupStep(GUILD, USER)).rejects.toThrow(/DEAD/);
    expect(mockNitradoJobCreate).not.toHaveBeenCalled();
    expect(mockWhitelistEntryDeleteMany).not.toHaveBeenCalled();
  });

  it('queries every player-owned source with exact guild and gameserver scope', async () => {
    await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(mockGameIdentityFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: GUILD, userDiscordId: USER, status: 'VERIFIED', identityHash: { not: null } },
    }));
    expect(mockPlayerSessionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { guildId: GUILD, nitradoConnId: CONN } }));
    expect(mockConnectionFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CONN, guildId: GUILD } }));
    expect(mockWhitelistEntryFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { guildId: GUILD, nitradoConnId: CONN } }));
    expect(mockWhitelistRequestFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { guildId: GUILD, nitradoConnId: CONN } }));
    expect(mockNitradoJobFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ guildId: GUILD, nitradoConnId: CONN }) }));
    expect(OTHER_GUILD).not.toBe(GUILD);
  });

  it('removes requester history only after every linked gameserver reports DONE', async () => {
    mockGameIdentityFindMany.mockResolvedValue([
      { nitradoConnId: 'conn-a', identityHash: LINK_HASH },
      { nitradoConnId: 'conn-b', identityHash: LINK_HASH },
    ]);
    mockPlayerSessionFindMany.mockResolvedValue([{ gameId: GUID, playerName: 'TargetPlayer' }]);
    mockConnectionFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id, encryptedToken: 'enc', nitradoServerId: `service-${where.id}`, status: 'ACTIVE',
    }));
    mockGetWhitelist
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ identifier: 'TargetPlayer' }]);

    const result = await runLeaveWhitelistCleanupStep(GUILD, USER);

    expect(result.state).toBe('WAITING');
    expect(mockWhitelistRequestDeleteMany).not.toHaveBeenCalled();
  });
});
