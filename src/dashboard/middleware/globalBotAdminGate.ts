import type { NextFunction, Request, Response } from 'express';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { logAudit } from '../../utils/logger';
import { isGlobalBotAdminIdentity } from '../../security/privilegedIdentity';

/**
 * Bot-Admin identity gate. BOT_ADMIN_PASSWORD remains a step-up credential only;
 * it can never turn an arbitrary authenticated Discord account into Bot-Admin.
 * The fresh DB role is checked on every Bot-Admin request so role revocation or
 * deletion of the DB user is effective immediately, including for already-active
 * sessions.
 */
export async function requireGlobalBotAdminIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.auth) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return;
  }

  const revokeActiveSessions = async (): Promise<void> => {
    await prisma.botAdminSession.updateMany({
      where: { userDiscordId: req.auth!.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    }).catch(() => undefined);
  };

  const dbUser = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { role: true },
  });
  if (!dbUser) {
    await revokeActiveSessions();
    logAudit('BOTADMIN_IDENTITY_DENIED', 'SECURITY', {
      userId: req.auth.userId,
      discordId: req.auth.discordId,
      role: req.auth.role,
      reason: 'DB_USER_MISSING',
      ip: req.ip,
    });
    res.status(403).json({ error: 'Keine globale Bot-Admin-Berechtigung.', code: 'BOTADMIN_IDENTITY_REQUIRED' });
    return;
  }

  const currentRole = dbUser.role;
  if (currentRole !== req.auth.role) {
    (req.session as unknown as { role?: string }).role = currentRole;
    req.auth.role = currentRole;
  }

  if (!isGlobalBotAdminIdentity(String(req.auth.discordId), currentRole, config.discord.ownerId)) {
    await revokeActiveSessions();
    logAudit('BOTADMIN_IDENTITY_DENIED', 'SECURITY', {
      userId: req.auth.userId,
      discordId: req.auth.discordId,
      role: currentRole,
      ip: req.ip,
    });
    res.status(403).json({ error: 'Keine globale Bot-Admin-Berechtigung.', code: 'BOTADMIN_IDENTITY_REQUIRED' });
    return;
  }

  // Der kanonische BOT_OWNER_ID ist zugleich die unverlierbare globale
  // Developer-Identitaet. Auf /dev normalisiert requireGlobalDeveloperIdentity
  // diesen Request bereits auf DEVELOPER; ohne dieselbe request-lokale
  // Normalisierung wuerde /bot-admin den frischen DB-Role-Snapshot (z.B. USER)
  // an requireBotAdmin weiterreichen und eine vorhandene, gueltige DevSession
  // faelschlich mit "Bot-Admin-Session erforderlich" ablehnen.
  //
  // Wichtig: Es wird KEINE BotAdminSession erzeugt und die persistente DB-Rolle
  // bleibt unveraendert. Downstream muss weiterhin requireBotAdmin/requireDev
  // bestehen, inklusive Session-Ablauf, MFA und IP-Allowlist.
  if (config.discord.ownerId && String(req.auth.discordId) === config.discord.ownerId) {
    req.auth.role = 'DEVELOPER';
  }

  next();
}
