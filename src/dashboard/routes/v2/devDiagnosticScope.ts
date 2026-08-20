import type { Request, Response } from 'express';

/**
 * Globale DEV-Diagnosen duerfen in einer guild-beschraenkten DevSession nicht
 * sichtbar oder mutierbar sein. Der Guard wird erst NACH requireDev aufgerufen,
 * damit `req.devSession.scope` die serverseitig validierte Session-Wahrheit ist.
 */
export function rejectGlobalOnlyForRestrictedSession(req: Request, res: Response): boolean {
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  if (!restrict) return false;

  res.status(403).json({
    error: 'Diese globale DEV-Diagnose ist in einer Guild-beschraenkten Session gesperrt.',
    code: 'DEV_SCOPE_RESTRICTED',
  });
  return true;
}
