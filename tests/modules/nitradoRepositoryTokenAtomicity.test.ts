const connectionFindUnique = jest.fn();
const connectionUpdateMany = jest.fn();
const healthUpdateMany = jest.fn();
const transaction = jest.fn();
const encrypt = jest.fn();

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

import { updateToken } from '../../src/modules/nitrado/repository';

const GUILD = '123456789012345678';
const ROW = {
  id: 'conn-1',
  guildId: GUILD,
  slot: 1,
  alias: 'Main',
  alias5: 'ABCDE',
  nitradoServerId: null,
  status: 'ACTIVE' as const,
  addedByDiscordId: '223456789012345678',
  createdAt: new Date('2026-08-18T08:00:00.000Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  encrypt.mockReturnValue('encrypted-new-token');
  connectionUpdateMany.mockResolvedValue({ count: 1 });
  healthUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (ops: Array<Promise<unknown>>) => Promise.all(ops));
  connectionFindUnique
    .mockResolvedValueOnce({ id: ROW.id })
    .mockResolvedValueOnce(ROW);
});

describe('Nitrado-1A repository token rotation atomicity', () => {
  it('persists token + both service mirrors reset in the same transaction after a proven mismatch', async () => {
    await expect(updateToken(GUILD as never, 1, 'new-valid-token', { resetServiceId: true }))
      .resolves.toEqual(expect.objectContaining({ id: 'conn-1', nitradoServerId: null }));

    expect(encrypt).toHaveBeenCalledWith('new-valid-token', 'test-encryption-key');
    expect(connectionUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, slot: 1, id: ROW.id },
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
    expect(transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('does not clear service mirrors when the new token still owns the service', async () => {
    connectionFindUnique
      .mockReset()
      .mockResolvedValueOnce({ id: ROW.id })
      .mockResolvedValueOnce({ ...ROW, nitradoServerId: '12345' });

    await updateToken(GUILD as never, 1, 'new-valid-token', { resetServiceId: false });

    const data = connectionUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('nitradoServerId');
    expect(data).not.toHaveProperty('serviceId');
  });

  it('returns null without any token write when the slot disappeared before rotation', async () => {
    connectionFindUnique.mockReset().mockResolvedValueOnce(null);

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', { resetServiceId: true })).resolves.toBeNull();

    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
