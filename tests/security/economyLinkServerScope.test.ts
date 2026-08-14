import { selectDashboardGameServer } from '../../src/dashboard/routes/v2/serverScope';
import type { GuildId, UserDiscordId } from '../../src/types/scope';

const guildId = '123456789012345678' as GuildId;
const actorDiscordId = '223456789012345678' as UserDiscordId;
const connA = 'caaaaaaaaaaaaaaaaaaaaaaaa';
const connB = 'cbbbbbbbbbbbbbbbbbbbbbbbb';
const connLegacy = 'ccccccccccccccccccccccccc';
const active = (id: string, slot: number) => ({ id, slot, alias: `Slot ${slot}`, status: 'ACTIVE', nitradoServerId: `srv-${slot}` });
const select = (rows: ReturnType<typeof active>[], slot?: string) => selectDashboardGameServer(guildId, actorDiscordId, rows, slot);

describe('shared dashboard gameserver scope', () => {
  it('auto-resolves only when exactly one usable server exists', () => {
    expect(select([active(connA, 1)])).toEqual({ kind: 'RESOLVED', nitradoConnId: connA });
  });

  it('fails closed when multiple usable servers exist without explicit slot', () => {
    expect(select([active(connA, 1), active(connB, 2)])).toEqual({ kind: 'PROMPT_REQUIRED', slots: [1, 2] });
  });

  it('resolves an explicitly selected active slot', () => {
    expect(select([active(connA, 1), active(connB, 2)], '2')).toEqual({ kind: 'RESOLVED', nitradoConnId: connB });
  });

  it('rejects legacy slot 5 instead of selecting it', () => {
    expect(select([active(connLegacy, 5)], '5')).toEqual({ kind: 'INVALID_SLOT' });
  });

  it('does not treat inactive or unbound connections as usable servers', () => {
    const rows = [
      { id: connA, slot: 1, alias: 'Inactive', status: 'REVOKED', nitradoServerId: 'srv-1' },
      { id: connB, slot: 2, alias: 'Unbound', status: 'ACTIVE', nitradoServerId: null },
    ];
    expect(selectDashboardGameServer(guildId, actorDiscordId, rows, undefined)).toEqual({ kind: 'NO_SERVER' });
  });
});
