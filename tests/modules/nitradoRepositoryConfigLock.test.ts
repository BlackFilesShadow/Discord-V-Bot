const connectionFindUnique = jest.fn();
const connectionFindFirst = jest.fn();
const connectionUpdateMany = jest.fn();
const scopeFindMany = jest.fn();
const scopeDeleteMany = jest.fn();
const provenanceFindMany = jest.fn();
const provenanceDeleteMany = jest.fn();
const knowledgeFindMany = jest.fn();
const knowledgeDeleteMany = jest.fn();
const healthDeleteMany = jest.fn();
const connectionDeleteMany = jest.fn();
const bindingFindUnique = jest.fn();
const bindingCreate = jest.fn();
const bindingUpdate = jest.fn();
const bindingDeleteMany = jest.fn();
const profileUpdateMany = jest.fn();
const transaction = jest.fn();
const acquireConfigLock = jest.fn();
const releaseConfigLock = jest.fn();

const mockTx = {
  nitradoConnection: {
    findFirst: connectionFindFirst,
    updateMany: connectionUpdateMany,
  },
  nitradoAdmBindingState: {
    findUnique: bindingFindUnique,
    create: bindingCreate,
    update: bindingUpdate,
    deleteMany: bindingDeleteMany,
  },
  nitradoAdmProfileConfig: { updateMany: profileUpdateMany },
  guildKnowledgeScope: { findMany: scopeFindMany, deleteMany: scopeDeleteMany },
  guildKnowledgeProvenance: { findMany: provenanceFindMany, deleteMany: provenanceDeleteMany },
  guildKnowledge: { findMany: knowledgeFindMany, deleteMany: knowledgeDeleteMany },
};

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
    guildKnowledgeProvenance: { findMany: provenanceFindMany, deleteMany: provenanceDeleteMany },
    guildKnowledge: { findMany: knowledgeFindMany, deleteMany: knowledgeDeleteMany },
    nitradoValidationHealth: { deleteMany: healthDeleteMany },
    nitradoAdmBindingState: {
      findUnique: bindingFindUnique,
      create: bindingCreate,
      update: bindingUpdate,
      deleteMany: bindingDeleteMany,
    },
    nitradoAdmProfileConfig: { updateMany: profileUpdateMany },
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
  provenanceFindMany.mockResolvedValue([]);
  provenanceDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  knowledgeFindMany.mockResolvedValue([]);
  knowledgeDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  healthDeleteMany.mockReturnValue(Promise.resolve({ count: 0 }));
  connectionDeleteMany.mockReturnValue(Promise.resolve({ count: 1 }));
  bindingFindUnique.mockResolvedValue({
    guildId: GUILD,
    nitradoConnId: CONN,
    bindingVersion: 0,
    currentServiceId: '123',
  });
  bindingCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  bindingUpdate.mockResolvedValue({
    guildId: GUILD,
    nitradoConnId: CONN,
    bindingVersion: 1,
    currentServiceId: '456',
  });
  bindingDeleteMany.mockReturnValue(Promise.resolve({ count: 1 }));
  profileUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (client: typeof mockTx) => Promise<unknown>)(mockTx);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  releaseConfigLock.mockResolvedValue(undefined);
  acquireConfigLock.mockResolvedValue({ release: releaseConfigLock });
});

describe('Nitrado-1C/1M/1S repository config/worker serialization', () => {
  it('updates service id only under the connection lock, purges stale mirror knowledge and advances the ADM binding', async () => {
    scopeFindMany.mockResolvedValueOnce([{ knowledgeId: 'mirror-1' }, { knowledgeId: 'owner-1' }]);
    knowledgeFindMany.mockResolvedValueOnce([{ id: 'mirror-1' }]);
    provenanceFindMany.mockResolvedValueOnce([{ knowledgeId: 'mirror-1' }]);

    await expect(updateServiceId(GUILD as never, 1, '456', {
      expectedId: CONN as never,
      expectedUpdatedAt: VERSION,
    })).resolves.toEqual(expect.objectContaining({ id: CONN }));

    expect(acquireConfigLock).toHaveBeenCalledWith(CONN);
    expect(connectionUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, slot: 1, id: CONN, updatedAt: VERSION },
      data: { nitradoServerId: '456', serviceId: '456' },
    });
    expect(provenanceDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, knowledgeId: { in: ['mirror-1'] } },
    });
    expect(scopeDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, knowledgeId: { in: ['mirror-1'] } },
    });
    expect(knowledgeDeleteMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        id: { in: ['mirror-1'] },
        createdBy: 'SYSTEM:AI14_NITRADO_SNAPSHOT',
      },
    });
    expect(bindingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentServiceId: '456', bindingVersion: { increment: 1 } },
    }));
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN },
      data: { lastVerifiedAt: null, lastError: null },
    });
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('does not advance the ADM binding or purge knowledge when the service id stays identical', async () => {
    await updateServiceId(GUILD as never, 1, '123', {
      expectedId: CONN as never,
      expectedUpdatedAt: VERSION,
    });

    expect(bindingUpdate).not.toHaveBeenCalled();
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(provenanceDeleteMany).not.toHaveBeenCalled();
    expect(knowledgeDeleteMany).not.toHaveBeenCalled();
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

  it('holds the lock through cleanup and removes the ADM binding state', async () => {
    await expect(deleteSlot(GUILD as never, 1)).resolves.toBe(CONN);

    expect(scopeFindMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN },
      select: { knowledgeId: true },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bindingDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD, nitradoConnId: CONN } });
    expect(connectionDeleteMany).toHaveBeenCalledWith({ where: { id: CONN, guildId: GUILD, slot: 1 } });
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });
});
