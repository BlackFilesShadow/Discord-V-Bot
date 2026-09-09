from pathlib import Path

runtime = Path('src/modules/gameplayFeeds/runtime.ts')
text = runtime.read_text(encoding='utf-8')

old_presence = """  const presenceEvents = await prisma.admEvent.findMany({
    where: {
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      sourceFile: latestCursor.fileIdentity,
      eventType: { in: [AdmEventType.PLAYER_CONNECTED, AdmEventType.PLAYER_DISCONNECTED] },
      actorGameId: { not: null },
    },
    select: {
      id: true,
      eventType: true,
      actorGameId: true,
      actorName: true,
      sourceByteStart: true,
    },
    orderBy: [{ sourceByteStart: 'desc' }, { id: 'desc' }],
  }) as PlayerPresenceEvent[];
"""
new_presence = """  // The roster needs only the newest presence fact per game identity. Pulling the
  // complete ADM history here grows linearly for the lifetime of the active file
  // and can turn a 15s feed tick into a large DB/memory sweep at high population.
  const presenceEvents = await prisma.$queryRaw<PlayerPresenceEvent[]>(Prisma.sql`
    SELECT DISTINCT ON (\"actorGameId\")
           \"id\", \"eventType\", \"actorGameId\", \"actorName\", \"sourceByteStart\"
      FROM \"AdmEvent\"
     WHERE \"guildId\" = ${config.guildId}
       AND \"nitradoConnId\" = ${config.nitradoConnId}
       AND \"sourceFile\" = ${latestCursor.fileIdentity}
       AND \"actorGameId\" IS NOT NULL
       AND \"eventType\" IN (
         'PLAYER_CONNECTED'::\"AdmEventType\",
         'PLAYER_DISCONNECTED'::\"AdmEventType\"
       )
     ORDER BY \"actorGameId\", \"sourceByteStart\" DESC, \"id\" DESC
  `);
"""

old_positions = """  const positions = await prisma.admEvent.findMany({
    where: {
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      sourceFile: latestCursor.fileIdentity,
      eventType: AdmEventType.PLAYER_POSITION,
      actorGameId: { not: null },
    },
    select: {
      id: true,
      actorGameId: true,
      actorName: true,
      actorPosition: true,
      sourceByteStart: true,
    },
    orderBy: [{ sourceByteStart: 'desc' }, { id: 'desc' }],
  }) as PlayerPositionEvent[];
"""
new_positions = """  // Same principle for positions: attachCurrentPositions() only needs the newest
  // position per identity. DISTINCT ON bounds result size by online identities
  // instead of by ADM sampling frequency.
  const positions = await prisma.$queryRaw<PlayerPositionEvent[]>(Prisma.sql`
    SELECT DISTINCT ON (\"actorGameId\")
           \"id\", \"actorGameId\", \"actorName\", \"actorPosition\", \"sourceByteStart\"
      FROM \"AdmEvent\"
     WHERE \"guildId\" = ${config.guildId}
       AND \"nitradoConnId\" = ${config.nitradoConnId}
       AND \"sourceFile\" = ${latestCursor.fileIdentity}
       AND \"actorGameId\" IS NOT NULL
       AND \"actorPosition\" IS NOT NULL
       AND \"eventType\" = 'PLAYER_POSITION'::\"AdmEventType\"
     ORDER BY \"actorGameId\", \"sourceByteStart\" DESC, \"id\" DESC
  `);
"""

if new_presence not in text:
    if old_presence not in text:
        raise SystemExit('presence hotpath anchor missing')
    text = text.replace(old_presence, new_presence, 1)
if new_positions not in text:
    if old_positions not in text:
        raise SystemExit('position hotpath anchor missing')
    text = text.replace(old_positions, new_positions, 1)
runtime.write_text(text, encoding='utf-8')

