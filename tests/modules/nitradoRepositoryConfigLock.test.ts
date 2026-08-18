const connectionFindUnique = jest.fn();
const connectionFindFirst = jest.fn();
const connectionUpdateMany = jest.fn();
const scopeFindMany = jest.fn();
const scopeDeleteMany = jest.fn();
const provenanceDeleteMany = jest.fn();
const knowledgeDeleteMany = jest.fn();
const healthDeleteMany = jest.fn();
const connectionDeleteMany = jest.fn();
const transaction = jest.fn();
const acquireConfigLock = jest.fn();
const releaseConfigLock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: {
      findUnique: connectionFindUnique,
      findFirst: connectionFindFirst,
      updateMany: connectionUpdateMany,
      deleteMany: connectionDeleteMany,
    },
    guildKnowledgeScope: { findMany: scopeFindMany, deleteMany: scopeDeleteMany },
    guildKnowledgeProvenance: { deleteMany: provenanceDeleteMany },
    guildKnowledge: { deleteMany: knowledgeDeleteMany },
    nitradoValidationHealth: { deleteMany: healthDeleteMany },
    $transaction: transaction,
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: 'test-key' } },
}));

jest.mock('../../src/utils/security', () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => acquireConfigLock(...args),
}));

import {
  deleteSlot,
  NitradoConnectionBusyError,
  updateServiceId,
} from '../../src/modules/nitrado/repository';

const GUILD = '123456789012345678';
const CONN = 'c123456789012345678901234';
const VERSION = new Date('2026-08-18T10:00:00.000Z');
const ROW = {
  id: CONN,
  guildId: GUILD,
  slot: 1,
  alias: 'Main',
  alias5: 'ABCDE',
  nitradoServerId: '123',
  status: 'ACTIVE' as const,
  addedByDiscordId: '223456789012345678',
  createdAt: new Date('2026-08-18T09:00:00.000Z'),
  updatedAt: new Date('2026-08-18T10:01:00.000Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  connectionFindUnique.mockResolvedValue({ id: CONN });
  connectionFindFirst.mockResolvedValue(ROW);
  connectionUpdateMany.mockResolvedValue({ count: 1 });
  scopeFindMany.mockResolvedValue([]);
  scopeDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  provenanceDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  knowledgeDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  healthDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  connectionDeleteMany.mockReturnValue(Promise.resolve({ count: 1 }));
  transaction.mockResolvedValue([]);
  releaseConfigLock.mockResolvedValue(undefined);
  acquireConfigLock.mockResolvedValue({ release: releaseConfigLock });
});

describe('Nitrado-1C repository config/worker serialization', () => {
  it('updates service id only under the connection lock and releases it', async () => {
    await expect(updateServiceId(GUILD as never, 1, '456', {
      expectedId: CONN as never,
      expectedUpdatedAt: VERSION,
    })).resolves.toEqual(expect.objectContaining({ id: CONN }));

    expect(acquireConfigLock).toHaveBeenCalledWith(CONN);
    expect(connectionUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, slot: 1, id: CONN, updatedAt: VERSION },
      data: { nitradoServerId: '456', serviceId: '456' },
    });
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('does not write service id when a worker already owns the connection lock', async () => {
    acquireConfigLock.mockResolvedValue(null);

    await expect(updateServiceId(GUILD as never, 1, '456', {
      expectedId: CONN as never,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoConnectionBusyError);

    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(connectionFindFirst).not.toHaveBeenCalled();
  });

  it('does not begin slot cleanup when a worker already owns the connection lock', async () => {
    acquireConfigLock.mockResolvedValue(null);

    await expect(deleteSlot(GUILD as never, 1)).rejects.toBeInstanceOf(NitradoConnectionBusyError);

    expect(acquireConfigLock).toHaveBeenCalledWith(CONN);
    expect(connectionFindFirst).not.toHaveBeenCalled();
    expect(scopeFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('re-verifies exact id+guild+slot after lock acquisition before deleting', async () => {
    connectionFindFirst.mockResolvedValueOnce(null);

    await expect(deleteSlot(GUILD as never, 1)).resolves.toBeNull();

    expect(connectionFindFirst).toHaveBeenCalledWith({
      where: { id: CONN, guildId: GUILD, slot: 1 },
      select: { id: true },
    });
    expect(scopeFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('holds the lock through the complete slot cleanup transaction', async () => {
    await expect(deleteSlot(GUILD as never, 1)).resolves.toBe(CONN);

    expect(scopeFindMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN },
      select: { knowledgeId: true },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(connectionDeleteMany).toHaveBeenCalledWith({ where: { id: CONN, guildId: GUILD, slot: 1 } });
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });
});
