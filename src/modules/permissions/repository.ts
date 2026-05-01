/**
 * Permissions-Repository — Subuser-Grants pro Guild.
 *
 * SCOPE-PFLICHT: jede Funktion verlangt `guildId` als ersten Parameter.
 */

import prisma from '../../database/prisma';
import type { GuildId, UserDiscordId, PermissionScope } from '../../types/scope';
import { NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../types/scope';

export interface PermissionGrantRow {
  userDiscordId: UserDiscordId;
  permissions: PermissionScope[];
  grantedBy: UserDiscordId;
  updatedAt: Date;
}

function sanitizeScopes(raw: unknown): PermissionScope[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(PERMISSION_SCOPES as readonly string[]);
  return raw
    .filter((s): s is string => typeof s === 'string' && valid.has(s))
    .filter(s => !NON_DELEGABLE_SCOPES.has(s as PermissionScope)) as PermissionScope[];
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
    permissions: sanitizeScopes(row.permissions),
    grantedBy: row.grantedByDiscordId as UserDiscordId,
    updatedAt: row.updatedAt,
  };
}

export async function listGrants(guildId: GuildId): Promise<PermissionGrantRow[]> {
  const rows = await prisma.guildPermissionGrant.findMany({ where: { guildId } });
  return rows.map(r => ({
    userDiscordId: r.userDiscordId as UserDiscordId,
    permissions: sanitizeScopes(r.permissions),
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
  if (NON_DELEGABLE_SCOPES.has(scope)) {
    throw new Error(`Scope ${scope} ist nicht delegierbar (Owner-only).`);
  }
  const existing = await getGrant(guildId, userDiscordId);
  const current = new Set<PermissionScope>(existing?.permissions ?? []);
  if (enabled) current.add(scope);
  else current.delete(scope);
  const next = Array.from(current);

  const row = await prisma.guildPermissionGrant.upsert({
    where: { guildId_userDiscordId: { guildId, userDiscordId } },
    create: {
      guildId,
      userDiscordId,
      permissions: next,
      grantedByDiscordId: grantedBy,
    },
    update: {
      permissions: next,
      grantedByDiscordId: grantedBy,
    },
  });
  return {
    userDiscordId: row.userDiscordId as UserDiscordId,
    permissions: sanitizeScopes(row.permissions),
    grantedBy: row.grantedByDiscordId as UserDiscordId,
    updatedAt: row.updatedAt,
  };
}

export async function deleteGrant(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<void> {
  await prisma.guildPermissionGrant.deleteMany({
    where: { guildId, userDiscordId },
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
    permissions: sanitizeScopes(r.permissions),
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
  if (NON_DELEGABLE_SCOPES.has(scope)) {
    throw new Error(`Scope ${scope} ist nicht delegierbar (Owner-only).`);
  }
  const existing = await prisma.guildPermissionRoleGrant.findUnique({
    where: { guildId_roleDiscordId: { guildId, roleDiscordId } },
  });
  const current = new Set<PermissionScope>(sanitizeScopes(existing?.permissions));
  if (enabled) current.add(scope);
  else current.delete(scope);
  const next = Array.from(current);

  const row = await prisma.guildPermissionRoleGrant.upsert({
    where: { guildId_roleDiscordId: { guildId, roleDiscordId } },
    create: {
      guildId, roleDiscordId,
      permissions: next,
      grantedByDiscordId: grantedBy,
    },
    update: {
      permissions: next,
      grantedByDiscordId: grantedBy,
    },
  });
  return {
    roleDiscordId: row.roleDiscordId,
    permissions: sanitizeScopes(row.permissions),
    grantedBy: row.grantedByDiscordId as UserDiscordId,
    updatedAt: row.updatedAt,
  };
}

export async function deleteRoleGrant(guildId: GuildId, roleDiscordId: string): Promise<void> {
  await prisma.guildPermissionRoleGrant.deleteMany({ where: { guildId, roleDiscordId } });
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
    for (const s of sanitizeScopes(row.permissions)) out.add(s);
  }
  return out;
}