# PostgreSQL can satisfy the latest-per-player DISTINCT ON queries directly from
# small partial indexes. This is additive only; no schema/business semantics change.
migration = Path('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql')
migration.parent.mkdir(parents=True, exist_ok=True)
migration.write_text("""-- Bound PLAYER_LIST evidence lookup by identity instead of active-file history.
-- Partial indexes keep write amplification limited to the two relevant event classes.
CREATE INDEX IF NOT EXISTS \"AdmEvent_roster_presence_latest_idx\"
ON \"AdmEvent\" (\"guildId\", \"nitradoConnId\", \"sourceFile\", \"actorGameId\", \"sourceByteStart\" DESC, \"id\" DESC)
WHERE \"actorGameId\" IS NOT NULL
  AND \"eventType\" IN ('PLAYER_CONNECTED', 'PLAYER_DISCONNECTED');

CREATE INDEX IF NOT EXISTS \"AdmEvent_roster_position_latest_idx\"
ON \"AdmEvent\" (\"guildId\", \"nitradoConnId\", \"sourceFile\", \"actorGameId\", \"sourceByteStart\" DESC, \"id\" DESC)
WHERE \"actorGameId\" IS NOT NULL
  AND \"actorPosition\" IS NOT NULL
  AND \"eventType\" = 'PLAYER_POSITION';
""", encoding='utf-8')

capacity_test = Path('tests/modules/playerListRosterCapacity.test.ts')
capacity_test.write_text("""import {
  attachCurrentPositions,
  resolveOnlinePresence,
  type PlayerPositionEvent,
  type PlayerPresenceEvent,
} from '../../src/modules/gameplayFeeds/playerListRoster';

function newestPerGameId<T extends { actorGameId: string | null; sourceByteStart: bigint; id: string }>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.actorGameId !== b.actorGameId) return String(a.actorGameId).localeCompare(String(b.actorGameId));
    if (a.sourceByteStart !== b.sourceByteStart) return a.sourceByteStart > b.sourceByteStart ? -1 : 1;
    return b.id.localeCompare(a.id);
  });
  const seen = new Set<string>();
  return sorted.filter(row => {
    if (!row.actorGameId || seen.has(row.actorGameId)) return false;
    seen.add(row.actorGameId);
    return true;
  });
}

describe('PLAYER_LIST 4000-player bounded evidence', () => {
  it('latest-per-player evidence is semantically equivalent to full history', () => {
    const presence: PlayerPresenceEvent[] = [];
    const positions: PlayerPositionEvent[] = [];
    for (let player = 0; player < 4000; player += 1) {
      const gameId = `game-${player}`;
      presence.push({ id: `c-${player}`, eventType: 'PLAYER_CONNECTED', actorGameId: gameId, actorName: `Player ${player}`, sourceByteStart: BigInt(player * 1000) });
      for (let sample = 1; sample <= 8; sample += 1) {
        positions.push({ id: `p-${player}-${sample}`, actorGameId: gameId, actorName: `Player ${player}`, actorPosition: `${player},${sample},10`, sourceByteStart: BigInt(player * 1000 + sample) });
      }
    }
    // Exercise disconnect precedence for a subset as well.
    for (let player = 0; player < 4000; player += 37) {
      presence.push({ id: `d-${player}`, eventType: 'PLAYER_DISCONNECTED', actorGameId: `game-${player}`, actorName: `Player ${player}`, sourceByteStart: BigInt(player * 1000 + 20) });
    }

    const full = attachCurrentPositions(resolveOnlinePresence(presence, positions), positions);
    const boundedPresence = newestPerGameId(presence) as PlayerPresenceEvent[];
    const boundedPositions = newestPerGameId(positions) as PlayerPositionEvent[];
    const bounded = attachCurrentPositions(resolveOnlinePresence(boundedPresence, boundedPositions), boundedPositions);

    expect(bounded).toEqual(full);
    expect(boundedPresence.length).toBeLessThanOrEqual(4000);
    expect(boundedPositions).toHaveLength(4000);
    expect(positions).toHaveLength(32000);
  });
});
""", encoding='utf-8')

architecture_test = Path('tests/modules/playerListRosterSqlArchitecture.test.ts')
architecture_test.write_text("""import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('PLAYER_LIST SQL capacity architecture', () => {
  it('bounds active-file roster evidence to latest rows per identity with supporting partial indexes', () => {
    const runtime = read('src/modules/gameplayFeeds/runtime.ts');
    const migration = read('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql');
    expect(runtime.match(/SELECT DISTINCT ON \(\"actorGameId\"\)/g)?.length).toBe(2);
    expect(runtime).toContain('AdmEventType.PLAYER_CONNECTED'); // enum remains used by feed scanning elsewhere
    expect(migration).toContain('AdmEvent_roster_presence_latest_idx');
    expect(migration).toContain('AdmEvent_roster_position_latest_idx');
  });
});
""", encoding='utf-8')
