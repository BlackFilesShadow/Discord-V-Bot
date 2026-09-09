from pathlib import Path

# ---------------------------------------------------------------------------
# Radar player directory: the previous dashboard endpoint took only the newest
# 2,000 sessions and de-duplicated afterwards. With >2,000 distinct players this
# made older identities disappear from the selector. Move the read into one
# latest-per-identity PostgreSQL query, preserving the existing output semantics.
# ---------------------------------------------------------------------------
player_directory = Path('src/modules/radar/playerDirectory.ts')
player_directory.parent.mkdir(parents=True, exist_ok=True)
player_directory.write_text("""import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { isValidBattleyeGuid } from '../../utils/guid';

export interface RadarPlayerDirectoryEntry {
  gameId: string;
  playerName: string;
}

/**
 * Returns the latest non-empty display name for every gameserver identity in
 * the requested guild/server scope. Result size is bounded by unique players,
 * not by historical PlayerSession row count.
 */
export async function loadRadarPlayerDirectory(
  guildId: string,
  nitradoConnId: string,
): Promise<RadarPlayerDirectoryEntry[]> {
  const rows = await prisma.$queryRaw<Array<{
    gameId: string;
    playerName: string | null;
    updatedAt: Date;
    id: string;
  }>>(Prisma.sql`
    SELECT latest.\"gameId\", latest.\"playerName\", latest.\"updatedAt\", latest.\"id\"
      FROM (
        SELECT DISTINCT ON (\"gameId\")
               \"gameId\", \"playerName\", \"updatedAt\", \"id\"
          FROM \"PlayerSession\"
         WHERE \"guildId\" = ${guildId}
           AND \"nitradoConnId\" = ${nitradoConnId}
           AND \"playerName\" IS NOT NULL
         ORDER BY \"gameId\", \"updatedAt\" DESC, \"id\" DESC
      ) AS latest
     ORDER BY latest.\"updatedAt\" DESC, latest.\"id\" DESC
  `);

  return rows.flatMap(row => {
    const gameId = row.gameId.trim();
    const playerName = row.playerName?.trim();
    if (!playerName || !isValidBattleyeGuid(gameId)) return [];
    return [{ gameId, playerName }];
  });
}
""", encoding='utf-8')

radar = Path('src/dashboard/routes/v2/radar.ts')
radar_text = radar.read_text(encoding='utf-8')
if "import { loadRadarPlayerDirectory } from '../../../modules/radar/playerDirectory';" not in radar_text:
    radar_text = radar_text.replace(
        "import { isValidBattleyeGuid } from '../../../utils/guid';",
        "import { isValidBattleyeGuid } from '../../../utils/guid';\nimport { loadRadarPlayerDirectory } from '../../../modules/radar/playerDirectory';",
        1,
    )
old_radar_handler = """radarRouter.get('/players', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const sessions = await prisma.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.connId, playerName: { not: null } },
    select: { gameId: true, playerName: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 2000,
  });
  const gameIds = new Set<string>();
  const players = sessions.flatMap(session => {
    const gameId = session.gameId.trim();
    const playerName = session.playerName?.trim();
    if (!playerName || !isValidBattleyeGuid(gameId) || gameIds.has(gameId)) return [];
    gameIds.add(gameId);
    return [{ gameId, playerName }];
  });
  res.json({ players });
});
"""
new_radar_handler = """radarRouter.get('/players', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const players = await loadRadarPlayerDirectory(scope.guildId, scope.connId);
  res.json({ players });
});
"""
if new_radar_handler not in radar_text:
    if old_radar_handler not in radar_text:
        raise SystemExit('radar /players capacity anchor missing')
    radar_text = radar_text.replace(old_radar_handler, new_radar_handler, 1)
radar.write_text(radar_text, encoding='utf-8')

migration = Path('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql')
migration_text = migration.read_text(encoding='utf-8')
radar_index = """

-- Radar player selector needs one latest named session per identity. This
-- additive partial index prevents a full historical PlayerSession sort at 4k+.
CREATE INDEX IF NOT EXISTS \"PlayerSession_radar_directory_idx\"
ON \"PlayerSession\" (\"guildId\", \"nitradoConnId\", \"gameId\", \"updatedAt\" DESC, \"id\" DESC)
WHERE \"playerName\" IS NOT NULL;
"""
if 'PlayerSession_radar_directory_idx' not in migration_text:
    migration_text = migration_text.rstrip() + radar_index + '\n'

