import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const accessSource = read('src/modules/permissions/access.ts');
const authSource = read('src/dashboard/middleware/auth.ts');
const guildListSource = read('src/dashboard/routes/v2/guilds.ts');
const permissionRouteSource = read('src/dashboard/routes/v2/permissions.ts');
const repositorySource = read('src/modules/permissions/repository.ts');
const socketSource = read('src/dashboard/socket/guild.ts');
const commandScopeSource = read('src/commands/middleware/withGuildScope.ts');
const commandPermissionsSource = read('src/commands/dashboard/permissions.ts');
const leaveSource = read('src/events/guildMemberRemove.ts');
const joinSource = read('src/events/guildMemberAdd.ts');

describe('Dashboard-1V permission membership/data-integrity/race architecture', () => {
  test('one canonical delegated resolver checks current membership before any grant read', () => {
    const resolver = accessSource.indexOf('export async function resolveDelegatedPermissionContext');
    const member = accessSource.indexOf('await guild.members.fetch(userDiscordId)', resolver);
    const directGrant = accessSource.indexOf('prisma.guildPermissionGrant.findUnique', resolver);
    const roleGrant = accessSource.indexOf('prisma.guildPermissionRoleGrant.findMany', resolver);

    expect(resolver).toBeGreaterThanOrEqual(0);
    expect(member).toBeGreaterThan(resolver);
    expect(directGrant).toBeGreaterThan(member);
    expect(roleGrant).toBeGreaterThan(member);
    expect(accessSource).toContain('NON_DELEGABLE_SCOPES');
    expect(accessSource).toContain('VALID_DELEGABLE_SCOPES');
  });

  test('HTTP, Socket and Slashcommands consume the same canonical resolver', () => {
    for (const source of [authSource, socketSource, commandScopeSource]) {
      expect(source).toContain('resolveDelegatedPermissionContext');
      expect(source).toContain('await resolveDelegatedPermissionContext');
    }
    expect(authSource).not.toContain('prisma.guildPermissionGrant.findUnique({\n        where: { guildId_userDiscordId');
    expect(socketSource).not.toContain('prisma.guildPermissionGrant.findUnique');
    expect(commandScopeSource).not.toContain('prisma.guildPermissionGrant.findUnique');
  });

  test('guild list never treats a stale direct DB grant as membership evidence', () => {
    const candidates = guildListSource.indexOf('for (const guildId of candidateGuildIds)');
    const member = guildListSource.indexOf('await guild.members.fetch(req.auth.discordId)', candidates);
    const directAllow = guildListSource.indexOf('if (directGrantGuildIds.has(guildId))', candidates);
    expect(candidates).toBeGreaterThanOrEqual(0);
    expect(member).toBeGreaterThan(candidates);
    expect(directAllow).toBeGreaterThan(member);
  });

  test('direct grants are revoked at leave and defensively cleared before a rejoin can reactivate them', () => {
    const leaveDelete = leaveSource.indexOf('prisma.guildPermissionGrant.deleteMany');
    const cleanupConfig = leaveSource.indexOf('await getLeaveCleanupConfig');
    const joinDelete = joinSource.indexOf('prisma.guildPermissionGrant.deleteMany');
    const joinCleanupCatch = joinSource.indexOf('Stale Direct-Grant-Cleanup beim Join fehlgeschlagen');
    const joinProfile = joinSource.indexOf('await syncMemberProfile(m)');

    expect(leaveDelete).toBeGreaterThanOrEqual(0);
    expect(leaveDelete).toBeLessThan(cleanupConfig);
    expect(joinDelete).toBeGreaterThanOrEqual(0);
    expect(joinCleanupCatch).toBeGreaterThan(joinDelete);
    expect(joinProfile).toBeGreaterThan(joinCleanupCatch);
  });

  test('rejoin cleanup failure is best-effort and cannot become a join-lifecycle blocker', () => {
    const nestedCleanupStart = joinSource.indexOf('try {\n        const staleGrant');
    const nestedCleanupCatch = joinSource.indexOf('catch (permissionError)');
    const syncProfile = joinSource.indexOf('await syncMemberProfile(m)');
    const outerCatch = joinSource.indexOf('catch (error)');

    expect(nestedCleanupStart).toBeGreaterThanOrEqual(0);
    expect(nestedCleanupCatch).toBeGreaterThan(nestedCleanupStart);
    expect(syncProfile).toBeGreaterThan(nestedCleanupCatch);
    expect(outerCatch).toBeGreaterThan(syncProfile);
  });

  test('grant creation validates current user/role targets while stale revoke/purge remains possible', () => {
    const userPut = permissionRouteSource.indexOf("permissionsRouter.put('/:userDiscordId/:scope'");
    const memberCheck = permissionRouteSource.indexOf('await resolveCurrentMember', userPut);
    const setUser = permissionRouteSource.indexOf('await setGrantScope', userPut);
    const rolePut = permissionRouteSource.indexOf("permissionsRouter.put('/roles/:roleId/:scope'");
    const roleCheck = permissionRouteSource.indexOf('await resolveAssignableRole', rolePut);
    const setRole = permissionRouteSource.indexOf('await setRoleGrantScope', rolePut);

    expect(memberCheck).toBeGreaterThan(userPut);
    expect(setUser).toBeGreaterThan(memberCheck);
    expect(roleCheck).toBeGreaterThan(rolePut);
    expect(setRole).toBeGreaterThan(roleCheck);
    expect(permissionRouteSource).toContain('Ziel-User ist kein aktuelles Mitglied dieser Guild.');
    expect(permissionRouteSource).toContain('Managed/@everyone-Rollen sind nicht delegierbar.');
  });

  test('permission mutations use SERIALIZABLE retry and remove empty grant rows', () => {
    expect(repositorySource).toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(repositorySource).toContain("code === 'P2034' || code === 'P2002'");
    expect(repositorySource).toContain('serializablePermissionMutation');
    expect(repositorySource).toContain('tx.guildPermissionGrant.deleteMany');
    expect(repositorySource).toContain('tx.guildPermissionRoleGrant.deleteMany');

    const directRead = repositorySource.indexOf('tx.guildPermissionGrant.findUnique');
    const directWrite = repositorySource.indexOf('tx.guildPermissionGrant.upsert');
    const roleRead = repositorySource.indexOf('tx.guildPermissionRoleGrant.findUnique');
    const roleWrite = repositorySource.indexOf('tx.guildPermissionRoleGrant.upsert');
    expect(directWrite).toBeGreaterThan(directRead);
    expect(roleWrite).toBeGreaterThan(roleRead);
  });

  test('Slashcommands no longer carry a second transaction implementation', () => {
    expect(commandPermissionsSource).toContain("from '../../modules/permissions/repository'");
    expect(commandPermissionsSource).toContain('await setGrantScope');
    expect(commandPermissionsSource).not.toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(commandPermissionsSource).not.toContain('serializableGrantMutation');
  });
});
