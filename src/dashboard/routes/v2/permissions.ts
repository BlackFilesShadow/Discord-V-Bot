/**
 * Permissions: nur Owner darf delegieren.
 *
 * GET    /                              listet alle Grants
 * PUT    /:userDiscordId/:scope         setzt scope=true
 * DELETE /:userDiscordId/:scope         setzt scope=false
 * DELETE /:userDiscordId                loescht alle Grants des Users
 */
import { Router, type Response } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import {
  listGrants, setGrantScope, deleteGrant, deleteGrantForMembershipEpoch,
  listRoleGrants, setRoleGrantScope, deleteRoleGrant,
  PermissionMembershipEpochConflictError,
} from '../../../modules/permissions/repository';
import { asUserDiscordId, NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../../types/scope';
import type { PermissionScope } from '../../../types/scope';
import { logAuditDb, logger } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';

export const permissionsRouter = Router({ mergeParams: true });

/**
 * Reichert User-Grants mit Username/DisplayName/Avatar aus dem Discord-Cache
 * an. Faellt auf den nackten Snowflake zurueck, wenn der Bot den User nicht
 * sieht (z.B. Member nicht mehr im Server). Avatar = Hash oder null;
 * Frontend baut die CDN-URL daraus.
 */
async function enrichGrants(
  guildId: string,
  grants: Array<{ userDiscordId: string; permissions: string[]; grantedBy: string; updatedAt: Date }>,
): Promise<Array<{
  userDiscordId: string;
  username: string | null;
  displayName: string | null;
  avatar: string | null;
  permissions: string[];
  grantedBy: string;
  updatedAt: Date;
}>> {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId) ?? null;
  return Promise.all(grants.map(async g => {
    let username: string | null = null;
    let displayName: string | null = null;
    let avatar: string | null = null;
    if (guild) {
      try {
        // Cache zuerst, dann Fetch (best-effort, swallow errors).
        const member = guild.members.cache.get(g.userDiscordId)
          ?? await guild.members.fetch(g.userDiscordId).catch(() => null);
        if (member) {
          username = member.user.username;
          displayName = member.displayName ?? member.user.globalName ?? member.user.username;
          avatar = member.user.avatar ?? null;
        } else {
          // Member nicht mehr in Guild: zumindest User-Objekt versuchen.
          const user = client?.users.cache.get(g.userDiscordId)
            ?? await client?.users.fetch(g.userDiscordId).catch(() => null);
          if (user) {
            username = user.username;
            displayName = user.globalName ?? user.username;
            avatar = user.avatar ?? null;
          }
        }
      } catch { /* swallow — Frontend zeigt fallback */ }
    }
    return {
      userDiscordId: g.userDiscordId,
      username, displayName, avatar,
      permissions: g.permissions,
      grantedBy: g.grantedBy,
      updatedAt: g.updatedAt,
    };
  }));
}

permissionsRouter.get('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const [grants, roleGrants] = await Promise.all([
    listGrants(scope.guildId),
    listRoleGrants(scope.guildId),
  ]);
  const enriched = await enrichGrants(scope.guildId, grants);
  res.json({
    grants: enriched,
    roleGrants: roleGrants.map(g => ({
      roleDiscordId: g.roleDiscordId,
      permissions: g.permissions,
      grantedBy: g.grantedBy,
      updatedAt: g.updatedAt,
    })),
    availableScopes: PERMISSION_SCOPES.filter(s => !NON_DELEGABLE_SCOPES.has(s)),
  });
});

function parseScope(raw: string): PermissionScope | null {
  if (!(PERMISSION_SCOPES as readonly string[]).includes(raw)) return null;
  return raw as PermissionScope;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

function respondMembershipEpochConflict(res: Response, error: unknown): boolean {
  if (!(error instanceof PermissionMembershipEpochConflictError)) return false;
  res.status(409).json({
    error: 'Die Discord-Mitgliedschaft hat sich waehrend der Permission-Aktion geaendert. Bitte Ansicht aktualisieren und erneut versuchen.',
    code: error.code,
  });
  return true;
}

async function resolveCurrentMember(guildId: string, userDiscordId: string) {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId) ?? null;
  if (!guild) return { kind: 'unavailable' as const };
  const member = guild.members.cache.get(userDiscordId)
    ?? await guild.members.fetch(userDiscordId).catch(() => null);
  if (!member) return { kind: 'missing' as const, guild };
  return { kind: 'member' as const, guild, member };
}

