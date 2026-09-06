import { prepareNitradoRemoteStateForServiceRebind } from '../../src/modules/nitrado/rebindOutboxLifecycle';
import type { NitradoOutboxClient } from '../../src/modules/nitrado/outboxLock';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };

function makeClient(args: {
  runningSequence?: Array<{ id: string } | null>;
  fences?: Array<{ banId: string }>;
  pendingAdds?: Array<{ id: string; payload: unknown }>;
} = {}) {
  const runningSequence = [...(args.runningSequence ?? [null, null])];
  const fences = args.fences ?? [];
  const pendingAdds = args.pendingAdds ?? [];
  const queryRaw = jest.fn(async () => []);
  const findFirst = jest.fn(async () => runningSequence.shift() ?? null);
  const findManyJobs = jest.fn(async (query: any) => query?.where?.operation === 'SERVER_BAN_ADD' ? pendingAdds : []);
  const updateJobs = jest.fn(async (query: any) => ({
    count: Array.isArray(query?.where?.id?.in) ? query.where.id.in.length : 3,
  }));
  const updateWhitelist = jest.fn(async () => ({ count: 4 }));
  const updateBans = jest.fn(async (query: any) => ({ count: query?.where?.id?.in ? query.where.id.in.length : 2 }));
  const updateZones = jest.fn(async () => ({ count: 1 }));
  const updateEvents = jest.fn(async () => ({ count: 2 }));
  const findFences = jest.fn(async () => fences);
  const updateFences = jest.fn(async () => ({ count: fences.length }));
  const deleteSecrets = jest.fn(async () => ({ count: fences.length }));
  const client = {
    $queryRawUnsafe: queryRaw,
    nitradoJob: {
      findMany: findManyJobs,
      create: jest.fn(async () => ({})),
      findFirst,
      updateMany: updateJobs,
    },
    whitelistEntry: { updateMany: updateWhitelist },
    serverBanEntry: { updateMany: updateBans },
    serverBanRemoteIdentity: { deleteMany: deleteSecrets },
    radarZone: { updateMany: updateZones },
    radarZoneEvent: { updateMany: updateEvents },
    radarAutoBanBanFence: { findMany: findFences, updateMany: updateFences },
  } as unknown as NitradoOutboxClient;
  return {
    client,
    queryRaw,
    findFirst,
    findManyJobs,
    updateJobs,
    updateWhitelist,
    updateBans,
    updateZones,
    updateEvents,
    findFences,
    updateFences,
    deleteSecrets,
  };
}

const BASE_RADAR_COUNTS = {
  radarAutoBanZonesDisabled: 1,
  radarAutoBanEventsSkipped: 2,
  radarBanFencesInvalidated: 0,
  radarBansDeactivated: 0,
  radarBanSecretsDeleted: 0,
  radarBanAddJobsCancelled: 0,
};

