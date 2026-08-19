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

  test('direct grants are additionally fenced to the current Discord membership epoch', () => {
    expect(accessSource).toContain('export function directGrantBelongsToMembership');
    expect(accessSource).toContain('grantUpdatedAt.getTime() >= memberJoinedAt.getTime()');
    expect(accessSource).toContain('directGrantBelongsToMembership(directGrant?.updatedAt, member.joinedAt)');
    expect(accessSource).toContain('select: { permissions: true, updatedAt: true }');
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

  test('guild list requires live membership and the same current-epoch direct-grant fence', () => {
    const candidates = guildListSource.indexOf('for (const guildId of candidateGuildIds)');
    const member = guildListSource.indexOf('await guild.members.fetch(req.auth.discordId)', candidates);
    const directCheck = guildListSource.indexOf('directGrantBelongsToMembership(directGrant.updatedAt, member.joinedAt)', candidates);
    expect(candidates).toBeGreaterThanOrEqual(0);
    expect(member).toBeGreaterThan(candidates);
    expect(directCheck).toBeGreaterThan(member);
    expect(guildListSource).toContain('select: { guildId: true, permissions: true, updatedAt: true }');
  });

  test('direct grants are revoked at leave and rejoin cleanup deletes only pre-join epochs', () => {
    const leaveDelete = leaveSource.indexOf('prisma.guildPermissionGrant.deleteMany');
    const cleanupConfig = leaveSource.indexOf('await getLeaveCleanupConfig');
    const joinDelete = joinSource.indexOf('prisma.guildPermissionGrant.deleteMany');
    const epochFence = joinSource.indexOf('updatedAt: { lt: m.joinedAt }', joinDelete);
    const joinCleanupCatch = joinSource.indexOf('Stale Direct-Grant-Cleanup beim Join fehlgeschlagen');
    const joinProfile = joinSource.indexOf('await syncMemberProfile(m)');

    expect(leaveDelete).toBeGreaterThanOrEqual(0);
    expect(leaveDelete).toBeLessThan(cleanupConfig);
    expect(joinDelete).toBeGreaterThanOrEqual(0);
    expect(epochFence).toBeGreaterThan(joinDelete);
    expect(joinCleanupCatch).toBeGreaterThan(epochFence);
    expect(joinProfile).toBeGreaterThan(joinCleanupCatch);
  });

  test('rejoin cleanup failure is best-effort and cannot become a join-lifecycle blocker', () => {
    const nestedCleanupStart = joinSource.indexOf('try {\n        if (m.joinedAt)');
    const nestedCleanupCatch = joinSource.indexOf('catch (permissionError)');
    const syncProfile = joinSource.indexOf('await syncMemberProfile(m)');
    const outerCatch = joinSource.indexOf('catch (error)');

    expect(nestedCleanupStart).toBeGreaterThanOrEqual(0);
    expect(nestedCleanupCatch).toBeGreaterThan(nestedCleanupStart);
    expect(syncProfile).toBeGreaterThan(nestedCleanupCatch);
    expect(outerCatch).toBeGreaterThan(syncProfile);
  });

  test('grant creation validates current user/role targets and passes the trusted membership epoch', () => {
    const userPut = permissionRouteSource.indexOf("permissionsRouter.put('/:userDiscordId/:scope'");
    const memberCheck = permissionRouteSource.indexOf('await resolveCurrentMember', userPut);
    const joinedAtCheck = permissionRouteSource.indexOf('!targetMember.member.joinedAt', userPut);
    const setUser = permissionRouteSource.indexOf('await setGrantScope', userPut);
    const rolePut = permissionRouteSource.indexOf("permissionsRouter.put('/roles/:roleId/:scope'");
    const roleCheck = permissionRouteSource.indexOf('await resolveAssignableRole', rolePut);
    const setRole = permissionRouteSource.indexOf('await setRoleGrantScope', rolePut);

    expect(memberCheck).toBeGreaterThan(userPut);
    expect(joinedAtCheck).toBeGreaterThan(memberCheck);
    expect(setUser).toBeGreaterThan(joinedAtCheck);
    expect(permissionRouteSource.slice(setUser, setUser + 400)).toContain('targetMember.member.joinedAt');
    expect(roleCheck).toBeGreaterThan(rolePut);
    expect(setRole).toBeGreaterThan(roleCheck);
    expect(permissionRouteSource).toContain('Ziel-User ist kein aktuelles Mitglied dieser Guild.');
    expect(permissionRouteSource).toContain('Managed/@everyone-Rollen sind nicht delegierbar.');
  });

  test('permission mutations use SERIALIZABLE retry, epoch fencing and remove empty grant rows', () => {
    expect(repositorySource).toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(repositorySource).toContain("code === 'P2034' || code === 'P2002'");
    expect(repositorySource).toContain('serializablePermissionMutation');
    expect(repositorySource).toContain('membershipJoinedAt: Date | null = null');
    expect(repositorySource).toContain('enabled && !membershipJoinedAt');
    expect(repositorySource).toContain('directGrantBelongsToMembership(existing.updatedAt, membershipJoinedAt)');
    expect(repositorySource).toContain('existingIsCurrentMembership ? sanitizeScopes(existing?.permissions) : []');
    expect(repositorySource).toContain('!enabled && (!membershipJoinedAt || !existingIsCurrentMembership)');
    expect(repositorySource).toContain('tx.guildPermissionGrant.deleteMany');
    expect(repositorySource).toContain('tx.guildPermissionRoleGrant.deleteMany');

    const directRead = repositorySource.indexOf('tx.guildPermissionGrant.findUnique');
    const directWrite = repositorySource.indexOf('tx.guildPermissionGrant.upsert');
    const roleRead = repositorySource.indexOf('tx.guildPermissionRoleGrant.findUnique');
    const roleWrite = repositorySource.indexOf('tx.guildPermissionRoleGrant.upsert');
    expect(directWrite).toBeGreaterThan(directRead);
    expect(roleWrite).toBeGreaterThan(roleRead);
  });

  test('non-delegable scopes are grant-blocked but revoke remains a cleanup path', () => {
    expect(repositorySource).toContain('if (enabled && NON_DELEGABLE_SCOPES.has(scope))');
    expect(repositorySource).not.toContain('if (NON_DELEGABLE_SCOPES.has(scope)) {\n    throw new Error(`Scope ${scope} ist nicht delegierbar');
    expect(permissionRouteSource).toContain("permissionsRouter.delete('/:userDiscordId/:scope'");
    expect(permissionRouteSource).toContain("permissionsRouter.delete('/roles/:roleId/:scope'");
  });

  test('Slashcommands use the shared repository and propagate live joinedAt for direct grant intent', () => {
    expect(commandPermissionsSource).toContain("from '../../modules/permissions/repository'");
    expect(commandPermissionsSource).toContain('await setGrantScope');
    expect(commandPermissionsSource).toContain('member.joinedAt');
    expect(commandPermissionsSource).toContain('member?.joinedAt ?? null');
    expect(commandPermissionsSource).not.toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(commandPermissionsSource).not.toContain('serializableGrantMutation');
  });
});
