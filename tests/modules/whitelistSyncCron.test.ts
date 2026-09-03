process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const connectionFindMany = jest.fn();
const connectionFindFirst = jest.fn();
const whitelistFindMany = jest.fn();
const whitelistUpdateMany = jest.fn(async () => ({ count: 1 }));
const whitelistDeleteMany = jest.fn(async () => ({ count: 1 }));
const playerSessionFindMany = jest.fn();
const jobFindMany = jest.fn();
const jobCreate = jest.fn(async () => ({}));
const queryRaw = jest.fn(async () => []);
const transaction = jest.fn();
const getWhitelist = jest.fn();
const decryptMock = jest.fn((..._args: unknown[]) => 'decrypted-token');
const acquireConnectionLock = jest.fn();
const releaseConnectionLock = jest.fn(async () => undefined);

const tx = {
  $queryRawUnsafe: queryRaw,
  nitradoJob: { findMany: jobFindMany, create: jobCreate },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: queryRaw,
    $transaction: transaction,
    nitradoConnection: { findMany: connectionFindMany, findFirst: connectionFindFirst },
    whitelistEntry: {
      findMany: whitelistFindMany,
      updateMany: whitelistUpdateMany,
      deleteMany: whitelistDeleteMany,
    },
    playerSession: { findMany: playerSessionFindMany },
    nitradoJob: { findMany: jobFindMany, create: jobCreate },
  },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: (...args: unknown[]) => decryptMock(...args),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ getWhitelist })),
}));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => acquireConnectionLock(...args),
}));

import { runWhitelistSyncOnce } from '../../src/modules/whitelist/whitelistSyncCron';
import { WHITELIST_REMOVE_SAFETY_INTENT } from '../../src/modules/whitelist/whitelistJobSafety';

const conn = {
  id: 'conn-1',
  guildId: '123456789012345678',
  encryptedToken: 'ciphertext',
  nitradoServerId: '10428225',
};

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => cb(tx));
  connectionFindMany.mockResolvedValue([conn]);
  connectionFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (
    where.id === 'conn-2'
      ? { ...conn, id: 'conn-2', nitradoServerId: '10428226' }
      : conn
  ));
  acquireConnectionLock.mockImplementation(async () => ({ release: releaseConnectionLock }));
  releaseConnectionLock.mockResolvedValue(undefined);
  whitelistFindMany.mockResolvedValue([]);
  whitelistUpdateMany.mockResolvedValue({ count: 1 });
  whitelistDeleteMany.mockResolvedValue({ count: 1 });
  playerSessionFindMany.mockResolvedValue([]);
  jobFindMany.mockResolvedValue([]);
  jobCreate.mockResolvedValue({});
  queryRaw.mockResolvedValue([]);
  getWhitelist.mockResolvedValue([]);
  decryptMock.mockReturnValue('decrypted-token');
});

it('markiert einen lokal+remote vorhandenen Eintrag als SYNCED ohne Job', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'LOCAL_ONLY' }]);
  getWhitelist.mockResolvedValue([{ identifier: 'Alice' }]);

  await runWhitelistSyncOnce();

  expect(whitelistUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 'wl-1', guildId: conn.guildId, nitradoConnId: conn.id },
    data: expect.objectContaining({ syncState: 'SYNCED' }),
  }));
  expect(whitelistDeleteMany).not.toHaveBeenCalled();
  expect(jobCreate).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
});

it('queued genau einen ADD-Job unter dem cross-process Subject-Lock wenn lokal remote fehlt', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'LOCAL_ONLY' }]);
  getWhitelist.mockResolvedValue([]);

  await runWhitelistSyncOnce();

  expect(transaction).toHaveBeenCalledTimes(1);
  expect(queryRaw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1, $2)', expect.any(Number), expect.any(Number));
  expect(jobCreate).toHaveBeenCalledTimes(1);
  expect(jobCreate).toHaveBeenCalledWith({
    data: {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      operation: 'WHITELIST_ADD',
      payload: { gameId: 'Alice' },
    },
  });
});

