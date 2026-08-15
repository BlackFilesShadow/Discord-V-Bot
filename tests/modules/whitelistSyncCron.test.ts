process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= '123456789012345678';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const connectionFindMany = jest.fn();
const whitelistFindMany = jest.fn();
const whitelistUpdateMany = jest.fn(async () => ({ count: 1 }));
const whitelistDeleteMany = jest.fn(async () => ({ count: 1 }));
const jobFindMany = jest.fn();
const jobCreate = jest.fn(async () => ({}));
const getWhitelist = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: connectionFindMany },
    whitelistEntry: {
      findMany: whitelistFindMany,
      updateMany: whitelistUpdateMany,
      deleteMany: whitelistDeleteMany,
    },
    nitradoJob: { findMany: jobFindMany, create: jobCreate },
  },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: jest.fn(() => 'decrypted-token'),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ getWhitelist })),
}));

import { runWhitelistSyncOnce } from '../../src/modules/whitelist/whitelistSyncCron';

const conn = {
  id: 'conn-1',
  guildId: '123456789012345678',
  encryptedToken: 'ciphertext',
  nitradoServerId: '10428225',
};

beforeEach(() => {
  jest.clearAllMocks();
  connectionFindMany.mockResolvedValue([conn]);
  whitelistFindMany.mockResolvedValue([]);
  whitelistUpdateMany.mockResolvedValue({ count: 1 });
  whitelistDeleteMany.mockResolvedValue({ count: 1 });
  jobFindMany.mockResolvedValue([]);
  jobCreate.mockResolvedValue({});
  getWhitelist.mockResolvedValue([]);
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
});

it('queued genau einen ADD-Job wenn lokaler Eintrag remote fehlt', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'LOCAL_ONLY' }]);
  getWhitelist.mockResolvedValue([]);

  await runWhitelistSyncOnce();

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

it('queued genau einen REMOVE-Job fuer einen remote-only Eintrag', async () => {
  whitelistFindMany.mockResolvedValue([]);
  getWhitelist.mockResolvedValue([{ identifier: 'Ghost' }]);

  await runWhitelistSyncOnce();

  expect(jobCreate).toHaveBeenCalledTimes(1);
  expect(jobCreate).toHaveBeenCalledWith({
    data: {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      operation: 'WHITELIST_REMOVE',
      payload: { gameId: 'Ghost' },
    },
  });
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
      payload: { gameId: 'Alice' },
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

it('dupliziert keinen bereits PENDING/RUNNING identischen Job', async () => {
  whitelistFindMany.mockResolvedValue([{ id: 'wl-1', gameId: 'Alice', syncState: 'LOCAL_ONLY' }]);
  getWhitelist.mockResolvedValue([]);
  jobFindMany.mockResolvedValue([
    { operation: 'WHITELIST_ADD', payload: { gameId: 'Alice' } },
  ]);

  await runWhitelistSyncOnce();

  expect(jobCreate).not.toHaveBeenCalled();
});

it('isoliert einen Connection-Fehler und verarbeitet weitere Connections', async () => {
  connectionFindMany.mockResolvedValue([
    conn,
    { ...conn, id: 'conn-2', nitradoServerId: '10428226' },
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
  expect(whitelistUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 'wl-2', guildId: conn.guildId, nitradoConnId: 'conn-2' },
    data: expect.objectContaining({ syncState: 'SYNCED' }),
  }));
});
