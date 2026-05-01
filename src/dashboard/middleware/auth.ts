/**
 * Auth-Middleware-Bundle fuer das Self-Service-Dashboard.
 *
 * Reihenfolge im Stack:
 *   requireAuth                 — eingeloggt
 *   requireGuildOwner(:guildId) — Owner der Discord-Guild
 *   requireGuildPermission(:scope) — Owner ODER scoped Grant
 *   requireDev                  — User.role===DEVELOPER + DevSession
 *
 * KEIN Handler darf scoped Daten anfassen, ohne mindestens
 * `requireGuildOwner` ODER `requireGuildPermission` durchlaufen zu haben.
 */

import type { Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';
import { getDashboardClient } from '../clientRegistry';
import { asGuildId, asUserDiscordId, hasPermission as scopeHas } from '../../types/scope';
import type { GuildId, UserDiscordId, PermissionScope, GuildScope } from '../../types/scope';
import { logAudit } from '../../utils/logger';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      userId: string;
      discordId: UserDiscordId;
      role: string;
    };
    guildScope?: GuildScope;
  }
}

interface SessionShape {
  userId?: string;
  discordId?: string;
  role?: string;
  requires2FA?: boolean;
  twoFactorVerified?: boolean;
}

function getSession(req: Request): SessionShape {
  return (req.session as unknown as SessionShape) ?? {};
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const s = getSession(req);
  if (!s.userId || !s.discordId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return;
  }
  // 2FA-Erzwingung fuer privilegierte Rollen
  if (s.requires2FA && !s.twoFactorVerified) {
    res.status(403).json({ error: '2FA-Verifizierung ausstehend.' });
    return;
  }
  req.auth = {
    userId: s.userId,
    discordId: asUserDiscordId(s.discordId),
    role: s.role ?? 'USER',
  };
  next();
}

function readGuildIdParam(req: Request): GuildId | null {
  const raw = req.params.guildId ?? req.params.id;
  if (typeof raw !== 'string') return null;
  try { return asGuildId(raw); } catch { return null; }
}

/**
 * Prueft Owner-Status via Bot-Cache. Bot MUSS in der Guild sein
 * (sonst kann Owner-ID nicht ermittelt werden) -> 404.
 */
export async function requireGuildOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  const guildId = readGuildIdParam(req);
  if (!guildId) { res.status(400).json({ error: 'guildId fehlt/ungueltig.' }); return; }

  const client = getDashboardClient();
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    res.status(404).json({ error: 'Bot ist nicht in dieser Guild.', code: 'BOT_NOT_PRESENT' });
    return;
  }
  if (guild.ownerId !== req.auth.discordId) {
    logAudit('GUILD_OWNER_DENIED', 'SECURITY', {
      userId: req.auth.userId, discordId: req.auth.discordId, guildId,
    });
    res.status(403).json({ error: 'Nur der Server-Owner darf das.' });
    return;
  }
  // Pre-fill scope (kein nitradoConnId hier — nur Owner-Ebene)
  req.guildScope = {
    guildId,
    nitradoConnId: null,
    actorDiscordId: req.auth.discordId,
    isOwner: true,
    permissions: new Set(),
  };
  next();
}

/**
 * Owner ODER scoped Grant fuer `perm`. Setzt `req.guildScope` mit
 * isOwner-Flag + Permissions-Set.
 */
export function requireGuildPermission(perm: PermissionScope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
    const guildId = readGuildIdParam(req);
    if (!guildId) { res.status(400).json({ error: 'guildId fehlt/ungueltig.' }); return; }

    const client = getDashboardClient();
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      res.status(404).json({ error: 'Bot ist nicht in dieser Guild.', code: 'BOT_NOT_PRESENT' });
      return;
    }

    const isOwner = guild.ownerId === req.auth.discordId;
    let permsSet: Set<PermissionScope> = new Set();
    if (!isOwner) {
      const grant = await prisma.guildPermissionGrant.findUnique({
        where: { guildId_userDiscordId: { guildId, userDiscordId: req.auth.discordId } },
      });
      const list = Array.isArray(grant?.permissions) ? (grant!.permissions as string[]) : [];
      permsSet = new Set(list as PermissionScope[]);
    }

    const scope: GuildScope = {
      guildId,
      nitradoConnId: null,
      actorDiscordId: req.auth.discordId,
      isOwner,
      permissions: permsSet,
    };

    if (!scopeHas(scope, perm)) {
      logAudit('GUILD_PERM_DENIED', 'SECURITY', {
        userId: req.auth.userId, discordId: req.auth.discordId, guildId, perm,
      });
      res.status(403).json({ error: `Permission fehlt: ${perm}` });
      return;
    }
    req.guildScope = scope;
    next();
  };
}

/**
 * DEV-only: braucht User.role===DEVELOPER + aktive DevSession.
 */
export async function requireDev(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  if (req.auth.role !== 'DEVELOPER') {
    res.status(403).json({ error: 'Nur DEVELOPER.' });
    return;
  }
  const session = await prisma.devSession.findFirst({
    where: { userDiscordId: req.auth.discordId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!session) {
    res.status(403).json({ error: 'DEV-Session erforderlich.', code: 'DEV_LOGIN_REQUIRED' });
    return;
  }
  next();
}