it('behaelt einen remote-only Eintrag fail-closed und queued keinen REMOVE-Job', async () => {
  whitelistFindMany.mockResolvedValue([]);
  getWhitelist.mockResolvedValue([{ identifier: 'Ghost' }]);

  await runWhitelistSyncOnce();

  expect(jobCreate).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
});

it('behaelt bestaetigte Eintraege bei externer Abweichung und queued keinen Re-Add', async () => {
  const imported = { id: 'wl-imported', gameId: 'ImportedPlayer', syncState: 'SYNCED' as const };
  whitelistFindMany.mockResolvedValue([imported]);
  getWhitelist.mockResolvedValue([]);

  await runWhitelistSyncOnce();

  expect(whitelistDeleteMany).not.toHaveBeenCalled();
  expect(jobCreate).not.toHaveBeenCalled();
});

it('Produktionsregression: 0 lokale + 373 remote-only Eintraege erzeugen exakt 0 Loeschjobs', async () => {
  whitelistFindMany.mockResolvedValue([]);
  getWhitelist.mockResolvedValue(
    Array.from({ length: 373 }, (_, index) => ({ identifier: `Player-${index + 1}` })),
  );

  await runWhitelistSyncOnce();

  expect(jobCreate).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(whitelistDeleteMany).not.toHaveBeenCalled();
  expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
});

it('haelt PENDING_REMOVE lokal solange der Name remote noch existiert und queued REMOVE statt ADD', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'PENDING_REMOVE' }]);
  getWhitelist.mockResolvedValue([{ identifier: 'Alice' }]);

  await runWhitelistSyncOnce();

  expect(whitelistUpdateMany).not.toHaveBeenCalled();
  expect(whitelistDeleteMany).not.toHaveBeenCalled();
  expect(jobCreate).toHaveBeenCalledTimes(1);
  expect(jobCreate).toHaveBeenCalledWith({
    data: {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      operation: 'WHITELIST_REMOVE',
      payload: {
        gameId: 'Alice',
        removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT,
      },
    },
  });
});

it('finalisiert PENDING_REMOVE erst nachdem ein frischer Remote-Read die Entfernung bestaetigt', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'PENDING_REMOVE' }]);
  getWhitelist.mockResolvedValue([]);

  await runWhitelistSyncOnce();

  expect(whitelistDeleteMany).toHaveBeenCalledWith({
    where: {
      id: 'wl-1',
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      syncState: 'PENDING_REMOVE',
    },
  });
  expect(whitelistUpdateMany).not.toHaveBeenCalled();
  expect(jobCreate).not.toHaveBeenCalled();
});

it('dupliziert keinen bereits PENDING/RUNNING identischen Job und benoetigt dann keinen zweiten DB-Lock', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'LOCAL_ONLY' }]);
  getWhitelist.mockResolvedValue([]);
  jobFindMany.mockResolvedValue([
    { operation: 'WHITELIST_ADD', payload: { gameId: 'Alice' } },
  ]);

  await runWhitelistSyncOnce();

  expect(transaction).not.toHaveBeenCalled();
  expect(jobCreate).not.toHaveBeenCalled();
  expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
});

it('isoliert einen Connection-Fehler und verarbeitet weitere Connections', async () => {
  connectionFindMany.mockResolvedValue([
    { id: conn.id, guildId: conn.guildId },
    { id: 'conn-2', guildId: conn.guildId },
  ]);
  getWhitelist
    .mockRejectedValueOnce(new Error('temporary remote error'))
    .mockResolvedValueOnce([{ identifier: 'Bob' }]);
  whitelistFindMany.mockImplementation(async ({ where }: { where: { nitradoConnId: string } }) => {
    if (where.nitradoConnId === 'conn-2') return [{ id: 'wl-2', gameId: 'Bob', syncState: 'LOCAL_ONLY' }];
    return [];
  });

  await runWhitelistSyncOnce();

  expect(getWhitelist).toHaveBeenCalledTimes(2);
  expect(releaseConnectionLock).toHaveBeenCalledTimes(2);
  expect(whitelistUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 'wl-2', guildId: conn.guildId, nitradoConnId: 'conn-2' },
    data: expect.objectContaining({ syncState: 'SYNCED' }),
  }));
});

