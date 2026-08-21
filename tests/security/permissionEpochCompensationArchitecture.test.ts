import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const repositorySource = read('src/modules/permissions/repository.ts');
const routeSource = read('src/dashboard/routes/v2/permissions.ts');
const commandSource = read('src/commands/dashboard/permissions.ts');

describe('Dashboard-1V post-commit membership ABA compensation architecture', () => {
  test('repository cleanup deletes only an exactly matching explicit generation', () => {
    expect(repositorySource).toContain('export async function deleteGrantForMembershipEpoch');
    expect(repositorySource).toContain('directGrantMembershipEpoch(existing?.permissions)');
    expect(repositorySource).toContain('storedEpoch.getTime() !== membershipJoinedAt.getTime()');
    expect(repositorySource).toContain('return removed.count > 0');
  });

  test('REST forces a fresh Discord member read after direct-grant mutation before success/audit', () => {
    expect(routeSource).toContain('guild.members.fetch({ user: userDiscordId, force: true })');
    expect(routeSource).toContain('membershipEpochStillCurrent(scope.guildId, target, expectedJoinedAt)');
    expect(routeSource).toContain('compensateStaleMembershipGeneration(scope.guildId, target, expectedJoinedAt)');
    expect(routeSource).toContain('throw new PermissionMembershipEpochConflictError()');

    const postCheck = routeSource.indexOf('membershipEpochStillCurrent(scope.guildId, target, expectedJoinedAt)');
    const audit = routeSource.indexOf("logAuditDb('PERM_GRANTED'", postCheck);
    expect(postCheck).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(postCheck);
  });

  test('Slashcommands use the same fresh post-commit check and generation-safe compensation', () => {
    expect(commandSource).toContain('.fetch({ user: targetDiscordId, force: true })');
    expect(commandSource).toContain('deleteGrantForMembershipEpoch(guildId, targetId, expectedJoinedAt)');
    expect(commandSource).toContain('membershipEpochStillCurrent(interaction, target.id, expectedJoinedAt)');
    expect(commandSource).toContain('throw new PermissionMembershipEpochConflictError()');

    const postCheck = commandSource.indexOf('membershipEpochStillCurrent(interaction, target.id, expectedJoinedAt)');
    const audit = commandSource.indexOf("logAudit('PERM_GRANTED'", postCheck);
    expect(postCheck).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(postCheck);
  });
});
