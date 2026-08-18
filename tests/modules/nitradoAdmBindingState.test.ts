import {
  admBindingFileIdentity,
  admBindingFileIdentityPrefix,
  syncAdmBindingState,
  type AdmBindingStateClient,
} from '../../src/modules/nitrado/adm/bindingState';

const GUILD = '123456789012345678';
const CONN = 'conn-1';

function clientWith(existing: { bindingVersion: number; currentServiceId: string | null } | null) {
  const findUnique = jest.fn(async () => existing ? {
    guildId: GUILD,
    nitradoConnId: CONN,
    ...existing,
  } : null);
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data as never);
  const update = jest.fn(async ({ data }: { data: { currentServiceId: string | null } }) => ({
    guildId: GUILD,
    nitradoConnId: CONN,
    bindingVersion: (existing?.bindingVersion ?? 0) + 1,
    currentServiceId: data.currentServiceId,
  }));
  const deleteMany = jest.fn(async () => ({ count: 0 }));
  const scopeFindMany = jest.fn(async () => [{ knowledgeId: 'mirror-1' }, { knowledgeId: 'owner-1' }]);
  const scopeDeleteMany = jest.fn(async () => ({ count: 1 }));
  const knowledgeFindMany = jest.fn(async () => [{ id: 'mirror-1' }]);
  const knowledgeDeleteMany = jest.fn(async () => ({ count: 1 }));
  const provenanceFindMany = jest.fn(async () => [{ knowledgeId: 'mirror-1' }]);
  const provenanceDeleteMany = jest.fn(async () => ({ count: 1 }));
  return {
    client: {
      nitradoAdmBindingState: { findUnique, create, update, deleteMany },
      guildKnowledgeScope: { findMany: scopeFindMany, deleteMany: scopeDeleteMany },
      guildKnowledge: { findMany: knowledgeFindMany, deleteMany: knowledgeDeleteMany },
      guildKnowledgeProvenance: { findMany: provenanceFindMany, deleteMany: provenanceDeleteMany },
    } as unknown as AdmBindingStateClient,
    findUnique,
    create,
    update,
    scopeFindMany,
    scopeDeleteMany,
    knowledgeFindMany,
    knowledgeDeleteMany,
    provenanceFindMany,
    provenanceDeleteMany,
  };
}

describe('Nitrado-1M/1S ADM binding state', () => {
  it('initialisiert bestehende/neue Bindungen auf legacy-kompatibler Version 0', async () => {
    const { client, create, update, scopeFindMany } = clientWith(null);

    await syncAdmBindingState(client, { guildId: GUILD, nitradoConnId: CONN }, '123');

    expect(create).toHaveBeenCalledWith({
      data: {
        guildId: GUILD,
        nitradoConnId: CONN,
        bindingVersion: 0,
        currentServiceId: '123',
      },
    });
    expect(update).not.toHaveBeenCalled();
    expect(scopeFindMany).not.toHaveBeenCalled();
  });

  it('erhoeht die Version bei identischer Service-ID nicht und behaelt LIVE_SERVER-Wissen', async () => {
    const { client, update, scopeFindMany } = clientWith({ bindingVersion: 4, currentServiceId: '123' });

    const result = await syncAdmBindingState(client, { guildId: GUILD, nitradoConnId: CONN }, '123');

    expect(result.bindingVersion).toBe(4);
    expect(update).not.toHaveBeenCalled();
    expect(scopeFindMany).not.toHaveBeenCalled();
  });

  it('loescht bei echtem Service-Wechsel nur generiertes LIVE_SERVER-Wissen und erhoeht danach die Version', async () => {
    const {
      client, update, knowledgeDeleteMany, provenanceDeleteMany, scopeDeleteMany,
    } = clientWith({ bindingVersion: 4, currentServiceId: '123' });

    await syncAdmBindingState(client, { guildId: GUILD, nitradoConnId: CONN }, '456');

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
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentServiceId: '456', bindingVersion: { increment: 1 } },
    }));
    expect(knowledgeDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  it('erhoeht die Version nicht, wenn LIVE_SERVER-Cleanup vor dem Rebind fehlschlaegt', async () => {
    const { client, update, provenanceDeleteMany } = clientWith({ bindingVersion: 4, currentServiceId: '123' });
    provenanceDeleteMany.mockRejectedValueOnce(new Error('cleanup failed'));

    await expect(syncAdmBindingState(client, { guildId: GUILD, nitradoConnId: CONN }, '456'))
      .rejects.toThrow('cleanup failed');

    expect(update).not.toHaveBeenCalled();
  });

  it('behaelt Version 0 bit-genau und namespaced nur spaetere Bindings', () => {
    expect(admBindingFileIdentityPrefix(0)).toBeNull();
    expect(admBindingFileIdentity(0, 'DayZServer.ADM')).toBe('DayZServer.ADM');
    expect(admBindingFileIdentityPrefix(3)).toBe('adm-binding:3:');
    expect(admBindingFileIdentity(3, 'DayZServer.ADM')).toBe('adm-binding:3:DayZServer.ADM');
  });
});
