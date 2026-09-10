import fs from 'fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('ADM/Ban/Worker follow-up architecture gate', () => {
  it('writes Nitrado drift notices with an explicit Prisma payload', () => {
    const source = read('src/modules/nitrado/driftDiscord.ts');
    expect(source).toContain('guildId: args.guildId');
    expect(source).toContain('nitradoConnId: args.nitradoConnId');
    expect(source).toContain('kind: args.kind');
    expect(source).toContain('subjectKey: args.subjectKey');
    expect(source).toContain('channelId,');
    expect(source).not.toContain('data: { ...args, channelId }');
    expect(source).not.toContain("sendNotice(client, { ...args, kind: 'BAN'");
    expect(source).not.toContain("sendNotice(client, { ...args, kind: 'WHITELIST'");
  });

  it('keeps stale-session cleanup roster-backed, conservative and terminal', () => {
    const post = read('src/modules/nitrado/adm/admPostProcessCron.ts');
    const sessions = read('src/modules/nitrado/adm/playerSessionService.ts');
    const roster = read('src/modules/economy/playtimeLiveRosterGuard.ts');

    expect(roster).toContain('available: boolean');
    expect(roster).toContain('if (!latestCursor) return { available: false');
    expect(post).toContain('STALE_OPEN_SESSION_MS = 24 * 60 * 60 * 1000');
    expect(post).toContain('if (!roster.available) return { closed: 0, protectedCredited: 0 }');
    expect(post).toContain("status: 'OPEN'");
    expect(post).toContain('bucketsCredited: 0');
    expect(post).toContain("status: 'CLOSED'");
    expect(post).toContain('durationSeconds: 0');
    expect(post).toContain('bucketsEarned: 0');
    expect(sessions).toContain("update: s.status === 'CLOSED'");
    expect(sessions).toContain(" : { playerName: s.playerName },");
  });

  it('extends known ADM noise and recovers only transient breaker-dead keep-online jobs', () => {
    const migration = read('prisma/migrations/20260910191500_adm_ban_worker_followup/migration.sql');
    const keepOnline = read('src/modules/nitrado/permaOnlyCron.ts');

    expect(migration).toContain("%) is unconscious");
    expect(migration).toContain("%) regained consciousness");
    expect(migration).toContain("j.\"operation\" = 'RESTART_IF_DOWN'");
    expect(migration).toContain("j.\"status\" = 'DEAD'");
    expect(migration).toContain("j.\"lastError\" LIKE 'Nitrado circuit breaker is OPEN%'");
    expect(migration).toContain("n.\"status\" = 'ACTIVE'");
    expect(migration).toContain('n."keepOnlineEnabled" = TRUE');
    expect(migration).toContain('GREATEST(j."maxAttempts", 8)');
    expect(keepOnline).toContain('export const KEEP_ONLINE_MAX_ATTEMPTS = 8');
    expect(keepOnline).toContain('maxAttempts: KEEP_ONLINE_MAX_ATTEMPTS');
  });
});
