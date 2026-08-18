const connectionFindUnique = jest.fn();
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
const VERSION = new Date('2026-08-18T08:00:00.000Z');
const NEW_VERSION = new Date('2026-08-18T08:01:00.000Z');
const ROW = {
  id: 'conn-1',
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
  connectionFindUnique
    .mockResolvedValueOnce({ id: ROW.id })
    .mockResolvedValueOnce(ROW);
});

describe('Nitrado-1A repository token rotation atomicity', () => {
  it('persists token + both service mirrors reset under the exact validated updatedAt snapshot', async () => {
    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedUpdatedAt: VERSION,
    })).resolves.toEqual(expect.objectContaining({
      id: 'conn-1',
      nitradoServerId: null,
      updatedAt: NEW_VERSION,
    }));

    expect(encrypt).toHaveBeenCalledWith('new-valid-token', 'test-encryption-key');
    expect(connectionUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, slot: 1, id: ROW.id, updatedAt: VERSION },
      data: {
        encryptedToken: 'encrypted-new-token',
        status: 'ACTIVE',
        lastErrorMessage: null,
        nitradoServerId: null,
        serviceId: null,
      },
    });
    expect(healthUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: GUILD, nitradoConnId: ROW.id },
      data: expect.objectContaining({ failureCount: 0, lastErrorMessage: null }),
    }));
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('does not clear service mirrors when the new token still owns the service', async () => {
    connectionFindUnique
      .mockReset()
      .mockResolvedValueOnce({ id: ROW.id })
      .mockResolvedValueOnce({ ...ROW, nitradoServerId: '12345' });

    await updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: false,
      expectedUpdatedAt: VERSION,
    });

    const data = connectionUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('nitradoServerId');
    expect(data).not.toHaveProperty('serviceId');
  });

  it('fails closed on a stale validated slot version and does not reset validation health', async () => {
    connectionUpdateMany.mockResolvedValue({ count: 0 });

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoSlotVersionConflictError);

    expect(connectionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ updatedAt: VERSION }),
    }));
    expect(healthUpdateMany).not.toHaveBeenCalled();
    expect(connectionFindUnique).toHaveBeenCalledTimes(1);
  });

  it('returns null without any token write when the slot disappeared before rotation', async () => {
    connectionFindUnique.mockReset().mockResolvedValueOnce(null);

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedUpdatedAt: VERSION,
    })).resolves.toBeNull();

    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
