/**
 * Permissions-Repository — Subuser-Grants pro Guild.
 *
 * SCOPE-PFLICHT: jede Funktion verlangt `guildId` als ersten Parameter.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import type { GuildId, UserDiscordId, PermissionScope } from '../../types/scope';
import { NON_DELEGABLE_SCOPES } from '../../types/scope';
import {
  delegatedPermissionSet,
  directGrantBelongsToMembership,
  directGrantMembershipEpoch,
  storedDirectPermissions,
} from './access';

export interface PermissionGrantRow {
  userDiscordId: UserDiscordId;
  permissions: PermissionScope[];
  grantedBy: UserDiscordId;
  updatedAt: Date;
}

export class PermissionMembershipEpochConflictError extends Error {
  readonly code = 'PERMISSION_MEMBERSHIP_EPOCH_CONFLICT';

  constructor() {
    super('Die Discord-Mitgliedschaft hat sich waehrend der Permission-Aktion geaendert.');
    this.name = 'PermissionMembershipEpochConflictError';
  }
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
 * Neue/normalisierte Direct-Grants tragen im JSON-Permissionsarray einen
 * internen Membership-Epoch-Marker. Das verhindert einen ABA-Race, bei dem ein
 * Request aus Mitgliedschaft A erst nach Leave+Rejoin in Mitgliedschaft B
 * committed und dadurch einen frischen Grant aus B ueberschreiben/reaktivieren
 * koennte. Eine bereits neuere Epoche gewinnt immer und der alte Request endet
 * sichtbar als Conflict statt Daten zu verlieren.
 */
export async function setGrantScope(
  guildId: GuildId,
  userDiscordId: UserDiscordId,
  scope: PermissionScope,
  enabled: boolean,
  grantedBy: UserDiscordId,
  membershipJoinedAt: Date | null = null,
): Promise<PermissionGrantRow> {
  // Owner-only/non-delegable Scopes duerfen niemals neu gesetzt werden. Ein
  // expliziter Revoke bleibt dagegen erlaubt, damit historisch korrupte Zeilen
  // fail-safe bereinigt werden koennen statt beim DELETE als 500 zu enden.
  if (enabled && NON_DELEGABLE_SCOPES.has(scope)) {
    throw new Error(`Scope ${scope} ist nicht delegierbar (Owner-only).`);
  }
  if (enabled && !membershipJoinedAt) {
    throw new Error('Aktuelle Guild-Mitgliedschaft ist fuer Permission-Grant erforderlich.');
  }

  return serializablePermissionMutation(async tx => {
    const existing = await tx.guildPermissionGrant.findUnique({
      where: { guildId_userDiscordId: { guildId, userDiscordId } },
    });

    const storedEpoch = directGrantMembershipEpoch(existing?.permissions);
    if (storedEpoch && membershipJoinedAt && storedEpoch.getTime() > membershipJoinedAt.getTime()) {
      // Ein Request aus einer aelteren Mitgliedschaft darf niemals eine bereits
      // persistierte neuere Mitgliedschaftsepoche ueberschreiben oder loeschen.
      throw new PermissionMembershipEpochConflictError();
    }
    if (storedEpoch && !membershipJoinedAt) {
      // Fehlender Live-Member-Beweis ist fuer eine bereits generationierte Zeile
      // kein Grund fuer destruktives Loeschen: koennte ein temporaerer Discord-
      // Fetchfehler sein. Voll-Purge bleibt ueber deleteGrant explizit moeglich.
      throw new PermissionMembershipEpochConflictError();
    }

    const existingIsCurrentMembership = !!existing
      && directGrantBelongsToMembership(existing.permissions, existing.updatedAt, membershipJoinedAt);

    // Bei einem Revoke auf einer eindeutig aelteren/Legacy-Epoche wird die alte
    // Zeile komplett entfernt. So kann ein Teil-Revoke alte Rest-Scopes nicht
    // durch einen frischen updatedAt-Write wieder aktivieren.
    if (!enabled && !existingIsCurrentMembership) {
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

    // enabled=true hat oben membershipJoinedAt erzwungen; fuer current revoke
    // ist existingIsCurrentMembership nur mit membershipJoinedAt=true moeglich.
    const epoch = membershipJoinedAt!;
    const persistedPermissions = storedDirectPermissions(next, epoch);
    const row = await tx.guildPermissionGrant.upsert({
      where: { guildId_userDiscordId: { guildId, userDiscordId } },
      create: {
        guildId,
        userDiscordId,
        permissions: persistedPermissions,
        grantedByDiscordId: grantedBy,
      },
      update: {
        permissions: persistedPermissions,
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
  if (enabled && NON_DELEGABLE_SCOPES.has(scope)) {
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
