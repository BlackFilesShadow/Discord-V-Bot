import { selectEconomyLinkServer } from '../../src/dashboard/routes/v2/economyLink';

const active = (id: string, slot: number) => ({ id, slot, status: 'ACTIVE', nitradoServerId: `srv-${slot}` });

describe('economyLink server scope', () => {
  it('auto-resolves only when exactly one usable server exists', () => {
    expect(selectEconomyLinkServer([active('a', 1)], undefined)).toEqual({ kind: 'RESOLVED', nitradoConnId: 'a' });
  });

  it('fails closed when multiple usable servers exist without explicit slot', () => {
    expect(selectEconomyLinkServer([active('a', 1), active('b', 2)], undefined)).toEqual({ kind: 'PROMPT_REQUIRED' });
  });

  it('resolves an explicitly selected active slot', () => {
    expect(selectEconomyLinkServer([active('a', 1), active('b', 2)], '2')).toEqual({ kind: 'RESOLVED', nitradoConnId: 'b' });
  });

  it('rejects legacy slot 5 instead of selecting it', () => {
    expect(selectEconomyLinkServer([active('legacy', 5)], '5')).toEqual({ kind: 'INVALID_SLOT' });
  });

  it('does not treat inactive or unbound connections as usable servers', () => {
    const rows = [
      { id: 'inactive', slot: 1, status: 'REVOKED', nitradoServerId: 'srv-1' },
      { id: 'unbound', slot: 2, status: 'ACTIVE', nitradoServerId: null },
    ];
    expect(selectEconomyLinkServer(rows, undefined)).toEqual({ kind: 'NO_SERVER' });
  });
});
