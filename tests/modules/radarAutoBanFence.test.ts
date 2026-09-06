import {
  clearRadarAutoBanFence,
  inspectRadarAutoBanFenceForRemoteAdd,
  upsertRadarAutoBanFence,
} from '../../src/modules/radar/banFence';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };
const FENCE = {
  banId: 'ban-1',
  radarEventId: 'radar-event-1',
  guildId: SCOPE.guildId,
  nitradoConnId: SCOPE.nitradoConnId,
  serviceId: 'service-1',
  bindingVersion: 3,
  invalidatedAt: null,
};

function makeClient() {
  const findFirst = jest.fn();
  const upsert = jest.fn();
  const deleteMany = jest.fn();
  const bindingFindUnique = jest.fn();
  const client = {
    radarAutoBanBanFence: { findFirst, upsert, deleteMany },
    nitradoAdmBindingState: { findUnique: bindingFindUnique },
  };
  return { client, findFirst, upsert, deleteMany, bindingFindUnique };
}

describe('Radar auto-ban generation fence', () => {
  it('preserves existing manual bans when no radar fence exists', async () => {
    const { client, findFirst, bindingFindUnique } = makeClient();
    findFirst.mockResolvedValue(null);

    await expect(inspectRadarAutoBanFenceForRemoteAdd(client, {
      ...SCOPE,
      banId: 'manual-ban',
      currentServiceId: 'service-new',
    })).resolves.toEqual({ kind: 'UNFENCED' });
    expect(bindingFindUnique).not.toHaveBeenCalled();
  });

  it('allows only the exact current service and ADM binding generation', async () => {
    const { client, findFirst, bindingFindUnique } = makeClient();
    findFirst.mockResolvedValue(FENCE);
    bindingFindUnique.mockResolvedValue({ currentServiceId: 'service-1', bindingVersion: 3 });

    await expect(inspectRadarAutoBanFenceForRemoteAdd(client, {
      ...SCOPE,
      banId: 'ban-1',
      currentServiceId: 'service-1',
    })).resolves.toEqual({ kind: 'ALLOW', fence: FENCE });
  });

  it.each([
    ['RADAR_FENCE_INVALIDATED', { ...FENCE, invalidatedAt: new Date('2026-09-06T01:00:00Z') }, 'service-1', null],
    ['RADAR_FENCE_SERVICE_MISMATCH', FENCE, 'service-2', null],
    ['RADAR_FENCE_BINDING_MISSING', FENCE, 'service-1', null],
    ['RADAR_FENCE_BINDING_SERVICE_MISMATCH', FENCE, 'service-1', { currentServiceId: 'service-2', bindingVersion: 3 }],
    ['RADAR_FENCE_BINDING_VERSION_MISMATCH', FENCE, 'service-1', { currentServiceId: 'service-1', bindingVersion: 4 }],
  ])('rejects %s fail-closed', async (code, fence, currentServiceId, binding) => {
    const { client, findFirst, bindingFindUnique } = makeClient();
    findFirst.mockResolvedValue(fence);
    bindingFindUnique.mockResolvedValue(binding);

    const result = await inspectRadarAutoBanFenceForRemoteAdd(client, {
      ...SCOPE,
      banId: 'ban-1',
      currentServiceId,
    });
    expect(result).toMatchObject({ kind: 'REJECT', code });
  });

  it('persists and clears the fence only in the exact guild+connection scope', async () => {
    const { client, upsert, deleteMany } = makeClient();
    upsert.mockResolvedValue({});
    deleteMany.mockResolvedValue({ count: 1 });

    await upsertRadarAutoBanFence(client, {
      ...SCOPE,
      banId: 'ban-1',
      radarEventId: 'radar-event-1',
      serviceId: 'service-1',
      bindingVersion: 3,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { banId: 'ban-1' },
      create: expect.objectContaining({ ...SCOPE, serviceId: 'service-1', bindingVersion: 3, invalidatedAt: null }),
    }));

    await expect(clearRadarAutoBanFence(client, SCOPE, 'ban-1')).resolves.toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { banId: 'ban-1', guildId: 'guild-a', nitradoConnId: 'conn-a' },
    });
  });
});
