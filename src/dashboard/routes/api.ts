import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';

/**
 * Legacy-API-Router (Sektion 7).
 *
 * SICHERHEIT (P0): Die frueheren, ungeschuetzten Admin-Endpoints
 * (/stats, /alerts, /users, /packages, /audit-logs, /security-events,
 * /giveaways, /moderation, /leaderboard, /config) wurden entfernt. Sie waren
 * nur per requireAuth (Session ohne Rollen-/Scope-Pruefung) geschuetzt und
 * gaben guild-uebergreifend sensible Daten preis. Keiner dieser Endpoints
 * wurde vom Frontend genutzt.
 *
 * Es verbleibt ausschliesslich /api/me (eigene, minimale Session-Daten).
 */

export const apiRouter = Router();

/**
 * Auth-Middleware: Prüft Login und 2FA-Status.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Nicht authentifiziert' });
    return;
  }

  if ((req.session as any).requires2FA) {
    res.status(403).json({ error: '2FA-Verifizierung erforderlich' });
    return;
  }

  next();
}

apiRouter.use(requireAuth);

/**
 * Aktueller Login-Status fuer das Dashboard-Frontend.
 * Liefert minimale User-Daten (ohne Tokens).
 */
apiRouter.get('/me', async (req: Request, res: Response) => {
  const userId = (req.session as { userId?: string }).userId;
  if (!userId) { res.status(401).json({ error: 'Nicht angemeldet' }); return; }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { discordId: true, username: true, role: true },
  });
  if (!user) { res.status(401).json({ error: 'Session ungueltig' }); return; }
  res.json({ user: { ...user, avatar: null } });
});
