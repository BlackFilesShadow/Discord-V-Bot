from pathlib import Path

# Keep the existing PLAYER_LIST architecture assertion aligned with the bounded
# SQL implementation while preserving the same source-of-truth guarantees.
roster_test = Path('tests/modules/playerListRoster.test.ts')
text = roster_test.read_text(encoding='utf-8')
text = text.replace("expect(rosterSection).toContain('sourceFile: latestCursor.fileIdentity');", "expect(rosterSection).toContain('latestCursor.fileIdentity');")
text = text.replace("expect(rosterSection).toContain('AdmEventType.PLAYER_DISCONNECTED');", "expect(rosterSection).toContain('PLAYER_DISCONNECTED');")
text = text.replace("expect(rosterSection).toContain('AdmEventType.PLAYER_POSITION');", "expect(rosterSection).toContain('PLAYER_POSITION');")
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
    expect(runtime.match(/SELECT DISTINCT ON/g)?.length).toBe(2);
    expect(runtime).toContain('PLAYER_CONNECTED');
    expect(runtime).toContain('PLAYER_DISCONNECTED');
    expect(runtime).toContain('PLAYER_POSITION');
    expect(migration).toContain('AdmEvent_roster_presence_latest_idx');
    expect(migration).toContain('AdmEvent_roster_position_latest_idx');
  });
});
""", encoding='utf-8')

# Critical 4k fix: the old fixed take:2000 permanently starved all later
# connect/disconnect rows. Keep the existing pairing/upsert business logic
# unchanged and make only the source read exhaustive via stable keyset pages.
# Keyset paging by immutable primary key avoids OFFSET window shifts while ADM
# ingestion is still appending rows. pairPlayerSessions already performs the
# canonical per-player time/byte ordering afterwards, so database read order is
# not part of the business semantics.
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
  // canonical ADM stream by immutable primary key. This is deliberately keyset
  // pagination rather than OFFSET so concurrent ingest cannot shift a later
  // window and make an already-existing event disappear from this run.
  const pageSize = Math.max(1, Math.min(10_000, Math.trunc(limit)));
  const events: SessionSourceEvent[] = [];
  let afterId: string | null = null;
  for (;;) {
    const page = await client.admEvent.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        eventType: { in: ['PLAYER_CONNECTED', 'PLAYER_DISCONNECTED'] },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: pageSize,
    });
    events.push(...page);
    if (page.length < pageSize) break;
    afterId = page[page.length - 1].id;
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
    // The newly inserted lower-key row is intentionally picked up on the next
    // complete aggregation pass; it cannot shift/skips any pre-existing row.
    expect(stored.has('a-late-row')).toBe(false);
  });
});
""", encoding='utf-8')
