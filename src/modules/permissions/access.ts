import type { Guild, GuildMember } from 'discord.js';
import prisma from '../../database/prisma';
import { NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../types/scope';
import type { PermissionScope } from '../../types/scope';

const VALID_DELEGABLE_SCOPES = new Set<PermissionScope>(
  PERMISSION_SCOPES.filter(scope => !NON_DELEGABLE_SCOPES.has(scope)),
);
const MEMBERSHIP_EPOCH_PREFIX = '__vbot_membership_joined_at:';

/**
 * Ein Authorizer darf niemals rohe Permission-Strings aus der DB uebernehmen.
 * Legacy-/manuell korrupte sowie NON_DELEGABLE-Scopes werden fail-closed
 * verworfen; interne Membership-Metadaten werden ebenfalls nie zu einem Scope.
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

/**
 * Neue Direct-Grant-Zeilen tragen ihre Discord-Mitgliedschaftsepoche im
 * bestehenden JSON-Array. Dadurch braucht 1V keine riskante Schema-Migration,
 * besitzt aber trotzdem eine durable Generation gegen Leave/Rejoin-ABA-Races.
 * Der reservierte Wert wird von delegatedPermissionSet konstruktiv ignoriert.
 */
export function membershipEpochMarker(joinedAt: Date): string {
  return `${MEMBERSHIP_EPOCH_PREFIX}${joinedAt.toISOString()}`;
}

export function directGrantMembershipEpoch(raw: unknown): Date | null {
  if (!Array.isArray(raw)) return null;
  const markers = raw.filter(
    (value): value is string => typeof value === 'string' && value.startsWith(MEMBERSHIP_EPOCH_PREFIX),
  );
  // Mehrere Marker oder ein kaputter Marker sind absichtlich fail-closed.
  if (markers.length !== 1) return null;
  const timestamp = markers[0].slice(MEMBERSHIP_EPOCH_PREFIX.length);
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) return null;
  const parsed = new Date(millis);
  return parsed.toISOString() === timestamp ? parsed : null;
}

export function storedDirectPermissions(scopes: Iterable<PermissionScope>, joinedAt: Date): string[] {
  return [membershipEpochMarker(joinedAt), ...Array.from(new Set(scopes)).sort()];
}

export interface DelegatedPermissionContext {
  member: GuildMember | null;
  permissions: Set<PermissionScope>;
}

/**
 * Direct-Grants sind an exakt eine Discord-Mitgliedschaftsepoche gebunden.
 *
 * Neue/normalisierte Zeilen enthalten einen expliziten Marker und muessen
 * exakt mit `member.joinedAt` uebereinstimmen. Fuer bestehende Legacy-Zeilen
 * ohne Marker bleibt einmalig der konservative updatedAt>=joinedAt-Fallback,
 * damit gueltige Bestandsgrants nicht beim Deploy pauschal verschwinden. Jede
 * spaetere Mutation normalisiert die Zeile und schreibt den Marker.
 */
export function directGrantBelongsToMembership(
  rawPermissions: unknown,
  grantUpdatedAt: Date | null | undefined,
  memberJoinedAt: Date | null | undefined,
): boolean {
  if (!memberJoinedAt) return false;
  const explicitEpoch = directGrantMembershipEpoch(rawPermissions);
  if (explicitEpoch) return explicitEpoch.getTime() === memberJoinedAt.getTime();
  if (!grantUpdatedAt) return false;
  return grantUpdatedAt.getTime() >= memberJoinedAt.getTime();
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
      select: { permissions: true, updatedAt: true },
    }),
    roleIds.length > 0
      ? prisma.guildPermissionRoleGrant.findMany({
          where: { guildId: guild.id, roleDiscordId: { in: roleIds } },
          select: { permissions: true },
        })
      : Promise.resolve([]),
  ]);

  const permissions = directGrantBelongsToMembership(
    directGrant?.permissions,
    directGrant?.updatedAt,
    member.joinedAt,
  )
    ? delegatedPermissionSet(directGrant?.permissions)
    : new Set<PermissionScope>();
  for (const roleGrant of roleGrants) {
    for (const scope of delegatedPermissionSet(roleGrant.permissions)) permissions.add(scope);
  }

  return { member, permissions };
}
