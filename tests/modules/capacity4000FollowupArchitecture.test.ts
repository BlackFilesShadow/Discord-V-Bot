import fs from 'node:fs';
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
    expect(directory).toContain('SELECT DISTINCT ON (\"gameId\")');
    expect(directory).toContain('ORDER BY latest.\"updatedAt\" DESC, latest.\"id\" DESC');
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

  it('Flag activity bounds reconnect overscan, deduplicates by player identity and cannot truncate nearest positions at 1,000 global samples', () => {
    const flag = read('src/modules/gameplayFeeds/flagActivity.ts');
    const migration = read('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql');

    expect(flag).toContain("durationSeconds: { lte: SHORT_SESSION_SECONDS }");
    expect(flag).toContain("status: 'CLOSED'");
    expect(flag).toContain('const MAX_OTHER_SESSION_CANDIDATES = MAX_OTHER_SESSIONS * 16');
    expect(flag).toContain('take: MAX_OTHER_SESSION_CANDIDATES');
    expect(flag).toContain('const byGameId = new Map<string, FlagActivitySessionRow>()');
    expect(flag).toContain('if (directGameId && session.gameId === directGameId) continue');
    expect(flag).not.toContain('take: 100,');
    expect(flag).not.toContain('take: 1000');
    expect(migration).toContain('AdmEvent_flag_activity_position_idx');
  });
});
