import type { Request, Response, NextFunction } from 'express';
import { hasPermission, type PermissionScope } from '../../types/scope';
import { requireGuildAccess } from './auth';

/**
 * Baut zuerst einen authorisierten Guild-Scope auf und laesst danach nur
 * Requests passieren, die mindestens einen der angegebenen Domain-Scopes
 * besitzen. So koennen nachgelagerte serverbezogene Guards sicher auf
 * req.guildScope arbeiten, ohne fremde Guild-/Domain-Informationen zu leaken.
 *
 * Die exakte Route prueft ihr einzelnes view/manage-Recht weiterhin selbst.
 */
export function requireGuildAnyPermission(...permissions: PermissionScope[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let guildAccessPassed = false;
    await requireGuildAccess(req, res, () => { guildAccessPassed = true; });
    if (!guildAccessPassed) return;

    const scope = req.guildScope;
    if (!scope || !permissions.some(permission => hasPermission(scope, permission))) {
      res.status(403).json({ error: `Permission fehlt: ${permissions.join(' oder ')}` });
      return;
    }
    next();
  };
}
