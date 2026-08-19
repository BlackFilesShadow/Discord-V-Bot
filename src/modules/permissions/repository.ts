/**
 * Permissions-Repository — Subuser-Grants pro Guild.
 *
 * SCOPE-PFLICHT: jede Funktion verlangt `guildId` als ersten Parameter.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import type { GuildId, UserDiscordId, PermissionScope } from '../../types/scope';
import { NON_DELEGABLE_SCOPES } from '../../types/scope';
import { delegatedPermissionSet, directGrantBelongsToMembership } from './access';

export interface PermissionGrantRow {
  userDiscordId: UserDiscordId;
  permissions: PermissionScope[];
  grantedBy: UserDiscordId;
  updatedAt: Date;
}

function sanitizeScopes(raw: unknown): PermissionScope[] {
  return Array.from(delegatedPermissionSet(raw)).sort();
}

async function serializablePermissionMutation<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const retryable = code === 'P2034' || code === 'P2002';
      if (!retryable || attempt === maxAttempts) throw error;
    }
  }
  throw new Error('Permission-Transaktion konnte nicht abgeschlossen werden.');
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
  return rows
    .map(r => ({
      userDiscordId: r.userDiscordId as UserDiscordId,
      permissions: sanitizeScopes(r.permissions),
      grantedBy: r.grantedByDiscordId as UserDiscordId,
      updatedAt: r.updatedAt,
    }))
    .filter(row => row.permissions.length > 0);
}

/**
 * Setzt einen User-Scope innerhalb einer SERIALIZABLE-Transaktion.
 *
 * `membershipJoinedAt` ist fuer Aktivierungen Pflicht und beschreibt die durch
 * Discord live validierte aktuelle Mitgliedschaft. Eine vorhandene Grant-Zeile
 * aus einer aelteren Mitgliedschaft wird niemals als Ausgangsbasis verwendet:
 * beim Grant startet sie leer, beim Revoke wird sie komplett entfernt. Damit
 * kann eine einzelne frische Mutation nach Rejoin keine alten Scopes ungewollt
 * wieder auf `updatedAt=now` heben und reaktivieren.
 *
 * Bei Revoke ohne aktuell beweisbare Mitgliedschaft wird die ganze Direct-Grant-
 * Zeile entfernt. Das ist fail-closed und verhindert, dass ein Cleanup-Request
 * auf einem ausgetretenen User verbleibende alte Scopes frisch timestamped.
 */
export async function setGrantScope(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
  scope: PermissionScope,
  enabled: boolean,
  grantedBy: UserDiscordId,
  membershipJoinedAt: Date | null = null,
): Promise<PermissionGrantRow> {
  if (NON_DELEGABLE_SCOPES.has(scope)) {
    throw new Error(`Scope ${scope} ist nicht delegierbar (Owner-only).`);
  }
  if (enabled && !membershipJoinedAt) {
    throw new Error('Aktuelle Guild-Mitgliedschaft ist fuer Permission-Grant erforderlich.');
  }

  return serializablePermissionMutation(async tx => {
    const existing = await tx.guildPermissionGrant.findUnique({
      where: { guildId_userDiscordId: { guildId, userDiscordId } },
    });

    const existingIsCurrentMembership = !!existing
      && directGrantBelongsToMembership(existing.updatedAt, membershipJoinedAt);

    // Ohne aktuelle Mitgliedschaft oder bei einer alten Mitgliedschaftsepoche
    // darf ein Revoke niemals die Rest-Scopes durch einen frischen updatedAt-
    // Write reaktivieren. Alte/ungeklaerte Direct-Grants werden vollstaendig
    // entfernt; der Owner kann nach sauberer Mitgliedschaft neu delegieren.
    if (!enabled && (!membershipJoinedAt || !existingIsCurrentMembership)) {
      await tx.guildPermissionGrant.deleteMany({ where: { guildId, userDiscordId } });
      return { userDiscordId, permissions: [], grantedBy, updatedAt: new Date() };
    }

    const current = new Set<PermissionScope>(
      existingIsCurrentMembership ? sanitizeScopes(existing?.permissions) : [],
    );
    if (enabled) current.add(scope);
    else current.delete(scope);
    const next = Array.from(current).sort();

    // Jede Mutation normalisiert die komplette Zeile. Dadurch verschwinden
    // leere oder historisch korrupte/non-delegable Werte beim naechsten Write.
    if (next.length === 0) {
      await tx.guildPermissionGrant.deleteMany({
        where: { guildId, userDiscordId },
      });
      return {
        userDiscordId,
        permissions: [],
        grantedBy,
        updatedAt: new Date(),
      };
    }

    const row = await tx.guildPermissionGrant.upsert({
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
  });
}

export async function deleteGrant(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
): Promise<void> {
  await serializablePermissionMutation(async tx => {
    await tx.guildPermissionGrant.deleteMany({
      where: { guildId, userDiscordId },
    });
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
  return rows
    .map(r => ({
      roleDiscordId: r.roleDiscordId,
      permissions: sanitizeScopes(r.permissions),
      grantedBy: r.grantedByDiscordId as UserDiscordId,
      updatedAt: r.updatedAt,
    }))
    .filter(row => row.permissions.length > 0);
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

  return serializablePermissionMutation(async tx => {
    const existing = await tx.guildPermissionRoleGrant.findUnique({
      where: { guildId_roleDiscordId: { guildId, roleDiscordId } },
    });
    const current = new Set<PermissionScope>(sanitizeScopes(existing?.permissions));
    if (enabled) current.add(scope);
    else current.delete(scope);
    const next = Array.from(current).sort();

    if (next.length === 0) {
      await tx.guildPermissionRoleGrant.deleteMany({
        where: { guildId, roleDiscordId },
      });
      return {
        roleDiscordId,
        permissions: [],
        grantedBy,
        updatedAt: new Date(),
      };
    }

    const row = await tx.guildPermissionRoleGrant.upsert({
      where: { guildId_roleDiscordId: { guildId, roleDiscordId } },
      create: {
        guildId,
        roleDiscordId,
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
  });
}

export async function deleteRoleGrant(guildId: GuildId, roleDiscordId: string): Promise<void> {
  await serializablePermissionMutation(async tx => {
    await tx.guildPermissionRoleGrant.deleteMany({ where: { guildId, roleDiscordId } });
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
    for (const s of sanitizeScopes(row.permissions)) out.add(s);
  }
  return out;
}
