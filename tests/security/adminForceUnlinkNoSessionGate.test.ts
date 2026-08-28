import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const command = fs.readFileSync(path.join(ROOT, 'src/commands/dashboard/privileged.ts'), 'utf8');
const service = fs.readFileSync(path.join(ROOT, 'src/modules/linking/adminForceLink.ts'), 'utf8');

describe('force-unlink no-session gate', () => {
  it('does not resolve player sessions before admin unlink', () => {
    const unlinkStart = service.indexOf('export async function forceAdminUnlinkUser');
    expect(unlinkStart).toBeGreaterThanOrEqual(0);
    const unlinkBody = service.slice(unlinkStart);
    expect(unlinkBody).toContain('unlinkUser(prisma, scope, userDiscordId, now)');
    expect(unlinkBody).not.toContain('resolvePlayerIdentityByName');
    expect(command).toContain('forceAdminUnlinkUser(linkScope, targetUserId)');
  });
});
