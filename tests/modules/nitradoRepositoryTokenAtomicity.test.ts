const connectionFindUnique = jest.fn();
const connectionFindFirst = jest.fn();
const txConnectionFindFirst = jest.fn();
const connectionUpdateMany = jest.fn();
const healthUpdateMany = jest.fn();
const bindingFindUnique = jest.fn();
const bindingCreate = jest.fn();
const bindingUpdate = jest.fn();
const profileUpdateMany = jest.fn();
const scopeFindMany = jest.fn();
const scopeDeleteMany = jest.fn();
const provenanceFindMany = jest.fn();
const provenanceDeleteMany = jest.fn();
const knowledgeFindMany = jest.fn();
const knowledgeDeleteMany = jest.fn();
const transaction = jest.fn();
const encrypt = jest.fn();
const acquireConfigLock = jest.fn();
const releaseConfigLock = jest.fn();
const prepareRebindLifecycle = jest.fn();

const tx = {
  nitradoConnection: { findFirst: txConnectionFindFirst, updateMany: connectionUpdateMany },
  nitradoValidationHealth: { updateMany: healthUpdateMany },
  nitradoAdmBindingState: {
    findUnique: bindingFindUnique,
    create: bindingCreate,
    update: bindingUpdate,
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
    },
    nitradoValidationHealth: { updateMany: healthUpdateMany },
    nitradoAdmBindingState: {
      findUnique: bindingFindUnique,
      create: bindingCreate,
      update: bindingUpdate,
    },
    nitradoAdmProfileConfig: { updateMany: profileUpdateMany },
    guildKnowledgeScope: { findMany: scopeFindMany, deleteMany: scopeDeleteMany },
    guildKnowledgeProvenance: { findMany: provenanceFindMany, deleteMany: provenanceDeleteMany },
    guildKnowledge: { findMany: knowledgeFindMany, deleteMany: knowledgeDeleteMany },
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

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => acquireConfigLock(...args),
}));

jest.mock('../../src/modules/nitrado/rebindOutboxLifecycle', () => ({
  prepareNitradoRemoteStateForServiceRebind: (...args: unknown[]) => prepareRebindLifecycle(...args),
}));

import {
  NitradoConnectionBusyError,
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
  prepareRebindLifecycle.mockResolvedValue({
    busy: false,
    cancelledJobs: 0,
    whitelistReset: 0,
    banRemoteStateReset: 0,
  });
  encrypt.mockReturnValue('encrypted-new-token');
  connectionUpdateMany.mockResolvedValue({ count: 1 });
  healthUpdateMany.mockResolvedValue({ count: 1 });
  txConnectionFindFirst.mockResolvedValue({ nitradoServerId: '12345' });
  bindingFindUnique.mockResolvedValue({
    guildId: GUILD,
    nitradoConnId: CONN_ID,
    bindingVersion: 0,
    currentServiceId: '12345',
  });
  bindingCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  bindingUpdate.mockResolvedValue({
    guildId: GUILD,
    nitradoConnId: CONN_ID,
    bindingVersion: 1,
    currentServiceId: null,
  });
  profileUpdateMany.mockResolvedValue({ count: 1 });
  scopeFindMany.mockResolvedValue([]);
  scopeDeleteMany.mockResolvedValue({ count: 0 });
  provenanceFindMany.mockResolvedValue([]);
  provenanceDeleteMany.mockResolvedValue({ count: 0 });
  knowledgeFindMany.mockResolvedValue([]);
  knowledgeDeleteMany.mockResolvedValue({ count: 0 });
  transaction.mockImplementation(async (cb: (client: typeof tx) => unknown) => cb(tx));
  connectionFindUnique.mockResolvedValue({ id: CONN_ID });
  connectionFindFirst.mockResolvedValue(ROW);
  releaseConfigLock.mockResolvedValue(undefined);
  acquireConfigLock.mockResolvedValue({ release: releaseConfigLock });
});

