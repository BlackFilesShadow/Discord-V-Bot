from pathlib import Path

# Keep the existing PLAYER_LIST architecture assertion aligned with the bounded
# SQL implementation while preserving the same source-of-truth guarantees.
roster_test = Path('tests/modules/playerListRoster.test.ts')
text = roster_test.read_text(encoding='utf-8')
text = text.replace("expect(rosterSection).toContain('sourceFile: latestCursor.fileIdentity');", "expect(rosterSection).toContain('\\\"sourceFile\\\" = ${latestCursor.fileIdentity}');")
text = text.replace("expect(rosterSection).toContain('AdmEventType.PLAYER_DISCONNECTED');", "expect(rosterSection).toContain(\"'PLAYER_DISCONNECTED'::\\\"AdmEventType\\\"\");")
text = text.replace("expect(rosterSection).toContain('AdmEventType.PLAYER_POSITION');", "expect(rosterSection).toContain(\"'PLAYER_POSITION'::\\\"AdmEventType\\\"\");")
roster_test.write_text(text, encoding='utf-8')

# Correct the new SQL architecture test: currentPlayerList intentionally uses
# parameterised SQL enum literals, not TypeScript enum members.
sql_test = Path('tests/modules/playerListRosterSqlArchitecture.test.ts')
sql_test.write_text("""import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('PLAYER_LIST SQL capacity architecture', () => {
  it('bounds active-file roster evidence to latest rows per identity with supporting partial indexes', () => {
    const runtime = read('src/modules/gameplayFeeds/runtime.ts');
    const migration = read('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql');
    expect(runtime.match(/SELECT DISTINCT ON \(\"actorGameId\"\)/g)?.length).toBe(2);
    expect(runtime).toContain("'PLAYER_CONNECTED'::\"AdmEventType\"");
    expect(runtime).toContain("'PLAYER_DISCONNECTED'::\"AdmEventType\"");
    expect(runtime).toContain("'PLAYER_POSITION'::\"AdmEventType\"");
    expect(migration).toContain('AdmEvent_roster_presence_latest_idx');
    expect(migration).toContain('AdmEvent_roster_position_latest_idx');
  });
});
""", encoding='utf-8')

# Critical 4k fix: the old fixed take:2000 permanently starved all later
# connect/disconnect rows. Keep the existing pairing/upsert business logic
# unchanged and make only the source read exhaustive via stable pages.
service = Path('src/modules/nitrado/adm/playerSessionService.ts')
service_text = service.read_text(encoding='utf-8')
old = """  const events = await client.admEvent.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      eventType: { in: ['PLAYER_CONNECTED', 'PLAYER_DISCONNECTED'] },
    },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });

  const sessions = pairPlayerSessions(events);
"""
new = """  // `limit` is a page size, not a total cap. A total `take: limit`
  // permanently starves every connect/disconnect row behind that prefix once
  // a busy server exceeds the cap (historically 2,000 rows). Page the complete
  // canonical ADM stream, then run the unchanged pairing/idempotent upsert logic.
  const pageSize = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const events: SessionSourceEvent[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await client.admEvent.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        eventType: { in: ['PLAYER_CONNECTED', 'PLAYER_DISCONNECTED'] },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    });
    events.push(...page);
    if (page.length < pageSize) break;
  }

  const sessions = pairPlayerSessions(events);
"""
if new not in service_text:
    if old not in service_text:
        raise SystemExit('player session aggregate anchor missing')
    service_text = service_text.replace(old, new, 1)
service.write_text(service_text, encoding='utf-8')

capacity = Path('tests/modules/playerSessionCapacity4000.test.ts')
capacity.write_text("""import {
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
""", encoding='utf-8')
