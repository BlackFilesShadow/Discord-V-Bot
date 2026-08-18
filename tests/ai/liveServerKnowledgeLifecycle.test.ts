import {
  liveServerBindingVersionFromSourceVersion,
  liveServerConnectionIdFromSourceRef,
  liveServerSourceVersion,
} from '../../src/modules/ai/liveServerKnowledgeConstants';
import {
  deleteGeneratedLiveServerKnowledge,
  type LiveServerKnowledgeLifecycleClient,
} from '../../src/modules/ai/liveServerKnowledgeLifecycle';

const GUILD = 'guild-1';
const CONN = 'conn/1';

function lifecycleClient() {
  const callOrder: string[] = [];
  const scopeFindMany = jest.fn(async () => [{ knowledgeId: 'mirror' }, { knowledgeId: 'owner' }]);
  const systemFindMany = jest.fn(async () => [{ id: 'mirror' }]);
  const provenanceFindMany = jest.fn(async () => [{ knowledgeId: 'mirror' }, { knowledgeId: 'owner' }]);
  const provenanceDeleteMany = jest.fn(async () => { callOrder.push('provenance'); return { count: 1 }; });
  const scopeDeleteMany = jest.fn(async () => { callOrder.push('scope'); return { count: 1 }; });
  const knowledgeDeleteMany = jest.fn(async () => { callOrder.push('knowledge'); return { count: 1 }; });
  return {
    client: {
      guildKnowledgeScope: { findMany: scopeFindMany, deleteMany: scopeDeleteMany },
      guildKnowledge: { findMany: systemFindMany, deleteMany: knowledgeDeleteMany },
      guildKnowledgeProvenance: { findMany: provenanceFindMany, deleteMany: provenanceDeleteMany },
    } as LiveServerKnowledgeLifecycleClient,
    callOrder,
    scopeFindMany,
    systemFindMany,
    provenanceFindMany,
    provenanceDeleteMany,
    scopeDeleteMany,
    knowledgeDeleteMany,
  };
}

describe('Nitrado-1S live-server lifecycle primitives', () => {
  it('serializes and parses only safe binding-versioned source versions', () => {
    const version = liveServerSourceVersion(3, 'snap-1', 'a'.repeat(64));
    expect(version).toMatch(/^b3:snap-1:/);
    expect(version.length).toBeLessThanOrEqual(100);
    expect(liveServerBindingVersionFromSourceVersion(version)).toBe(3);
    expect(liveServerBindingVersionFromSourceVersion(`snap-1:${'a'.repeat(64)}`)).toBeNull();
    expect(liveServerBindingVersionFromSourceVersion('b-1:snap-1:aaaaaaaa')).toBeNull();
    expect(() => liveServerSourceVersion(-1, 'snap-1', 'a'.repeat(64))).toThrow();
    expect(() => liveServerSourceVersion(1, 'snap:bad', 'a'.repeat(64))).toThrow();
  });

  it('round-trips the exact encoded connection from mirror source refs', () => {
    expect(liveServerConnectionIdFromSourceRef('nitrado-mirror://conn%2F1/types.xml')).toBe(CONN);
    expect(liveServerConnectionIdFromSourceRef('nitrado-mirror://conn-2/types.xml')).toBe('conn-2');
    expect(liveServerConnectionIdFromSourceRef('owner://conn-1/types.xml')).toBeNull();
    expect(liveServerConnectionIdFromSourceRef('nitrado-mirror://%ZZ/types.xml')).toBeNull();
  });

  it('deletes only the exact system+scope+LIVE_SERVER intersection in FK-safe order', async () => {
    const mocks = lifecycleClient();
    await expect(deleteGeneratedLiveServerKnowledge(mocks.client, GUILD, CONN)).resolves.toBe(1);

    expect(mocks.scopeFindMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN },
      select: { knowledgeId: true },
    });
    expect(mocks.systemFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: GUILD,
        createdBy: 'SYSTEM:AI14_NITRADO_SNAPSHOT',
        id: { in: ['mirror', 'owner'] },
      }),
    }));
    expect(mocks.provenanceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: GUILD,
        sourceKind: 'LIVE_SERVER',
        sourceRef: { startsWith: 'nitrado-mirror://conn%2F1/' },
      }),
    }));
    expect(mocks.knowledgeDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, id: { in: ['mirror'] }, createdBy: 'SYSTEM:AI14_NITRADO_SNAPSHOT' },
    });
    expect(mocks.callOrder).toEqual(['provenance', 'scope', 'knowledge']);
  });
});
