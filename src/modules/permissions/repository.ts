/**
 * Permissions-Repository — Subuser-Grants pro Guild.
 *
 * SCOPE-PFLICHT: jede Funktion verlangt `guildId` als ersten Parameter.
 * Schreibzugriffe laufen ausnahmslos ueber die kanonische, cross-process
 * serialisierte Permission-Mutationsengine.
 */

import prisma from '../../database/prisma';
import type { GuildId, UserDiscordId, PermissionScope } from '../../types/scope';
import { mutatePermissionGrant } from './mutationService';
import { sanitizeDelegablePermissionScopes } from './policy';

export interface PermissionGrantRow {
  userDiscordId: UserDiscordId;
  permissions: PermissionScope[];
  grantedBy: UserDiscordId;
  updatedAt: Date;
}

export async function getGrant(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<PermissionGrantRow | null> {
  const row = await prisma.guildPermissionGrant.findUnique({
    where: { guildId_userDiscordId: { guildId, userDiscordId } },
  });
  if (!row) return null;
  return {
    userDiscordId: row.userDiscordId as UserDiscordId,
    permissions: sanitizeDelegablePermissionScopes(row.permissions),
    grantedBy: row.grantedByDiscordId as UserDiscordId,
    updatedAt: row.updatedAt,
  };
}

export async function listGrants(guildId: GuildId): Promise<PermissionGrantRow[]> {
  const rows = await prisma.guildPermissionGrant.findMany({ where: { guildId } });
  return rows.map(r => ({
    userDiscordId: r.userDiscordId as UserDiscordId,
    permissions: sanitizeDelegablePermissionScopes(r.permissions),
    grantedBy: r.grantedByDiscordId as UserDiscordId,
    updatedAt: r.updatedAt,
  }));
}

export async function setGrantScope(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
  scope: PermissionScope,
  enabled: boolean,
  grantedBy: UserDiscordId,
): Promise<PermissionGrantRow> {
  const result = await mutatePermissionGrant({
    guildId,
    targetKind: 'USER',
    targetId: userDiscordId,
    action: enabled ? 'GRANT' : 'REVOKE',
    permission: scope,
    grantedBy,
  });
  const row = await prisma.guildPermissionGrant.findUnique({
    where: { guildId_userDiscordId: { guildId, userDiscordId } },
  });
  return {
    userDiscordId,
    permissions: result.permissions,
    grantedBy: row?.grantedByDiscordId as UserDiscordId ?? grantedBy,
    updatedAt: row?.updatedAt ?? new Date(),
  };
}

export async function deleteGrant(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<void> {
  await mutatePermissionGrant({
    guildId,
    targetKind: 'USER',
    targetId: userDiscordId,
    action: 'PURGE',
    grantedBy: userDiscordId,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Role-based grants (parallel zu user-grants).
// ────────────────────────────────────────────────────────────────────────────

export interface PermissionRoleGrantRow {
  roleDiscordId: string;
  permissions: PermissionScope[];
  grantedBy: UserDiscordId;
  updatedAt: Date;
}

export async function listRoleGrants(guildId: GuildId): Promise<PermissionRoleGrantRow[]> {
  const rows = await prisma.guildPermissionRoleGrant.findMany({ where: { guildId } });
  return rows.map(r => ({
    roleDiscordId: r.roleDiscordId,
    permissions: sanitizeDelegablePermissionScopes(r.permissions),
    grantedBy: r.grantedByDiscordId as UserDiscordId,
    updatedAt: r.updatedAt,
  }));
}

export async function setRoleGrantScope(
  guildId: GuildId,
  roleDiscordId: string,
  scope: PermissionScope,
  enabled: boolean,
  grantedBy: UserDiscordId,
): Promise<PermissionRoleGrantRow> {
  const result = await mutatePermissionGrant({
    guildId,
    targetKind: 'ROLE',
    targetId: roleDiscordId,
    action: enabled ? 'GRANT' : 'REVOKE',
    permission: scope,
    grantedBy,
  });
  const row = await prisma.guildPermissionRoleGrant.findUnique({
    where: { guildId_roleDiscordId: { guildId, roleDiscordId } },
  });
  return {
    roleDiscordId,
    permissions: result.permissions,
    grantedBy: row?.grantedByDiscordId as UserDiscordId ?? grantedBy,
    updatedAt: row?.updatedAt ?? new Date(),
  };
}

export async function deleteRoleGrant(guildId: GuildId, roleDiscordId: string): Promise<void> {
  await mutatePermissionGrant({
    guildId,
    targetKind: 'ROLE',
    targetId: roleDiscordId,
    action: 'PURGE',
    grantedBy: '' as UserDiscordId,
  });
}

/**
 * Liefert die Vereinigung aller Scopes, die dem User ueber seine ROLLEN
 * gewaehrt wurden. Erfordert die Liste seiner Role-IDs in der Guild.
 */
export async function getEffectiveRoleScopes(
  guildId: GuildId,
  roleIds: ReadonlyArray<string>,
): Promise<Set<PermissionScope>> {
  if (roleIds.length === 0) return new Set();
  const rows = await prisma.guildPermissionRoleGrant.findMany({
    where: { guildId, roleDiscordId: { in: roleIds as string[] } },
  });
  const out = new Set<PermissionScope>();
  for (const row of rows) {
    for (const s of sanitizeDelegablePermissionScopes(row.permissions)) out.add(s);
  }
  return out;
}
