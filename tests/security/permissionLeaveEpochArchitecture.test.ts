import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/events/guildMemberRemove.ts'),
  'utf8',
);

describe('Dashboard-1V leave permission epoch fence', () => {
  test('leave resolves the stored grant generation before deleting anything', () => {
    const read = source.indexOf('prisma.guildPermissionGrant.findUnique');
    const membershipCheck = source.indexOf('directGrantBelongsToMembership(', read);
    const remove = source.indexOf('prisma.guildPermissionGrant.deleteMany', membershipCheck);

    expect(read).toBeGreaterThanOrEqual(0);
    expect(membershipCheck).toBeGreaterThan(read);
    expect(remove).toBeGreaterThan(membershipCheck);
  });

  test('delete is CAS-fenced by exact id and updatedAt so delayed leave cannot delete a fresh rejoin grant', () => {
    const remove = source.indexOf('prisma.guildPermissionGrant.deleteMany');
    const deleteSlice = source.slice(remove, remove + 420);

    expect(deleteSlice).toContain('id: existingGrant.id');
    expect(deleteSlice).toContain('guildId: m.guild.id');
    expect(deleteSlice).toContain('userDiscordId: m.user.id');
    expect(deleteSlice).toContain('updatedAt: existingGrant.updatedAt');
  });

  test('missing joinedAt is non-destructive and cleanup remains best-effort', () => {
    expect(source).toContain('if (m.joinedAt)');
    expect(source).toContain('Direct-Grant-Revoke beim Leave uebersprungen: joinedAt fehlt');
    expect(source).toContain('catch (permissionError)');

    const permissionCatch = source.indexOf('catch (permissionError)');
    const cleanupConfig = source.indexOf('await getLeaveCleanupConfig');
    expect(cleanupConfig).toBeGreaterThan(permissionCatch);
  });
});
