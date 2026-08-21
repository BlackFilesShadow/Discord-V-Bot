import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));
const removeSource = read('src/events/guildMemberRemove.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');
const cleanupSource = read('src/modules/moderation/leaveCleanupStatsSessions.ts');
const linkEconomySource = read('src/modules/moderation/leaveCleanupLinkEconomy.ts');

describe('Leave-1D/1E production ordering and reset invariants', () => {
  it('keeps stats/session mutations out of guildMemberRemove and runs them only in the worker', () => {
    expect(removeSource).not.toContain('leaveCleanupStatsSessions');
    expect(removeSource).not.toContain('runLeaveStatsSessionsCleanupStep');
    expect(workerSource).toContain('runLeaveStatsSessionsCleanupStep');
  });

  it('persists STATS completion before the orchestrator enters the post-whitelist Leave-1C core', () => {
    const statsCall = workerSource.indexOf('() => runLeaveStatsSessionsCleanupStep(');
    const statsAdvance = workerSource.indexOf("advanceLeaveCleanupStep(request, 'STATS_SESSIONS')");
    const economyCall = workerSource.indexOf('() => runLeaveLinkEconomyAfterConfirmedWhitelistStep(');
    expect(statsCall).toBeGreaterThanOrEqual(0);
    expect(statsAdvance).toBeGreaterThan(statsCall);
    expect(economyCall).toBeGreaterThan(statsAdvance);
    expect(linkEconomySource).toContain('runLeaveLinkEconomyAfterConfirmedWhitelistStep');
  });

  it('blocks an OPEN session under locks before any PlayerSession identity mutation', () => {
    const playerLock = cleanupSource.indexOf('LOCK TABLE \"PlayerSession\"');
    const openRecheck = cleanupSource.indexOf('SELECT \"id\" FROM \"PlayerSession\"');
    const sessionUpdate = cleanupSource.indexOf('UPDATE \"PlayerSession\"');
    expect(playerLock).toBeGreaterThanOrEqual(0);
    expect(openRecheck).toBeGreaterThan(playerLock);
    expect(sessionUpdate).toBeGreaterThan(openRecheck);
    expect(cleanupSource).toContain("'OPEN'::\"PlayerSessionStatus\"");
    expect(cleanupSource).toContain("reason: 'ACTIVE_SESSION'");
  });

  it('preserves immutable session/event rows and reward watermarks', () => {
    expect(cleanupSource).not.toContain('DELETE FROM \"PlayerSession\"');
    expect(cleanupSource).not.toContain('DELETE FROM \"AdmEvent\"');
    expect(cleanupSource).not.toContain('SET \"bucketsCredited\"');
    expect(cleanupSource).not.toContain('SET \"bucketsEarned\"');
    expect(cleanupSource).not.toContain('SET \"durationSeconds\"');
  });

  it('removes raw ADM identity while retaining the eventKey as a non-reversible technical tombstone', () => {
    expect(cleanupSource).toContain("\"rawLine\"='[LEAVE_RESET] eventKey=' || \"eventKey\"");
    expect(cleanupSource).toContain('\"actorName\"=CASE');
    expect(cleanupSource).toContain('\"targetName\"=CASE');
    expect(cleanupSource).toContain('\"actorGameId\"=CASE');
    expect(cleanupSource).toContain('\"targetGameId\"=CASE');
  });

  it('resets Discord leaderboard/XP only through exact guild + Discord ownership', () => {
    expect(cleanupSource).toContain('DELETE FROM \"LevelData\" d');
    expect(cleanupSource).toContain('DELETE FROM \"XpRecord\" x');
    expect(cleanupSource).toContain('d.\"guildId\"=$1');
    expect(cleanupSource).toContain('x.\"guildId\"=$1');
    expect(cleanupSource).toContain('u.\"discordId\"=$2');
  });

  it('never exposes a raw game identifier in the public cleanup result contract', () => {
    const resultContract = cleanupSource.slice(
      cleanupSource.indexOf('export interface LeaveStatsSessionsResult'),
      cleanupSource.indexOf('interface SessionEvidence'),
    );
    expect(resultContract).not.toContain('rawGameId');
    expect(resultContract).not.toContain('gameId: string');
    expect(resultContract).not.toContain('playerName');
  });
});
