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
  it('processes players beyond the historical 2000-row hard cap without session loss using stable keyset pages', async () => {
    const rows: SessionSourceEvent[] = [];
    for (let player = 0; player < 4000; player += 1) {
      rows.push(event(`c-${String(player).padStart(5, '0')}`, 'PLAYER_CONNECTED', player, player * 2, BigInt(player * 20)));
      rows.push(event(`d-${String(player).padStart(5, '0')}`, 'PLAYER_DISCONNECTED', player, player * 2 + 10, BigInt(player * 20 + 10)));
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));

    const stored = new Map<string, Record<string, unknown>>();
    const pageCalls: Array<{ afterId: string | null; take: number; usedSkip: boolean }> = [];
    const client: PlayerSessionClient = {
      admEvent: {
        findMany: async (args: unknown) => {
          const query = args as { where?: { id?: { gt?: string } }; take?: number; skip?: number };
          const afterId = query.where?.id?.gt ?? null;
          const take = query.take ?? rows.length;
          pageCalls.push({ afterId, take, usedSkip: query.skip !== undefined });
          const start = afterId === null ? 0 : rows.findIndex(row => row.id > afterId);
          if (start < 0) return [];
          return rows.slice(start, start + take);
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

    expect(pageCalls).toHaveLength(5);
    expect(pageCalls.every(call => call.take === 2000)).toBe(true);
    expect(pageCalls.every(call => call.usedSkip === false)).toBe(true);
    expect(pageCalls[0].afterId).toBeNull();
    expect(pageCalls.slice(1).every(call => typeof call.afterId === 'string')).toBe(true);
    expect(result.upserted).toBe(4000);
    expect(result.closed).toBe(4000);
    expect(result.open).toBe(0);
    expect(stored.size).toBe(4000);
    expect(stored.has('c-03999')).toBe(true);
    expect(stored.get('c-03999')?.status).toBe('CLOSED');
  });

  it('does not shift later pages when a new lower-key event appears during the scan', async () => {
    const initial: SessionSourceEvent[] = [];
    for (let player = 0; player < 4; player += 1) {
      initial.push(event(`m-${String(player).padStart(2, '0')}-c`, 'PLAYER_CONNECTED', player, player * 20, BigInt(player * 100)));
      initial.push(event(`m-${String(player).padStart(2, '0')}-d`, 'PLAYER_DISCONNECTED', player, player * 20 + 10, BigInt(player * 100 + 10)));
    }
    initial.sort((a, b) => a.id.localeCompare(b.id));
    let rows = [...initial];
    let calls = 0;
    const stored = new Map<string, Record<string, unknown>>();
    const client: PlayerSessionClient = {
      admEvent: {
        findMany: async (args: unknown) => {
          calls += 1;
          const query = args as { where?: { id?: { gt?: string } }; take?: number };
          const afterId = query.where?.id?.gt ?? null;
          if (calls === 2) {
            rows = [event('a-late-row', 'PLAYER_CONNECTED', 99, 1, 1n), ...rows];
            rows.sort((a, b) => a.id.localeCompare(b.id));
          }
          const start = afterId === null ? 0 : rows.findIndex(row => row.id > afterId);
          if (start < 0) return [];
          return rows.slice(start, start + (query.take ?? rows.length));
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

    const result = await aggregatePlayerSessions(client, { guildId: 'g', nitradoConnId: 'n' }, 2);
    expect(result.closed).toBe(4);
    expect(stored.size).toBe(4);
    expect(stored.has('a-late-row')).toBe(false);
  });
});