# Flag-activity correlation only needs a handful of candidate identities, but
# each of those identities may have many position samples in the +/-10m window.
# Keep the query indexable by the same semantic keys it filters on.
flag_position_index = """

-- Flag activity correlates PLAYER_POSITION samples for a small candidate set
-- inside a bounded event-time window. This index avoids scanning global ADM
-- history when overall player/sample volume is high.
CREATE INDEX IF NOT EXISTS \"AdmEvent_flag_activity_position_idx\"
ON \"AdmEvent\" (\"guildId\", \"nitradoConnId\", \"eventType\", \"actorGameId\", \"occurredAt\")
WHERE \"actorPosition\" IS NOT NULL AND \"occurredAt\" IS NOT NULL;
"""
if 'AdmEvent_flag_activity_position_idx' not in migration_text:
    migration_text = migration_text.rstrip() + flag_position_index + '\n'
migration.write_text(migration_text, encoding='utf-8')

# ---------------------------------------------------------------------------
# Nitrado drift dashboard: remove total-row caps which made whitelist/ban drift
# silently ignore identities after row 1,000/500. Bound notification fan-out so
# a large remote drift does not launch thousands of Discord requests at once.
# ---------------------------------------------------------------------------
drift = Path('src/dashboard/routes/v2/nitradoDrift.ts')
drift_text = drift.read_text(encoding='utf-8')
if "import { forEachBounded } from '../../../utils/boundedConcurrency';" not in drift_text:
    drift_text = drift_text.replace(
        "import { logAuditDb, logger } from '../../../utils/logger';",
        "import { logAuditDb, logger } from '../../../utils/logger';\nimport { forEachBounded } from '../../../utils/boundedConcurrency';",
        1,
    )

drift_text = drift_text.replace(
"""    orderBy: [{ approvedAt: 'desc' }, { gameId: 'asc' }],
    take: 1000,
  });""",
"""    orderBy: [{ approvedAt: 'desc' }, { gameId: 'asc' }],
  });""",
1,
)
drift_text = drift_text.replace(
"""    orderBy: { bannedAt: 'desc' },
    take: 500,
  });""",
"""    orderBy: { bannedAt: 'desc' },
  });""",
1,
)

old_wl_notify = """  const client = tryGetDashboardClient();
  if (client) {
    await Promise.all(items.map(item => notifyNitradoWhitelistDrift(client, {
      guildId: String(scope.guildId), nitradoConnId: String(connId), gameId: item.gameId,
    }).catch(error => logger.warn(`Whitelist-Driftmeldung fehlgeschlagen fuer ${connId}: ${(error as Error).message}`))));
  }
"""
new_wl_notify = """  const client = tryGetDashboardClient();
  if (client) {
    await forEachBounded(items, 4, async item => {
      await notifyNitradoWhitelistDrift(client, {
        guildId: String(scope.guildId), nitradoConnId: String(connId), gameId: item.gameId,
      }).catch(error => logger.warn(`Whitelist-Driftmeldung fehlgeschlagen fuer ${connId}: ${(error as Error).message}`));
    });
  }
"""
if new_wl_notify not in drift_text:
    if old_wl_notify not in drift_text:
        raise SystemExit('whitelist drift notification anchor missing')
    drift_text = drift_text.replace(old_wl_notify, new_wl_notify, 1)

old_ban_notify = """  const client = tryGetDashboardClient();
  if (client) {
    await Promise.all(items.map(item => notifyNitradoBanDrift(client, {
      guildId: String(scope.guildId), nitradoConnId: String(connId), banId: item.banId,
    }).catch(error => logger.warn(`Ban-Driftmeldung fehlgeschlagen fuer ${connId}: ${(error as Error).message}`))));
  }
"""
new_ban_notify = """  const client = tryGetDashboardClient();
  if (client) {
    await forEachBounded(items, 4, async item => {
      await notifyNitradoBanDrift(client, {
        guildId: String(scope.guildId), nitradoConnId: String(connId), banId: item.banId,
      }).catch(error => logger.warn(`Ban-Driftmeldung fehlgeschlagen fuer ${connId}: ${(error as Error).message}`));
    });
  }
"""
if new_ban_notify not in drift_text:
    if old_ban_notify not in drift_text:
        raise SystemExit('ban drift notification anchor missing')
    drift_text = drift_text.replace(old_ban_notify, new_ban_notify, 1)
