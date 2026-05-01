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
import { asUserDiscordId, NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../../types/scope';
import type { PermissionScope } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const permissionsRouter = Router({ mergeParams: true });

permissionsRouter.get('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const [grants, roleGrants] = await Promise.all([
    listGrants(scope.guildId),
    listRoleGrants(scope.guildId),
  ]);
  res.json({
    grants: grants.map(g => ({
      userDiscordId: g.userDiscordId,
      permissions: g.permissions,
      grantedBy: g.grantedBy,
      updatedAt: g.updatedAt,
    })),
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

// ── Role-based grants (registered BEFORE the user catch-all routes!) ──────

permissionsRouter.put('/roles/:roleId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const roleId = String(req.params.roleId);
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'roleId ungueltig.' }); return; }
  if (roleId === scope.guildId) { res.status(403).json({ error: '@everyone-Rolle ist nicht delegierbar.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  if (NON_DELEGABLE_SCOPES.has(perm)) { res.status(403).json({ error: 'Scope nicht delegierbar.' }); return; }
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
  const out = await setGrantScope(scope.guildId, target, perm, true, asUserDiscordId(scope.actorDiscordId));
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
  const out = await setGrantScope(scope.guildId, target, perm, false, asUserDiscordId(scope.actorDiscordId));
  logAuditDb('PERM_REVOKED', 'ADMIN', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { target, perm } });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ permissions: out.permissions });
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
