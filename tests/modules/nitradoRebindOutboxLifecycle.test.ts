import { prepareNitradoRemoteStateForServiceRebind } from '../../src/modules/nitrado/rebindOutboxLifecycle';
import type { NitradoOutboxClient } from '../../src/modules/nitrado/outboxLock';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };

function makeClient(runningSequence: Array<{ id: string } | null> = [null, null]) {
  const queryRaw = jest.fn(async () => []);
  const findFirst = jest.fn(async () => runningSequence.shift() ?? null);
  const updateJobs = jest.fn(async () => ({ count: 3 }));
  const updateWhitelist = jest.fn(async () => ({ count: 4 }));
  const updateBans = jest.fn(async () => ({ count: 2 }));
  const client = {
    $queryRawUnsafe: queryRaw,
    nitradoJob: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({})),
      findFirst,
      updateMany: updateJobs,
    },
    whitelistEntry: { updateMany: updateWhitelist },
    serverBanEntry: { updateMany: updateBans },
  } as unknown as NitradoOutboxClient;
  return { client, queryRaw, findFirst, updateJobs, updateWhitelist, updateBans };
}

describe('Nitrado-1U service-rebind outbox lifecycle', () => {
  it('row-locks remote observations before taking connection barrier, then inspects remote jobs', async () => {
    const { client, queryRaw, findFirst, updateWhitelist, updateBans } = makeClient();

    await prepareNitradoRemoteStateForServiceRebind(client, SCOPE);

    expect(queryRaw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.any(Number),
      expect.any(Number),
    );
    expect(updateWhitelist.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0]);
    expect(updateBans.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[0]);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
  });

  it('returns busy after observation resets when a mutation is RUNNING so caller can roll back whole transaction', async () => {
    const { client, updateJobs, updateWhitelist, updateBans } = makeClient([{ id: 'running-1' }]);

    await expect(prepareNitradoRemoteStateForServiceRebind(client, SCOPE)).resolves.toEqual({
      busy: true,
      cancelledJobs: 0,
      whitelistReset: 4,
      banRemoteStateReset: 2,
    });

    expect(updateJobs).not.toHaveBeenCalled();
    expect(updateWhitelist).toHaveBeenCalledTimes(1);
    expect(updateBans).toHaveBeenCalledTimes(1);
  });

  it('cancels only stale PENDING remote-state intents and preserves SERVER_BAN_ADD policy intent', async () => {
    const { client, updateJobs, updateWhitelist, updateBans } = makeClient([null, null]);

    await expect(prepareNitradoRemoteStateForServiceRebind(client, SCOPE)).resolves.toEqual({
      busy: false,
      cancelledJobs: 3,
      whitelistReset: 4,
      banRemoteStateReset: 2,
    });

    expect(updateJobs).toHaveBeenCalledWith({
      where: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-a',
        status: 'PENDING',
        operation: { in: ['WHITELIST_ADD', 'WHITELIST_REMOVE', 'SERVER_BAN_REMOVE'] },
      },
      data: {
        status: 'DONE',
        payload: {},
        lastError: 'Superseded by Nitrado service rebind before remote execution',
        updatedAt: expect.any(Date),
      },
    });
    expect(updateWhitelist).toHaveBeenCalledWith({
      where: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-a',
        syncState: { not: 'PENDING_REMOVE' },
      },
      data: { syncState: 'LOCAL_ONLY', lastSyncedAt: null },
    });
    expect(updateBans).toHaveBeenCalledWith({
      where: { guildId: 'guild-a', nitradoConnId: 'conn-a', appliedRemotely: true },
      data: { appliedRemotely: false },
    });
  });

  it('detects PENDING-to-RUNNING claim race after cleanup so caller rolls back all earlier changes', async () => {
    const { client, updateJobs, updateWhitelist, updateBans } = makeClient([null, { id: 'raced-1' }]);

    await expect(prepareNitradoRemoteStateForServiceRebind(client, SCOPE)).resolves.toEqual({
      busy: true,
      cancelledJobs: 3,
      whitelistReset: 4,
      banRemoteStateReset: 2,
    });

    expect(updateJobs).toHaveBeenCalledTimes(1);
    expect(updateWhitelist).toHaveBeenCalledTimes(1);
    expect(updateBans).toHaveBeenCalledTimes(1);
  });
});