describe('Nitrado-1N — Whitelist-Reconcile Connection-Fence', () => {
  it('skippt fail-closed wenn Worker oder Konfigurationsmutation den Connection-Lock haelt', async () => {
    acquireConnectionLock.mockResolvedValueOnce(null);

    await runWhitelistSyncOnce();

    expect(acquireConnectionLock).toHaveBeenCalledWith(conn.id);
    expect(connectionFindFirst).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
    expect(getWhitelist).not.toHaveBeenCalled();
    expect(whitelistFindMany).not.toHaveBeenCalled();
    expect(jobCreate).not.toHaveBeenCalled();
    expect(releaseConnectionLock).not.toHaveBeenCalled();
  });

  it('verwendet nach Lockgewinn ausschliesslich den frischen Token-/Service-Snapshot', async () => {
    connectionFindMany.mockResolvedValue([{ id: conn.id, guildId: conn.guildId }]);
    connectionFindFirst.mockResolvedValueOnce({
      ...conn,
      encryptedToken: 'fresh-ciphertext',
      nitradoServerId: '99999999',
    });

    await runWhitelistSyncOnce();

    expect(connectionFindFirst).toHaveBeenCalledWith({
      where: {
        id: conn.id,
        guildId: conn.guildId,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
        serverSettings: { some: { whitelistActive: true } },
      },
      select: {
        id: true,
        guildId: true,
        encryptedToken: true,
        nitradoServerId: true,
      },
    });
    expect(decryptMock).toHaveBeenCalledWith('fresh-ciphertext', '0'.repeat(64));
    expect(getWhitelist).toHaveBeenCalledWith('99999999');
    expect(getWhitelist).not.toHaveBeenCalledWith(conn.nitradoServerId);
    expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
  });

  it('behandelt Delete/Deactivate/Whitelist-Off zwischen Scan und Lock als sauberen No-op', async () => {
    connectionFindFirst.mockResolvedValueOnce(null);

    await runWhitelistSyncOnce();

    expect(decryptMock).not.toHaveBeenCalled();
    expect(getWhitelist).not.toHaveBeenCalled();
    expect(whitelistFindMany).not.toHaveBeenCalled();
    expect(jobCreate).not.toHaveBeenCalled();
    expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
  });

  it('gibt den Connection-Lock auch bei Remote-Fehler garantiert frei', async () => {
    getWhitelist.mockRejectedValueOnce(new Error('temporary remote error'));

    await runWhitelistSyncOnce();

    expect(getWhitelist).toHaveBeenCalledTimes(1);
    expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
  });

  it('isoliert Lock-Infrastrukturfehler und laesst die naechste Connection weiterlaufen', async () => {
    connectionFindMany.mockResolvedValue([
      { id: conn.id, guildId: conn.guildId },
      { id: 'conn-2', guildId: conn.guildId },
    ]);
    acquireConnectionLock
      .mockRejectedValueOnce(new Error('pg unavailable'))
      .mockResolvedValueOnce({ release: releaseConnectionLock });
    getWhitelist.mockResolvedValueOnce([{ identifier: 'Bob' }]);
    whitelistFindMany.mockImplementation(async ({ where }: { where: { nitradoConnId: string } }) => {
      if (where.nitradoConnId === 'conn-2') return [{ id: 'wl-2', gameId: 'Bob', syncState: 'LOCAL_ONLY' }];
      return [];
    });

    await runWhitelistSyncOnce();

    expect(acquireConnectionLock).toHaveBeenCalledTimes(2);
    expect(getWhitelist).toHaveBeenCalledTimes(1);
    expect(getWhitelist).toHaveBeenCalledWith('10428226');
    expect(releaseConnectionLock).toHaveBeenCalledTimes(1);
    expect(whitelistUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wl-2', guildId: conn.guildId, nitradoConnId: 'conn-2' },
    }));
  });
});