describe('Nitrado-1A/1C/1M/1S/1U repository token rotation atomicity', () => {
  it('persists token + service reset only after rebind lifecycle, LIVE_SERVER purge and binding rollover', async () => {
    scopeFindMany.mockResolvedValueOnce([{ knowledgeId: 'mirror-1' }]);
    knowledgeFindMany.mockResolvedValueOnce([{ id: 'mirror-1' }]);
    provenanceFindMany.mockResolvedValueOnce([{ knowledgeId: 'mirror-1' }]);

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).resolves.toEqual(expect.objectContaining({
      id: CONN_ID,
      nitradoServerId: null,
      updatedAt: NEW_VERSION,
    }));

    expect(acquireConfigLock).toHaveBeenCalledWith(CONN_ID);
    expect(prepareRebindLifecycle).toHaveBeenCalledWith(tx, { guildId: GUILD, nitradoConnId: CONN_ID });
    expect(prepareRebindLifecycle.mock.invocationCallOrder[0]).toBeLessThan(connectionUpdateMany.mock.invocationCallOrder[0]);
    expect(encrypt).toHaveBeenCalledWith('new-valid-token', 'test-encryption-key');
    expect(txConnectionFindFirst).toHaveBeenCalledWith({
      where: { guildId: GUILD, slot: 1, id: CONN_ID, updatedAt: VERSION },
      select: { nitradoServerId: true },
    });
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
    expect(provenanceDeleteMany).toHaveBeenCalledWith({
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
      data: { currentServiceId: null, bindingVersion: { increment: 1 } },
    }));
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN_ID },
      data: { lastVerifiedAt: null, lastError: null },
    });
    expect(healthUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: GUILD, nitradoConnId: CONN_ID },
      data: expect.objectContaining({ failureCount: 0, lastErrorMessage: null }),
    }));
    expect(connectionFindFirst).toHaveBeenCalledWith({
      where: { id: CONN_ID, guildId: GUILD, slot: 1 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed before token/service reset when rebind lifecycle sees a RUNNING mutation', async () => {
    prepareRebindLifecycle.mockResolvedValueOnce({
      busy: true,
      cancelledJobs: 0,
      whitelistReset: 0,
      banRemoteStateReset: 0,
    });

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoConnectionBusyError);

    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(bindingUpdate).not.toHaveBeenCalled();
    expect(healthUpdateMany).not.toHaveBeenCalled();
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed without any DB mutation while a worker owns the connection lock', async () => {
    acquireConfigLock.mockResolvedValue(null);

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoConnectionBusyError);

    expect(transaction).not.toHaveBeenCalled();
    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(healthUpdateMany).not.toHaveBeenCalled();
    expect(releaseConfigLock).not.toHaveBeenCalled();
  });

  it('does not run rebind lifecycle, roll binding or purge LIVE_SERVER knowledge when token keeps the service', async () => {
    connectionFindFirst.mockResolvedValue({ ...ROW, nitradoServerId: '12345' });

    await updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: false,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    });

    const data = connectionUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('nitradoServerId');
    expect(data).not.toHaveProperty('serviceId');
    expect(prepareRebindLifecycle).not.toHaveBeenCalled();
    expect(bindingFindUnique).not.toHaveBeenCalled();
    expect(bindingUpdate).not.toHaveBeenCalled();
    expect(profileUpdateMany).not.toHaveBeenCalled();
    expect(scopeFindMany).not.toHaveBeenCalled();
    expect(provenanceDeleteMany).not.toHaveBeenCalled();
    expect(knowledgeDeleteMany).not.toHaveBeenCalled();
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed before lock acquisition if slot was deleted and recreated under another connection id', async () => {
    connectionFindUnique.mockResolvedValue({ id: OTHER_CONN_ID });

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).rejects.toBeInstanceOf(NitradoSlotVersionConflictError);

    expect(acquireConfigLock).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(healthUpdateMany).not.toHaveBeenCalled();
  });

  it('fails closed on stale validated slot version and still releases connection lock', async () => {
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
    expect(releaseConfigLock).toHaveBeenCalledTimes(1);
  });

  it('returns null without lock or token write when slot disappeared before rotation', async () => {
    connectionFindUnique.mockResolvedValue(null);

    await expect(updateToken(GUILD as never, 1, 'new-valid-token', {
      resetServiceId: true,
      expectedId: CONN_ID as never,
      expectedUpdatedAt: VERSION,
    })).resolves.toBeNull();

    expect(acquireConfigLock).not.toHaveBeenCalled();
    expect(connectionUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
