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
  return {
    client: { nitradoAdmBindingState: { findUnique, create, update, deleteMany } } as unknown as AdmBindingStateClient,
    findUnique,
    create,
    update,
  };
}

describe('Nitrado-1M ADM binding state', () => {
  it('initialisiert bestehende/neue Bindungen auf legacy-kompatibler Version 0', async () => {
    const { client, create, update } = clientWith(null);

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
  });

  it('erhoeht die Version bei identischer Service-ID nicht', async () => {
    const { client, update } = clientWith({ bindingVersion: 4, currentServiceId: '123' });

    const result = await syncAdmBindingState(client, { guildId: GUILD, nitradoConnId: CONN }, '123');

    expect(result.bindingVersion).toBe(4);
    expect(update).not.toHaveBeenCalled();
  });

  it('erhoeht die Version bei einem echten Service-Wechsel genau einmal', async () => {
    const { client, update } = clientWith({ bindingVersion: 4, currentServiceId: '123' });

    await syncAdmBindingState(client, { guildId: GUILD, nitradoConnId: CONN }, '456');

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { currentServiceId: '456', bindingVersion: { increment: 1 } },
    }));
  });

  it('behaelt Version 0 bit-genau und namespaced nur spaetere Bindings', () => {
    expect(admBindingFileIdentityPrefix(0)).toBeNull();
    expect(admBindingFileIdentity(0, 'DayZServer.ADM')).toBe('DayZServer.ADM');
    expect(admBindingFileIdentityPrefix(3)).toBe('adm-binding:3:');
    expect(admBindingFileIdentity(3, 'DayZServer.ADM')).toBe('adm-binding:3:DayZServer.ADM');
  });
});
