import type { Guild, GuildMember } from 'discord.js';
import prisma from '../../database/prisma';
import { NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../types/scope';
import type { PermissionScope } from '../../types/scope';

const VALID_DELEGABLE_SCOPES = new Set<PermissionScope>(
  PERMISSION_SCOPES.filter(scope => !NON_DELEGABLE_SCOPES.has(scope)),
);

/**
 * Ein Authorizer darf niemals rohe Permission-Strings aus der DB uebernehmen.
 * Legacy-/manuell korrupte sowie NON_DELEGABLE-Scopes werden fail-closed
 * verworfen; Owner-only bleibt damit konstruktiv Owner-only.
 */
export function delegatedPermissionSet(raw: unknown): Set<PermissionScope> {
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<PermissionScope>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const scope = value as PermissionScope;
    if (VALID_DELEGABLE_SCOPES.has(scope)) out.add(scope);
  }
  return out;
}

export function hasDelegablePermission(raw: unknown): boolean {
  return delegatedPermissionSet(raw).size > 0;
}

export interface DelegatedPermissionContext {
  member: GuildMember | null;
  permissions: Set<PermissionScope>;
}

/**
 * Kanonische Nicht-Owner-Aufloesung fuer HTTP, Socket und Discord-Commands.
 * Reihenfolge ist Security-relevant: zuerst aktuelle Guild-Mitgliedschaft,
 * erst danach Direct-/Role-Grants. Ein stale DB-Grant kann daher niemals eine
 * Mitgliedschaft ersetzen oder bei Rejoin unbemerkt reaktiviert werden.
 */
export async function resolveDelegatedPermissionContext(
  guild: Guild,
  userDiscordId: string,
): Promise<DelegatedPermissionContext> {
  const member = guild.members.cache.get(userDiscordId)
    ?? await guild.members.fetch(userDiscordId).catch(() => null);
  if (!member) return { member: null, permissions: new Set() };

  const roleIds = Array.from(member.roles.cache.keys());
  const [directGrant, roleGrants] = await Promise.all([
    prisma.guildPermissionGrant.findUnique({
      where: { guildId_userDiscordId: { guildId: guild.id, userDiscordId } },
      select: { permissions: true },
    }),
    roleIds.length > 0
      ? prisma.guildPermissionRoleGrant.findMany({
          where: { guildId: guild.id, roleDiscordId: { in: roleIds } },
          select: { permissions: true },
        })
      : Promise.resolve([]),
  ]);

  const permissions = delegatedPermissionSet(directGrant?.permissions);
  for (const roleGrant of roleGrants) {
    for (const scope of delegatedPermissionSet(roleGrant.permissions)) permissions.add(scope);
  }

  return { member, permissions };
}
