import type { NextFunction, Request, Response } from 'express';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { logAudit } from '../../utils/logger';
import { isGlobalDeveloperEligible } from '../../modules/auth/globalDeveloperIdentity';

/**
 * Zentrales Gate fuer jede privilegierte DEV-HTTP-Flaeche.
 *
 * Wichtig: Das Gate vertraut nicht blind auf die Session-Rolle, sondern liest
 * die aktuelle DB-Rolle. Ein Rollenentzug, geloeschter DB-User oder eine
 * geaenderte Owner-ID wird dadurch sofort wirksam. Veraltete aktive DevSessions
 * werden bei Ablehnung best-effort widerrufen.
 */
export async function requireGlobalDeveloperIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.auth) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return;
  }

  if (!config.discord.ownerId) {
    logAudit('DEV_IDENTITY_MISCONFIGURED', 'SECURITY', { userId: req.auth.userId, ip: req.ip });
    res.status(503).json({ error: 'Globale Developer-Identitaet nicht konfiguriert.', code: 'DEV_IDENTITY_MISCONFIGURED' });
    return;
  }

  const revokeActiveSessions = async (): Promise<void> => {
    await prisma.devSession.updateMany({
      where: {
        userDiscordId: req.auth!.discordId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    }).catch(() => undefined);
  };

  const dbUser = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { role: true },
  });
  if (!dbUser) {
    await revokeActiveSessions();
    logAudit('DEV_IDENTITY_DENIED', 'SECURITY', {
      userId: req.auth.userId,
      discordId: req.auth.discordId,
      role: req.auth.role,
      reason: 'DB_USER_MISSING',
      ip: req.ip,
    });
    res.status(403).json({ error: 'Keine globale DEV-Berechtigung.', code: 'DEV_IDENTITY_REQUIRED' });
    return;
  }

  const currentRole = dbUser.role;
  if (currentRole !== req.auth.role) {
    (req.session as unknown as { role?: string }).role = currentRole;
    req.auth.role = currentRole;
  }

  if (!isGlobalDeveloperEligible(String(req.auth.discordId), currentRole)) {
    await revokeActiveSessions();

    logAudit('DEV_IDENTITY_DENIED', 'SECURITY', {
      userId: req.auth.userId,
      discordId: req.auth.discordId,
      role: currentRole,
      ip: req.ip,
    });
    res.status(403).json({ error: 'Keine globale DEV-Berechtigung.', code: 'DEV_IDENTITY_REQUIRED' });
    return;
  }

  next();
}
