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
const whitelistButtonSource = read('src/modules/whitelist/whitelistApprovalButton.ts');
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

  test('direct grants carry a durable membership-generation marker with a legacy-only fallback', () => {
    expect(accessSource).toContain("MEMBERSHIP_EPOCH_PREFIX = '__vbot_membership_joined_at:'");
    expect(accessSource).toContain('export function directGrantMembershipEpoch');
    expect(accessSource).toContain('export function storedDirectPermissions');
    expect(accessSource).toContain('explicitEpoch.getTime() === memberJoinedAt.getTime()');
    expect(accessSource).toContain('grantUpdatedAt.getTime() >= memberJoinedAt.getTime()');
    expect(accessSource).toContain('directGrant?.permissions');
    expect(accessSource).toContain('select: { permissions: true, updatedAt: true }');
  });

  test('all interactive authorization surfaces consume the canonical delegated resolver', () => {
    for (const source of [authSource, socketSource, commandScopeSource, guildListSource, whitelistButtonSource]) {
      expect(source).toContain('resolveDelegatedPermissionContext');
      expect(source).toContain('await resolveDelegatedPermissionContext');
    }
    expect(authSource).not.toContain('prisma.guildPermissionGrant.findUnique({\n        where: { guildId_userDiscordId');
    expect(socketSource).not.toContain('prisma.guildPermissionGrant.findUnique');
    expect(commandScopeSource).not.toContain('prisma.guildPermissionGrant.findUnique');
    expect(guildListSource).toContain('if (!delegated.member || delegated.permissions.size === 0) continue;');
    expect(whitelistButtonSource).not.toContain('prisma.guildPermissionGrant.findUnique');
    expect(whitelistButtonSource).not.toContain('PermissionFlagsBits.ManageGuild');
    expect(whitelistButtonSource).toContain("delegated.permissions.has('whitelist.manage')");
  });

  test('direct grants are revoked at leave and rejoin cleanup deletes only pre-join updatedAt rows', () => {
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
    const epochCapture = permissionRouteSource.indexOf('const expectedJoinedAt = targetMember.member.joinedAt;', userPut);
    const setUser = permissionRouteSource.indexOf('await setGrantScope', userPut);
    const rolePut = permissionRouteSource.indexOf("permissionsRouter.put('/roles/:roleId/:scope'");
    const roleCheck = permissionRouteSource.indexOf('await resolveAssignableRole', rolePut);
    const setRole = permissionRouteSource.indexOf('await setRoleGrantScope', rolePut);

    expect(memberCheck).toBeGreaterThan(userPut);
    expect(joinedAtCheck).toBeGreaterThan(memberCheck);
    expect(epochCapture).toBeGreaterThan(joinedAtCheck);
    expect(setUser).toBeGreaterThan(epochCapture);
    expect(permissionRouteSource.slice(setUser, setUser + 500)).toContain('expectedJoinedAt');
    expect(permissionRouteSource).toContain('membershipEpochStillCurrent(scope.guildId, target, expectedJoinedAt)');
    expect(roleCheck).toBeGreaterThan(rolePut);
    expect(setRole).toBeGreaterThan(roleCheck);
    expect(permissionRouteSource).toContain('Ziel-User ist kein aktuelles Mitglied dieser Guild.');
    expect(permissionRouteSource).toContain('Managed/@everyone-Rollen sind nicht delegierbar.');
  });

  test('permission mutations use SERIALIZABLE retry, generation fencing and remove empty grant rows', () => {
    expect(repositorySource).toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(repositorySource).toContain("code === 'P2034' || code === 'P2002'");
    expect(repositorySource).toContain('serializablePermissionMutation');
    expect(repositorySource).toContain('membershipJoinedAt: Date | null = null');
    expect(repositorySource).toContain('enabled && !membershipJoinedAt');
    expect(repositorySource).toContain('directGrantMembershipEpoch(existing?.permissions)');
    expect(repositorySource).toContain('storedEpoch.getTime() > membershipJoinedAt.getTime()');
    expect(repositorySource).toContain('throw new PermissionMembershipEpochConflictError()');
    const membershipCall = repositorySource.indexOf('directGrantBelongsToMembership(');
    expect(membershipCall).toBeGreaterThanOrEqual(0);
    const membershipArgs = repositorySource.slice(membershipCall, membershipCall + 260);
    expect(membershipArgs).toContain('existing.permissions');
    expect(membershipArgs).toContain('existing.updatedAt');
    expect(membershipArgs).toContain('membershipJoinedAt');
    expect(repositorySource).toContain('existingIsCurrentMembership ? sanitizeScopes(existing?.permissions) : []');
    expect(repositorySource).toContain('storedDirectPermissions(next, epoch)');
    expect(repositorySource).toContain('tx.guildPermissionGrant.deleteMany');
    expect(repositorySource).toContain('tx.guildPermissionRoleGrant.deleteMany');

    const directRead = repositorySource.indexOf('tx.guildPermissionGrant.findUnique');
    const directWrite = repositorySource.indexOf('tx.guildPermissionGrant.upsert');
    const roleRead = repositorySource.indexOf('tx.guildPermissionRoleGrant.findUnique');
    const roleWrite = repositorySource.indexOf('tx.guildPermissionRoleGrant.upsert');
    expect(directWrite).toBeGreaterThan(directRead);
    expect(roleWrite).toBeGreaterThan(roleRead);
  });

  test('membership-generation conflicts surface as 409 instead of stale overwrite or generic 500', () => {
    expect(permissionRouteSource).toContain('PermissionMembershipEpochConflictError');
    expect(permissionRouteSource).toContain('res.status(409).json');
    expect(permissionRouteSource).toContain('code: error.code');
    expect(commandPermissionsSource).toContain('PermissionMembershipEpochConflictError');
    expect(commandPermissionsSource).toContain('Mitgliedschaft hat sich geaendert');
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
