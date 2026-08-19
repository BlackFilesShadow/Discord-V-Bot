/**
 * Permissions: nur Owner darf delegieren.
 *
 * GET    /                              listet alle Grants
 * PUT    /:userDiscordId/:scope         setzt scope=true
 * DELETE /:userDiscordId/:scope         setzt scope=false
 * DELETE /:userDiscordId                loescht alle Grants des Users
 */
import { Router } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import {
  listGrants, setGrantScope, deleteGrant,
  listRoleGrants, setRoleGrantScope, deleteRoleGrant,
} from '../../../modules/permissions/repository';
import { resolveDelegableRoleTarget, resolveDelegableUserTarget } from '../../../modules/permissions/targetValidation';
import { asUserDiscordId, NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../../types/scope';
import type { PermissionScope } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';

export const permissionsRouter = Router({ mergeParams: true });

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
        const member = guild.members.cache.get(g.userDiscordId)
          ?? await guild.members.fetch(g.userDiscordId).catch(() => null);
        if (member) {
          username = member.user.username;
          displayName = member.displayName ?? member.user.globalName ?? member.user.username;
          avatar = member.user.avatar ?? null;
        } else {
          const user = client?.users.cache.get(g.userDiscordId)
            ?? await client?.users.fetch(g.userDiscordId).catch(() => null);
          if (user) {
            username = user.username;
            displayName = user.globalName ?? user.username;
            avatar = user.avatar ?? null;
          }
        }
      } catch { /* owner can still see/purge the stale raw ID */ }
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

function currentGuild(guildId: string) {
  return tryGetDashboardClient()?.guilds.cache.get(guildId) ?? null;
}

permissionsRouter.put('/roles/:roleId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const roleId = String(req.params.roleId);
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'roleId ungueltig.' }); return; }
  if (roleId === scope.guildId) { res.status(403).json({ error: '@everyone-Rolle ist nicht delegierbar.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  if (NON_DELEGABLE_SCOPES.has(perm)) { res.status(403).json({ error: 'Scope nicht delegierbar.' }); return; }

  const guild = currentGuild(scope.guildId);
  if (!guild) { res.status(503).json({ error: 'Guild derzeit nicht sicher aufloesbar.' }); return; }
  const role = await resolveDelegableRoleTarget(guild, roleId);
  if (!role) { res.status(400).json({ error: 'Rolle existiert nicht in dieser Guild oder ist managed/nicht delegierbar.' }); return; }

  const actor = asUserDiscordId(scope.actorDiscordId);
  const out = await setRoleGrantScope(scope.guildId, roleId, perm, true, actor);
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
  const actor = asUserDiscordId(scope.actorDiscordId);
  const out = await setRoleGrantScope(scope.guildId, roleId, perm, false, actor);
  logAuditDb('PERM_ROLE_REVOKED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { roleId, perm } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, roleDiscordId: roleId } });
  res.json({ permissions: out.permissions });
});

permissionsRouter.delete('/roles/:roleId', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const roleId = String(req.params.roleId);
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'roleId ungueltig.' }); return; }
  if (roleId === scope.guildId) { res.status(403).json({ error: '@everyone-Rolle ist nicht delegierbar.' }); return; }
  const actor = asUserDiscordId(scope.actorDiscordId);
  await deleteRoleGrant(scope.guildId, roleId, actor);
  logAuditDb('PERM_ROLE_PURGED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { roleId } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, roleDiscordId: roleId } });
  res.json({ ok: true });
});

permissionsRouter.put('/:userDiscordId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  if (NON_DELEGABLE_SCOPES.has(perm)) { res.status(403).json({ error: 'Scope nicht delegierbar.' }); return; }

  const guild = currentGuild(scope.guildId);
  if (!guild) { res.status(503).json({ error: 'Guild derzeit nicht sicher aufloesbar.' }); return; }
  const member = await resolveDelegableUserTarget(guild, target);
  if (!member) { res.status(400).json({ error: 'User ist kein aktuelles Nicht-Bot-Mitglied dieser Guild.' }); return; }

  const actor = asUserDiscordId(scope.actorDiscordId);
  const out = await setGrantScope(scope.guildId, target, perm, true, actor);
  logAuditDb('PERM_GRANTED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target, perm } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ permissions: out.permissions });
});

permissionsRouter.delete('/:userDiscordId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  const actor = asUserDiscordId(scope.actorDiscordId);
  const out = await setGrantScope(scope.guildId, target, perm, false, actor);
  logAuditDb('PERM_REVOKED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target, perm } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ permissions: out.permissions });
});

permissionsRouter.delete('/:userDiscordId', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const actor = asUserDiscordId(scope.actorDiscordId);
  await deleteGrant(scope.guildId, target, actor);
  logAuditDb('PERM_USER_PURGED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ ok: true });
});
