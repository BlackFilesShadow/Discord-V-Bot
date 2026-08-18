import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');
const whitelistSource = read('src/modules/moderation/leaveCleanupWhitelist.ts');
const outboxSource = read('src/modules/whitelist/whitelistOutbox.ts');

describe('Leave-1B/1E production boundary and write safety', () => {
  it('keeps whitelist/Nitrado side effects out of the Discord gateway event', () => {
    expect(removeSource).not.toContain('leaveCleanupWhitelist');
    expect(removeSource).not.toContain('runLeaveWhitelistCleanupStep');
    expect(removeSource).toContain('enqueueLeaveCleanupRequest');
  });

  it('runs whitelist as the first persisted worker substep before stats or economy', () => {
    const whitelistAt = workerSource.indexOf("if (details.step === 'WHITELIST')");
    const statsAt = workerSource.indexOf("if (details.step === 'STATS_SESSIONS')");
    const economyAt = workerSource.indexOf("if (details.step === 'LINK_ECONOMY')");
    expect(whitelistAt).toBeGreaterThanOrEqual(0);
    expect(statsAt).toBeGreaterThan(whitelistAt);
    expect(economyAt).toBeGreaterThan(statsAt);
  });

  it('uses Nitrado only for a fresh GET and routes every removal through the atomic whitelist outbox', () => {
    expect(whitelistSource).toContain('.getWhitelist(');
    expect(whitelistSource).not.toContain('.removeFromWhitelist(');
    expect(whitelistSource).toContain('enqueueWhitelistRemove(');
    expect(whitelistSource).not.toContain('tx.nitradoJob.create');
    expect(outboxSource).toContain("return enqueueWhitelistJob(client, scope, 'WHITELIST_REMOVE', gameId);");
    expect(outboxSource).toContain('withNitradoOutboxSubjectLock(client, lockSubject');
  });

  it('derives whitelist names from a session GUID that matches the verified link HMAC', () => {
    expect(whitelistSource).toContain('identityHash(session.gameId, config.security.encryptionKey) !== linkHash');
    expect(whitelistSource).toContain('session.playerName');
    expect(whitelistSource).not.toContain('identityHash(name');
  });

  it('requires remote absence before local whitelist rows are deleted', () => {
    const remoteCheck = whitelistSource.indexOf('if (runningAdds.length > 0 || matchingRemote.length > 0)');
    const localDelete = whitelistSource.indexOf('tx.whitelistEntry.deleteMany');
    expect(remoteCheck).toBeGreaterThanOrEqual(0);
    expect(localDelete).toBeGreaterThan(remoteCheck);
  });
});