drift.write_text(drift_text, encoding='utf-8')

# ---------------------------------------------------------------------------
# Flag activity: the previous implementation first selected the first 100
# session starts and then the first 1,000 position samples in chronological
# order. At high population/sample volume that could exclude the actual short
# sessions or the positions closest to the flag event. Bound by the semantic
# result set instead: at most 8 short-session candidates (+1 for a direct-player
# overlap), then read all samples for only those few identities in the 20m
# window. Total server population can no longer starve the correlation.
# ---------------------------------------------------------------------------
flag_activity = Path('src/modules/gameplayFeeds/flagActivity.ts')
flag_text = flag_activity.read_text(encoding='utf-8')
old_nearby_sessions = """    prisma.playerSession.findMany({
      where: {
        guildId: event.guildId,
        nitradoConnId: event.nitradoConnId,
        connectedAt: { gte: before, lte: eventAt },
      },
      orderBy: { connectedAt: 'asc' },
      take: 100,
    }),"""
new_nearby_sessions = """    prisma.playerSession.findMany({
      where: {
        guildId: event.guildId,
        nitradoConnId: event.nitradoConnId,
        connectedAt: { gte: before, lte: eventAt },
        disconnectedAt: { gte: before },
        durationSeconds: { lte: SHORT_SESSION_SECONDS },
        status: 'CLOSED',
      },
      orderBy: [{ durationSeconds: 'asc' }, { connectedAt: 'asc' }, { id: 'asc' }],
      take: MAX_OTHER_SESSIONS + 1,
    }),"""
if new_nearby_sessions not in flag_text:
    if old_nearby_sessions not in flag_text:
        raise SystemExit('flag activity nearby-session capacity anchor missing')
    flag_text = flag_text.replace(old_nearby_sessions, new_nearby_sessions, 1)
old_position_tail = """    select: { actorGameId: true, actorPosition: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
    take: 1000,
  });"""
new_position_tail = """    select: { actorGameId: true, actorPosition: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
  });"""
if new_position_tail not in flag_text:
    if old_position_tail not in flag_text:
        raise SystemExit('flag activity position capacity anchor missing')
    flag_text = flag_text.replace(old_position_tail, new_position_tail, 1)
flag_activity.write_text(flag_text, encoding='utf-8')

# ---------------------------------------------------------------------------
# Expand the live PostgreSQL 4,000-player probe with the Radar directory path.
# Also keep its synthetic ADM event contract aligned with the canonical parser.
# ---------------------------------------------------------------------------
probe = Path('scripts/player-capacity-4000.ts')
probe_text = probe.read_text(encoding='utf-8')
probe_text = probe_text.replace("parseStatus: 'PARSED',", "parseStatus: 'OK',", 1)
if "import { loadRadarPlayerDirectory } from '../src/modules/radar/playerDirectory';" not in probe_text:
    probe_text = probe_text.replace(
        "import { resolveOnlinePresence, attachCurrentPositions, type PlayerPresenceEvent, type PlayerPositionEvent } from '../src/modules/gameplayFeeds/playerListRoster';",
        "import { resolveOnlinePresence, attachCurrentPositions, type PlayerPresenceEvent, type PlayerPositionEvent } from '../src/modules/gameplayFeeds/playerListRoster';\nimport { loadRadarPlayerDirectory } from '../src/modules/radar/playerDirectory';",
        1,
    )