/**
 * Zweite, erzwungen frische Discord-Pruefung NACH dem DB-Commit. Sie schliesst
 * das verbleibende ABA-Fenster zwischen erster Member-Validierung und Commit:
 * ein Request aus Mitgliedschaft A darf nach Leave+Rejoin B weder als Erfolg
 * gemeldet werden noch eine wirkungslose A-Generation als Orphan hinterlassen.
 */
async function membershipEpochStillCurrent(
  guildId: string,
  userDiscordId: string,
  expectedJoinedAt: Date,
): Promise<boolean> {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId) ?? null;
  if (!guild) return false;
  const member = await guild.members.fetch({ user: userDiscordId, force: true }).catch(() => null);
  return !!member?.joinedAt && member.joinedAt.getTime() === expectedJoinedAt.getTime();
}

async function compensateStaleMembershipGeneration(
  guildId: ReturnType<typeof import('../../../types/scope').asGuildId>,
  userDiscordId: ReturnType<typeof asUserDiscordId>,
  expectedJoinedAt: Date,
): Promise<void> {
  try {
    await deleteGrantForMembershipEpoch(guildId, userDiscordId, expectedJoinedAt);
  } catch (error) {
    // Authorization bleibt trotzdem sicher: der kanonische Resolver akzeptiert
    // die alte Generation nicht. Der Fehler bleibt aber operativ sichtbar.
    logger.error(
      `Permission-Epoch-Kompensation fehlgeschlagen (${userDiscordId}@${guildId}):`,
      error,
    );
  }
}

async function resolveAssignableRole(guildId: string, roleId: string) {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId) ?? null;
  if (!guild) return { kind: 'unavailable' as const };
  const role = guild.roles.cache.get(roleId)
    ?? await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { kind: 'missing' as const };
  if (role.id === guild.id || role.managed) return { kind: 'invalid' as const };
  return { kind: 'role' as const, role };
}

// ── Role-based grants (registered BEFORE the user catch-all routes!) ──────

permissionsRouter.put('/roles/:roleId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const roleId = String(req.params.roleId);
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'roleId ungueltig.' }); return; }
  if (roleId === scope.guildId) { res.status(403).json({ error: '@everyone-Rolle ist nicht delegierbar.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  if (NON_DELEGABLE_SCOPES.has(perm)) { res.status(403).json({ error: 'Scope nicht delegierbar.' }); return; }

  const targetRole = await resolveAssignableRole(scope.guildId, roleId);
  if (targetRole.kind === 'unavailable') { res.status(503).json({ error: 'Guild/Rollen konnten nicht sicher validiert werden.' }); return; }
  if (targetRole.kind === 'missing') { res.status(404).json({ error: 'Rolle existiert nicht in dieser Guild.' }); return; }
  if (targetRole.kind === 'invalid') { res.status(403).json({ error: 'Managed/@everyone-Rollen sind nicht delegierbar.' }); return; }

  const out = await setRoleGrantScope(scope.guildId, roleId, perm, true, asUserDiscordId(scope.actorDiscordId));
  logAuditDb('PERM_ROLE_GRANTED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { roleId, perm } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, roleDiscordId: roleId } });
  res.json({ permissions: out.permissions });
});

permissionsRouter.delete('/roles/:roleId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const roleId = String(req.params.roleId);
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'roleId ungueltig.' }); return; }
  if (roleId === scope.guildId) { res.status(403).json({ error: '@everyone-Rolle ist nicht delegierbar.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  const out = await setRoleGrantScope(scope.guildId, roleId, perm, false, asUserDiscordId(scope.actorDiscordId));
  logAuditDb('PERM_ROLE_REVOKED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { roleId, perm } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, roleDiscordId: roleId } });
  res.json({ permissions: out.permissions });
});

permissionsRouter.delete('/roles/:roleId', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const roleId = String(req.params.roleId);
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'roleId ungueltig.' }); return; }
  if (roleId === scope.guildId) { res.status(403).json({ error: '@everyone-Rolle ist nicht delegierbar.' }); return; }
  await deleteRoleGrant(scope.guildId, roleId);
  logAuditDb('PERM_ROLE_PURGED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { roleId } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, roleDiscordId: roleId } });
  res.json({ ok: true });
});

