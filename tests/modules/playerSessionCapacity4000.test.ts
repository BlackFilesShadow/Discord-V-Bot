import {
  aggregatePlayerSessions,
  type PlayerSessionClient,
  type SessionSourceEvent,
} from '../../src/modules/nitrado/adm/playerSessionService';

function event(id: string, type: 'PLAYER_CONNECTED' | 'PLAYER_DISCONNECTED', player: number, minute: number, byte: bigint): SessionSourceEvent {
  return {
    id,
    eventType: type,
    actorGameId: `game-${player}`,
    actorName: `Player ${player}`,
    occurredAt: new Date(Date.UTC(2026, 8, 9, 0, minute % 60, 0) + Math.floor(minute / 60) * 60 * 60 * 1000),
    sourceByteStart: byte,
  };
}

describe('PlayerSession 4000-player capacity', () => {
  it('processes players beyond the historical 2000-row hard cap without session loss', async () => {
    const rows: SessionSourceEvent[] = [];
    for (let player = 0; player < 4000; player += 1) {
      rows.push(event(`c-${player}`, 'PLAYER_CONNECTED', player, player * 2, BigInt(player * 20)));
      rows.push(event(`d-${player}`, 'PLAYER_DISCONNECTED', player, player * 2 + 10, BigInt(player * 20 + 10)));
    }
    rows.sort((a, b) => {
      const at = a.occurredAt?.getTime() ?? 0;
      const bt = b.occurredAt?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });

    const stored = new Map<string, Record<string, unknown>>();
    const pageCalls: Array<{ skip: number; take: number }> = [];
    const client: PlayerSessionClient = {
      admEvent: {
        findMany: async (args: unknown) => {
          const query = args as { skip?: number; take?: number };
          const skip = query.skip ?? 0;
          const take = query.take ?? rows.length;
          pageCalls.push({ skip, take });
          return rows.slice(skip, skip + take);
        },
      },
      playerSession: {
        upsert: async ({ where, create, update }) => {
          const key = where.connectEventId as string;
          stored.set(key, stored.has(key) ? { ...stored.get(key)!, ...update } : { ...create });
          return stored.get(key);
        },
      },
    };

    const result = await aggregatePlayerSessions(client, { guildId: 'g-4000', nitradoConnId: 'n-4000' }, 2000);

    expect(pageCalls).toEqual([
      { skip: 0, take: 2000 },
      { skip: 2000, take: 2000 },
      { skip: 4000, take: 2000 },
      { skip: 6000, take: 2000 },
      { skip: 8000, take: 2000 },
    ]);
    expect(result.upserted).toBe(4000);
    expect(result.closed).toBe(4000);
    expect(result.open).toBe(0);
    expect(stored.size).toBe(4000);
    expect(stored.has('c-3999')).toBe(true);
    expect(stored.get('c-3999')?.status).toBe('CLOSED');
  });
});
