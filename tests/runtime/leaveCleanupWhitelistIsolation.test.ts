import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const indexSource = read('src/index.ts');
const whitelistSource = read('src/modules/moderation/leaveCleanupWhitelist.ts');

describe('Leave-1B production isolation and write boundary', () => {
  it('keeps the incomplete reset processor disconnected from guildMemberRemove', () => {
    expect(removeSource).not.toContain('leaveCleanupWhitelist');
    expect(removeSource).not.toContain('runLeaveWhitelistCleanupStep');
  });

  it('does not start Leave cleanup from the process runtime yet', () => {
    expect(indexSource).not.toContain('runLeaveWhitelistCleanupStep');
    expect(indexSource).not.toContain('startLeaveCleanup');
  });

  it('uses Nitrado only for a fresh GET and routes every removal through NitradoJob', () => {
    expect(whitelistSource).toContain('.getWhitelist(');
    expect(whitelistSource).not.toContain('.removeFromWhitelist(');
    expect(whitelistSource).toContain("operation: 'WHITELIST_REMOVE'");
    expect(whitelistSource).toContain('tx.nitradoJob.create');
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
