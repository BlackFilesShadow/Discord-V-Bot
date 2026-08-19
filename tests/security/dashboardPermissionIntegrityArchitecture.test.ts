import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const authSource = read('src/dashboard/middleware/auth.ts');
const guildListSource = read('src/dashboard/routes/v2/guilds.ts');
const permissionRouteSource = read('src/dashboard/routes/v2/permissions.ts');
const repositorySource = read('src/modules/permissions/repository.ts');
const socketSource = read('src/dashboard/socket/guild.ts');
const leaveSource = read('src/events/guildMemberRemove.ts');
const joinSource = read('src/events/guildMemberAdd.ts');

describe('Dashboard-1V permission membership/data-integrity/race architecture', () => {
  test('REST permission guards resolve current membership before reading delegated grants', () => {
    const exact = authSource.indexOf("export function requireGuildPermission");
    const access = authSource.indexOf("export async function requireGuildAccess");
    const exactMember = authSource.indexOf('await guild.members.fetch(req.auth.discordId)', exact);
    const exactGrant = authSource.indexOf('prisma.guildPermissionGrant.findUnique', exact);
    const accessMember = authSource.indexOf('await guild.members.fetch(req.auth.discordId)', access);
    const accessGrant = authSource.indexOf('prisma.guildPermissionGrant.findUnique', access);

    expect(exactMember).toBeGreaterThan(exact);
    expect(exactGrant).toBeGreaterThan(exactMember);
    expect(accessMember).toBeGreaterThan(access);
    expect(accessGrant).toBeGreaterThan(accessMember);
    expect(authSource).toContain("VALID_DELEGABLE_SCOPES");
    expect(authSource).toContain("GUILD_MEMBERSHIP_REQUIRED");
  });

  test('guild list and socket never treat a stale DB grant as membership evidence', () => {
    const candidates = guildListSource.indexOf('for (const guildId of candidateGuildIds)');
    const member = guildListSource.indexOf('await guild.members.fetch(req.auth.discordId)', candidates);
    const directAllow = guildListSource.indexOf('if (directGrantGuildIds.has(guildId))', candidates);
    expect(candidates).toBeGreaterThanOrEqual(0);
    expect(member).toBeGreaterThan(candidates);
    expect(directAllow).toBeGreaterThan(member);

    const resolver = socketSource.indexOf('export async function resolveGuildAccess');
    const socketMember = socketSource.indexOf('await guild.members.fetch(userDiscordId)', resolver);
    const socketGrant = socketSource.indexOf('prisma.guildPermissionGrant.findUnique', resolver);
    expect(socketMember).toBeGreaterThan(resolver);
    expect(socketGrant).toBeGreaterThan(socketMember);
  });

  test('direct grants are revoked at leave and defensively cleared before a rejoin can reactivate them', () => {
    const leaveDelete = leaveSource.indexOf('prisma.guildPermissionGrant.deleteMany');
    const cleanupConfig = leaveSource.indexOf('await getLeaveCleanupConfig');
    const joinDelete = joinSource.indexOf('prisma.guildPermissionGrant.deleteMany');
    const joinProfile = joinSource.indexOf('await syncMemberProfile(m)');

    expect(leaveDelete).toBeGreaterThanOrEqual(0);
    expect(leaveDelete).toBeLessThan(cleanupConfig);
    expect(joinDelete).toBeGreaterThanOrEqual(0);
    expect(joinDelete).toBeLessThan(joinProfile);
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
});
