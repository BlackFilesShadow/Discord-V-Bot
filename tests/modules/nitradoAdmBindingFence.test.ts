const connectionFindFirst = jest.fn();
const bindingFindUnique = jest.fn();
const bindingCreate = jest.fn();
const bindingUpdate = jest.fn();
const acquireLock = jest.fn();
const releaseLock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findFirst: connectionFindFirst },
    nitradoAdmBindingState: {
      findUnique: bindingFindUnique,
      create: bindingCreate,
      update: bindingUpdate,
    },
  },
}));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => acquireLock(...args),
}));

import {
  AdmBindingBusyError,
  AdmBindingStaleError,
  readCurrentAdmBinding,
  withFreshAdmBinding,
  type AdmBindingSnapshot,
} from '../../src/modules/nitrado/adm/bindingFence';

const SNAPSHOT: AdmBindingSnapshot = {
  id: 'conn-1',
  guildId: 'guild-1',
  encryptedToken: 'cipher-a',
  nitradoServerId: '123',
  bindingVersion: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  releaseLock.mockResolvedValue(undefined);
  acquireLock.mockResolvedValue({ release: releaseLock });
  connectionFindFirst.mockResolvedValue({
    id: SNAPSHOT.id,
    guildId: SNAPSHOT.guildId,
    encryptedToken: SNAPSHOT.encryptedToken,
    nitradoServerId: SNAPSHOT.nitradoServerId,
  });
  bindingFindUnique.mockResolvedValue({
    guildId: SNAPSHOT.guildId,
    nitradoConnId: SNAPSHOT.id,
    bindingVersion: SNAPSHOT.bindingVersion,
    currentServiceId: SNAPSHOT.nitradoServerId,
  });
  bindingCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
  bindingUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data);
});

describe('Nitrado-1M ADM binding fence', () => {
  it('liest Token, Service und Binding-Version unter demselben kurzen Connection-Lock', async () => {
    await expect(readCurrentAdmBinding({ id: SNAPSHOT.id, guildId: SNAPSHOT.guildId }))
      .resolves.toEqual(SNAPSHOT);

    expect(acquireLock).toHaveBeenCalledWith(SNAPSHOT.id);
    expect(connectionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: SNAPSHOT.id,
        guildId: SNAPSHOT.guildId,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      }),
    }));
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('failt bei Lock-Contention geschlossen ohne Binding-Read', async () => {
    acquireLock.mockResolvedValue(null);

    await expect(readCurrentAdmBinding({ id: SNAPSHOT.id, guildId: SNAPSHOT.guildId }))
      .rejects.toBeInstanceOf(AdmBindingBusyError);

    expect(connectionFindFirst).not.toHaveBeenCalled();
    expect(bindingFindUnique).not.toHaveBeenCalled();
  });

  it('verwirft einen stale Token/Service-Snapshot vor dem Side-Effect', async () => {
    connectionFindFirst.mockResolvedValue(null);
    const work = jest.fn(async () => 'written');

    await expect(withFreshAdmBinding(SNAPSHOT, work)).rejects.toBeInstanceOf(AdmBindingStaleError);

    expect(work).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('verwirft eine alte Binding-Version auch bei identischem Token und Service', async () => {
    bindingFindUnique.mockResolvedValue({
      guildId: SNAPSHOT.guildId,
      nitradoConnId: SNAPSHOT.id,
      bindingVersion: SNAPSHOT.bindingVersion + 1,
      currentServiceId: SNAPSHOT.nitradoServerId,
    });
    const work = jest.fn(async () => 'written');

    await expect(withFreshAdmBinding(SNAPSHOT, work)).rejects.toBeInstanceOf(AdmBindingStaleError);

    expect(work).not.toHaveBeenCalled();
  });

  it('fuehrt den Side-Effect nur fuer die identische ACTIVE-Bindung unter gehaltenem Lock aus', async () => {
    const work = jest.fn(async () => 'written');

    await expect(withFreshAdmBinding(SNAPSHOT, work)).resolves.toBe('written');

    expect(work).toHaveBeenCalledTimes(1);
    expect(work.mock.invocationCallOrder[0]).toBeLessThan(releaseLock.mock.invocationCallOrder[0]);
  });
});
