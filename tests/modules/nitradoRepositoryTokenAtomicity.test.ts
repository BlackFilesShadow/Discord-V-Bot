const connectionFindUnique = jest.fn();
const connectionFindFirst = jest.fn();
const connectionUpdateMany = jest.fn();
const healthUpdateMany = jest.fn();
const transaction = jest.fn();
const encrypt = jest.fn();

const tx = {
  nitradoConnection: { updateMany: connectionUpdateMany },
  nitradoValidationHealth: { updateMany: healthUpdateMany },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: {
      findUnique: connectionFindUnique,
      findFirst: connectionFindFirst,
      updateMany: connectionUpdateMany,
    },
    nitradoValidationHealth: { updateMany: healthUpdateMany },
    $transaction: transaction,
  },
}));

jest.mock('../../src/config', () => ({
  __esModule: true,
  config: { security: { encryptionKey: 'test-encryption-key' } },
}));

jest.mock('../../src/utils/security', () => ({
  encrypt: (...args: unknown[]) => encrypt(...args),
  decrypt: jest.fn(),
}));

import {
  NitradoSlotVersionConflictError,
  updateToken,
} from '../../src/modules/nitrado/repository';

const GUILD = '123456789012345678';
const CONN_ID = 'c123456789012345678901234';
const OTHER_CONN_ID = 'c987654321098765432109876';
const VERSION = new Date('2026-08-18T08:00:00.000Z');
const NEW_VERSION = new Date('2026-08-18T08:01:00.000Z');
const ROW = {
  id: CONN_ID,
  guildId: GUILD,
  slot: 1,
  alias: 'Main',
  alias5: 'ABCDE',
  nitradoServerId: null,
  status: 'ACTIVE' as const,
  addedByDiscordId: '223456789012345678',
  createdAt: new Date('2026-08-18T07:00:00.000Z'),
  updatedAt: NEW_VERSION,
};

beforeEach(() => {
  jest.clearAllMocks();
  encrypt.mockReturnValue('encrypted-new-token');
  connectionUpdateMany.mockResolvedValue({ count: 1 });
  healthUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => cb(tx));
  connectionFindUnique.mockResolvedValue({ id: CONN_ID });
  connectionFindFirst.mockResolvedValue(ROW);
});

describe('Nitrado-1A repository token rotation atomicity', () => {
  it('persists token + both service mirrors reset under the exact validated id+updatedAt snapshot', async () => {
    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).resolves.toEqual(expect.objectContaining({
      id: CONN_ID,
      nitradoServerId: null,
      updatedAt: NEW_VERSION,
    }));

    expect(encrypt).toHaveBeenCalledWith('new-valid-token', 'test-encryption-key');
    expect(connectionUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, slot: 1, id: CONN_ID, updatedAt: VERSION },
      data: {
        encryptedToken: 'encrypted-new-token',
        status: 'ACTIVE',
        lastErrorMessage: null,
        nitradoServerId: null,
        serviceId: null,
      },
    });
    expect(healthUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: GUILD, nitradoConnId: CONN_ID },
      data: expect.objectContaining({ failureCount: 0, lastErrorMessage: null }),
    }));
    expect(connectionFindFirst).toHaveBeenCalledWith({
      where: { id: CONN_ID, guildId: GUILD, slot: 1 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('does not clear service mirrors when the new token still owns the service', async () => {
    connectionFindFirst.mockResolvedValue({ ...ROW, nitradoServerId: '12345' });

    await updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: false,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    });

    const data = connectionUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('nitradoServerId');
    expect(data).not.toHaveProperty('serviceId');
  });

  it('fails closed before the transaction if the slot was deleted and recreated under a different connection id', async () => {
    connectionFindUnique.mockResolvedValue({ id: OTHER_CONN_ID });

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoSlotVersionConflictError);

    expect(transaction).not.toHaveBeenCalled();
    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(healthUpdateMany).not.toHaveBeenCalled();
  });

  it('fails closed on a stale validated slot version and does not reset validation health', async () => {
    connectionUpdateMany.mockResolvedValue({ count: 0 });

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoSlotVersionConflictError);

    expect(connectionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: CONN_ID, updatedAt: VERSION }),
    }));
    expect(healthUpdateMany).not.toHaveBeenCalled();
    expect(connectionFindFirst).not.toHaveBeenCalled();
  });

  it('returns null without any token write when the slot disappeared before rotation', async () => {
    connectionFindUnique.mockResolvedValue(null);

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).resolves.toBeNull();

    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