// ── User-based grants ─────────────────────────────────────────────────────

permissionsRouter.put('/:userDiscordId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  if (NON_DELEGABLE_SCOPES.has(perm)) { res.status(403).json({ error: 'Scope nicht delegierbar.' }); return; }

  const targetMember = await resolveCurrentMember(scope.guildId, target);
  if (targetMember.kind === 'unavailable') { res.status(503).json({ error: 'Guild/Mitgliedschaft konnte nicht sicher validiert werden.' }); return; }
  if (targetMember.kind === 'missing') { res.status(404).json({ error: 'Ziel-User ist kein aktuelles Mitglied dieser Guild.' }); return; }
  if (!targetMember.member.joinedAt) { res.status(409).json({ error: 'Aktuelle Mitgliedschaftsepoche konnte nicht sicher bestimmt werden.' }); return; }
  if (targetMember.member.user.bot) { res.status(400).json({ error: 'Bots koennen keine delegierten Guild-Permissions erhalten.' }); return; }
  if (targetMember.guild.ownerId === target) { res.status(400).json({ error: 'Der Guild-Owner benoetigt keinen delegierten Grant.' }); return; }

  const expectedJoinedAt = targetMember.member.joinedAt;
  try {
    const out = await setGrantScope(
      scope.guildId,
      target,
      perm,
      true,
      asUserDiscordId(scope.actorDiscordId),
      expectedJoinedAt,
    );

    if (!(await membershipEpochStillCurrent(scope.guildId, target, expectedJoinedAt))) {
      await compensateStaleMembershipGeneration(scope.guildId, target, expectedJoinedAt);
      throw new PermissionMembershipEpochConflictError();
    }

    logAuditDb('PERM_GRANTED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target, perm } });
    emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
    res.json({ permissions: out.permissions });
  } catch (error) {
    if (respondMembershipEpochConflict(res, error)) return;
    throw error;
  }
});

permissionsRouter.delete('/:userDiscordId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }

  // Revoke bleibt fuer Legacy-/ausgetretene Ziele bereinigbar. Sobald eine
  // bereits generationierte neuere Zeile existiert, verhindert das Repository
  // jedoch destruktive ABA-Writes und liefert einen sichtbaren 409-Conflict.
  const targetMember = await resolveCurrentMember(scope.guildId, target);
  const membershipJoinedAt = targetMember.kind === 'member' ? targetMember.member.joinedAt : null;
  try {
    const out = await setGrantScope(
      scope.guildId,
      target,
      perm,
      false,
      asUserDiscordId(scope.actorDiscordId),
      membershipJoinedAt,
    );

    if (membershipJoinedAt && !(await membershipEpochStillCurrent(scope.guildId, target, membershipJoinedAt))) {
      await compensateStaleMembershipGeneration(scope.guildId, target, membershipJoinedAt);
      throw new PermissionMembershipEpochConflictError();
    }

    logAuditDb('PERM_REVOKED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target, perm } });
    emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
    res.json({ permissions: out.permissions });
  } catch (error) {
    if (respondMembershipEpochConflict(res, error)) return;
    throw error;
  }
});

permissionsRouter.delete('/:userDiscordId', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  await deleteGrant(scope.guildId, target);
  logAuditDb('PERM_USER_PURGED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ ok: true });
});