describe('Nitrado-1U service-rebind outbox lifecycle', () => {
  it('takes the radar fence before invalidating observations and only then enters the outbox barrier', async () => {
    const { client, queryRaw, findFirst, updateWhitelist, updateBans, updateZones, updateEvents } = makeClient();

    await prepareNitradoRemoteStateForServiceRebind(client, SCOPE);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.any(Number),
      expect.any(Number),
    );
    expect(queryRaw).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.any(Number),
      expect.any(Number),
    );
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(updateZones.mock.invocationCallOrder[0]);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(updateEvents.mock.invocationCallOrder[0]);
    expect(updateWhitelist.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[1]);
    expect(updateBans.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[1]);
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(findFirst.mock.invocationCallOrder[0]);
  });

  it('returns busy after all local invalidations when a remote mutation is RUNNING so caller rolls back the whole transaction', async () => {
    const { client, updateJobs, updateWhitelist, updateBans, updateZones, updateEvents } = makeClient({ runningSequence: [{ id: 'running-1' }] });

    await expect(prepareNitradoRemoteStateForServiceRebind(client, SCOPE)).resolves.toEqual({
      busy: true,
      cancelledJobs: 0,
      whitelistReset: 4,
      banRemoteStateReset: 2,
      ...BASE_RADAR_COUNTS,
    });

    expect(updateJobs).not.toHaveBeenCalled();
    expect(updateWhitelist).toHaveBeenCalledTimes(1);
    expect(updateBans).toHaveBeenCalledTimes(1);
    expect(updateZones).toHaveBeenCalledTimes(1);
    expect(updateEvents).toHaveBeenCalledTimes(1);
  });

  it('preserves manual SERVER_BAN_ADD but cancels radar-fenced ADDs and deactivates their old-generation bans', async () => {
    const { client, updateJobs, findManyJobs, updateBans, updateFences, deleteSecrets } = makeClient({
      fences: [{ banId: 'radar-ban-1' }],
      pendingAdds: [
        { id: 'manual-add', payload: { banId: 'manual-ban', encryptedIdentifier: 'enc-a' } },
        { id: 'radar-add', payload: { banId: 'radar-ban-1', encryptedIdentifier: 'enc-b' } },
      ],
    });

    await expect(prepareNitradoRemoteStateForServiceRebind(client, SCOPE)).resolves.toEqual({
      busy: false,
      cancelledJobs: 4,
      whitelistReset: 4,
      banRemoteStateReset: 2,
      radarAutoBanZonesDisabled: 1,
      radarAutoBanEventsSkipped: 2,
      radarBanFencesInvalidated: 1,
      radarBansDeactivated: 1,
      radarBanSecretsDeleted: 1,
      radarBanAddJobsCancelled: 1,
    });

    expect(findManyJobs).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ operation: 'SERVER_BAN_ADD', status: 'PENDING' }),
      select: { id: true, payload: true },
    }));
    expect(updateJobs).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['radar-add'] }, operation: 'SERVER_BAN_ADD' }),
      data: expect.objectContaining({ status: 'DONE', payload: {} }),
    }));
    expect(updateJobs).not.toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: expect.arrayContaining(['manual-add']) } }),
    }));
    expect(updateBans).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['radar-ban-1'] }, active: true }),
      data: expect.objectContaining({ active: false, appliedRemotely: false, liftedAt: expect.any(Date) }),
    }));
    expect(updateFences).toHaveBeenCalledWith(expect.objectContaining({ data: { invalidatedAt: expect.any(Date) } }));
    expect(deleteSecrets).toHaveBeenCalledWith({ where: { banId: { in: ['radar-ban-1'] } } });
  });

  it('disables inherited auto-ban zones and skips all pending/retry/processing events on every real service rebind', async () => {
    const { client, updateZones, updateEvents } = makeClient();

    await prepareNitradoRemoteStateForServiceRebind(client, SCOPE);

    expect(updateZones).toHaveBeenCalledWith({
      where: { guildId: 'guild-a', nitradoConnId: 'conn-a', autoBanEnabled: true },
      data: {
        autoBanEnabled: false,
        autoBanEnabledAt: null,
        autoBanAuthorizedBy: null,
        version: { increment: 1 },
      },
    });
    expect(updateEvents).toHaveBeenCalledWith({
      where: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-a',
        autoBanStatus: { in: ['PENDING', 'PROCESSING', 'RETRY'] },
      },
      data: {
        autoBanStatus: 'SKIPPED',
        autoBanProcessedAt: expect.any(Date),
        autoBanLeaseUntil: null,
        autoBanLastError: 'AUTOBAN_SERVICE_REBIND',
      },
    });
  });

  it('detects PENDING-to-RUNNING claim race after cleanup so caller rolls back all earlier changes', async () => {
    const { client, updateJobs, updateWhitelist, updateBans } = makeClient({ runningSequence: [null, { id: 'raced-1' }] });

    await expect(prepareNitradoRemoteStateForServiceRebind(client, SCOPE)).resolves.toEqual({
      busy: true,
      cancelledJobs: 3,
      whitelistReset: 4,
      banRemoteStateReset: 2,
      ...BASE_RADAR_COUNTS,
    });

    expect(updateJobs).toHaveBeenCalledTimes(1);
    expect(updateWhitelist).toHaveBeenCalledTimes(1);
    expect(updateBans).toHaveBeenCalledTimes(1);
  });
});