probe_text = probe_text.replace(
    "const result = { players: PLAYERS, inserted: 0, replayInserted: 0, stored: 0, cursor: 0, roster: 0, elapsedMs: 0, eventLoopP99Ms: 0 };",
    "const result = { players: PLAYERS, inserted: 0, replayInserted: 0, stored: 0, cursor: 0, roster: 0, radarDirectory: 0, elapsedMs: 0, eventLoopP99Ms: 0, heapUsedMiB: 0 };",
    1,
)
radar_probe_anchor = """    result.roster = attachCurrentPositions(resolveOnlinePresence(presence, positions), positions).length;
    result.elapsedMs = Number((performance.now() - started).toFixed(2));
"""
radar_probe_replacement = """    result.roster = attachCurrentPositions(resolveOnlinePresence(presence, positions), positions).length;

    await prisma.playerSession.createMany({
      data: Array.from({ length: PLAYERS }, (_, index) => ({
        guildId,
        nitradoConnId,
        gameId: `player-${String(index).padStart(6, '0')}`,
        playerName: `Player ${index}`,
        connectEventId: `capacity-connect-${index}`,
        connectedAt: new Date(1_800_000_000_000 + index),
        status: 'OPEN' as const,
      })),
    });
    result.radarDirectory = (await loadRadarPlayerDirectory(guildId, nitradoConnId)).length;
    result.elapsedMs = Number((performance.now() - started).toFixed(2));
    result.heapUsedMiB = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
"""
if radar_probe_replacement not in probe_text:
    if radar_probe_anchor not in probe_text:
        raise SystemExit('capacity probe roster anchor missing')
    probe_text = probe_text.replace(radar_probe_anchor, radar_probe_replacement, 1)
probe_text = probe_text.replace(
    "    if (result.roster !== PLAYERS) throw new Error(`roster mismatch: ${result.roster}`);",
    "    if (result.roster !== PLAYERS) throw new Error(`roster mismatch: ${result.roster}`);\n    if (result.radarDirectory !== PLAYERS) throw new Error(`radar directory mismatch: ${result.radarDirectory}`);",
    1,
)
probe_text = probe_text.replace(
    "    await prisma.admSourceCursor.deleteMany({ where: { guildId, nitradoConnId } }).catch(() => undefined);",
    "    await prisma.playerSession.deleteMany({ where: { guildId, nitradoConnId } }).catch(() => undefined);\n    await prisma.admSourceCursor.deleteMany({ where: { guildId, nitradoConnId } }).catch(() => undefined);",
    1,
)
probe.write_text(probe_text, encoding='utf-8')

# Architecture regression guards for all follow-up total-cap failures.
arch = Path('tests/modules/capacity4000FollowupArchitecture.test.ts')
arch.write_text("""import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('4,000-player follow-up capacity architecture', () => {
  it('Radar player selector is bounded by unique identities, not the historical 2,000-session prefix', () => {
    const route = read('src/dashboard/routes/v2/radar.ts');
    const directory = read('src/modules/radar/playerDirectory.ts');
    const migration = read('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql');
    const playerRoute = route.split("radarRouter.get('/players'")[1].split("radarRouter.put('/config'")[0];

    expect(playerRoute).toContain('loadRadarPlayerDirectory(scope.guildId, scope.connId)');
    expect(playerRoute).not.toContain('take: 2000');
    expect(directory).toContain('SELECT DISTINCT ON (\\"gameId\\")');
    expect(directory).toContain('ORDER BY latest.\\"updatedAt\\" DESC, latest.\\"id\\" DESC');
    expect(migration).toContain('PlayerSession_radar_directory_idx');
  });

  it('Nitrado drift does not silently ignore rows after 1,000 whitelist or 500 ban records and bounds notice fan-out', () => {
    const drift = read('src/dashboard/routes/v2/nitradoDrift.ts');
    const whitelist = drift.split("nitradoDriftRouter.get('/whitelist'")[1].split("nitradoDriftRouter.post('/whitelist/resolve'")[0];
    const bans = drift.split("nitradoDriftRouter.get('/bans'")[1].split("nitradoDriftRouter.post('/bans/resolve'")[0];

    expect(whitelist).not.toContain('take: 1000');
    expect(bans).not.toContain('take: 500');
    expect(whitelist).toContain('forEachBounded(items, 4');
    expect(bans).toContain('forEachBounded(items, 4');
    expect(whitelist).not.toContain('Promise.all(items.map');
    expect(bans).not.toContain('Promise.all(items.map');
  });

  it('Flag activity selects the semantically relevant short sessions and cannot truncate nearest positions at 1,000 global samples', () => {
    const flag = read('src/modules/gameplayFeeds/flagActivity.ts');
    const migration = read('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql');

    expect(flag).toContain("durationSeconds: { lte: SHORT_SESSION_SECONDS }");
    expect(flag).toContain("status: 'CLOSED'");
    expect(flag).toContain('take: MAX_OTHER_SESSIONS + 1');
    expect(flag).not.toContain('take: 100,');
    expect(flag).not.toContain('take: 1000');
    expect(migration).toContain('AdmEvent_flag_activity_position_idx');
  });
});
""", encoding='utf-8')
