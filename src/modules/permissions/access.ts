import type { Guild, GuildMember } from 'discord.js';
import prisma from '../../database/prisma';
import type { PermissionScope } from '../../types/scope';
import { sanitizeDelegablePermissionScopes } from './policy';

export interface GuildPermissionAccess {
  isOwner: boolean;
  isMember: boolean;
  allowed: boolean;
  permissions: Set<PermissionScope>;
  member: GuildMember | null;
}

/**
 * Canonical permission resolution for HTTP, Socket.IO and Discord commands.
 *
 * Direct grants are intentionally not considered until current Guild membership
 * is proven. This keeps stale rows after a leave fail-closed even when optional
 * destructive leave-cleanup is disabled. Only known delegable scopes are ever
 * returned; malformed/unknown/owner-only values in legacy rows cannot authorize.
 * Role grants are restricted to the member's current, non-managed roles and
 * explicitly exclude @everyone so legacy/corrupt rows cannot become global grants.
 */
export async function resolveGuildPermissionAccess(
  guild: Guild,
  userDiscordId: string,
): Promise<GuildPermissionAccess> {
  const isOwner = guild.ownerId === userDiscordId;
  if (isOwner) {
    return {
      isOwner: true,
      isMember: true,
      allowed: true,
      permissions: new Set<PermissionScope>(),
      member: guild.members.cache.get(userDiscordId) ?? null,
    };
  }

  const member = guild.members.cache.get(userDiscordId)
    ?? await guild.members.fetch(userDiscordId).catch(() => null);
  if (!member) {
    return {
      isOwner: false,
      isMember: false,
      allowed: false,
      permissions: new Set<PermissionScope>(),
      member: null,
    };
  }

  const roleIds = [...member.roles.cache.values()]
    .filter(role => role.id !== guild.id && !role.managed)
    .map(role => role.id);
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

  const permissions = new Set<PermissionScope>(
    sanitizeDelegablePermissionScopes(directGrant?.permissions),
  );
  for (const grant of roleGrants) {
    for (const permission of sanitizeDelegablePermissionScopes(grant.permissions)) {
      permissions.add(permission);
    }
  }

  return {
    isOwner: false,
    isMember: true,
    allowed: permissions.size > 0,
    permissions,
    member,
  };
}
