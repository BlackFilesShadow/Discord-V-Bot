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
import { listGrants, setGrantScope, deleteGrant } from '../../../modules/permissions/repository';
import { asUserDiscordId, NON_DELEGABLE_SCOPES, PERMISSION_SCOPES } from '../../../types/scope';
import type { PermissionScope } from '../../../types/scope';
import { logAudit } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const permissionsRouter = Router({ mergeParams: true });

permissionsRouter.get('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const grants = await listGrants(scope.guildId);
  res.json({
    grants: grants.map(g => ({
      userDiscordId: g.userDiscordId,
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

permissionsRouter.put('/:userDiscordId/:scope', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const perm = parseScope(String(req.params.scope));
  if (!perm) { res.status(400).json({ error: 'Unbekannter Scope.' }); return; }
  if (NON_DELEGABLE_SCOPES.has(perm)) { res.status(403).json({ error: 'Scope nicht delegierbar.' }); return; }
  const out = await setGrantScope(scope.guildId, target, perm, true, asUserDiscordId(scope.actorDiscordId));
  logAudit('PERM_GRANTED', 'PERMISSIONS', { guildId: scope.guildId, target, perm, actor: scope.actorDiscordId });
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
  logAudit('PERM_REVOKED', 'PERMISSIONS', { guildId: scope.guildId, target, perm, actor: scope.actorDiscordId });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ permissions: out.permissions });
});

permissionsRouter.delete('/:userDiscordId', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  await deleteGrant(scope.guildId, target);
  logAudit('PERM_USER_PURGED', 'PERMISSIONS', { guildId: scope.guildId, target, actor: scope.actorDiscordId });
  emitGuildEvent(scope.guildId, { type: 'permissions.updated', payload: { guildId: scope.guildId, userDiscordId: target } });
  res.json({ ok: true });
});
