import type { Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';

interface SessionShape {
  userId?: string;
  discordId?: string;
  sessionToken?: string;
}

function getSession(req: Request): SessionShape {
  return (req.session as unknown as SessionShape) ?? {};
}

/**
 * Persistent application-session gate for authentication flows that must remain
 * reachable before the second factor is complete.
 *
 * This deliberately does NOT enforce `twoFactorVerified`: `/auth/2fa/*` is the
 * flow that establishes that state. It only enforces the same durable Session
 * binding/revocation/expiry invariant as the authenticated dashboard surface.
 */
export async function requireActivePersistentSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const s = getSession(req);
  if (!s.userId || !s.discordId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return;
  }

  if (!s.sessionToken) {
    logAudit('SESSION_AUTH_REJECTED', 'SECURITY', {
      userId: s.userId,
      reason: 'missing_session_token',
      ip: req.ip,
    });
    await new Promise<void>((resolve) => {
      req.session.destroy(() => resolve());
    });
    res.status(401).json({ error: 'Session abgelaufen oder widerrufen.', code: 'SESSION_REVOKED' });
    return;
  }

  try {
    const dbSession = await prisma.session.findUnique({
      where: { token: s.sessionToken },
      select: { isActive: true, expiresAt: true, userId: true },
    });
    if (
      !dbSession
      || !dbSession.isActive
      || dbSession.expiresAt <= new Date()
      || dbSession.userId !== s.userId
    ) {
      logAudit('SESSION_AUTH_REJECTED', 'SECURITY', {
        userId: s.userId,
        reason: !dbSession ? 'missing' : !dbSession.isActive ? 'revoked' : dbSession.expiresAt <= new Date() ? 'expired' : 'user_mismatch',
        ip: req.ip,
      });
      await new Promise<void>((resolve) => {
        req.session.destroy(() => resolve());
      });
      res.status(401).json({ error: 'Session abgelaufen oder widerrufen.', code: 'SESSION_REVOKED' });
      return;
    }
  } catch (err) {
    logger.error('requireActivePersistentSession session lookup failed', err as Error);
    res.status(503).json({ error: 'Session-Store nicht erreichbar.', code: 'SESSION_STORE_UNAVAILABLE' });
    return;
  }

  next();
}
