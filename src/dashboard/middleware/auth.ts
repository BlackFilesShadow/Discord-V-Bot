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
import { enforceDevMfa, enforceDevIpAllowlist, parseDevScope, type DevSessionScope } from './devSecurity';
import { maybeAutoExtendDevSession } from '../services/devSessionLifecycle';

declare module 'express-serve-static-core' {
  interface Request {
    devSession?: {
      id: string;
      userDiscordId: string;
      scope: DevSessionScope;
      expiresAt: Date;
      mfa: { ok: boolean; reason?: string; graceUntil?: Date | null };
    };
  }
}

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
      // 1) User-spezifische Grants
      const grant = await prisma.guildPermissionGrant.findUnique({
        where: { guildId_userDiscordId: { guildId, userDiscordId: req.auth.discordId } },
      });
      const list = Array.isArray(grant?.permissions) ? (grant!.permissions as string[]) : [];
      permsSet = new Set(list as PermissionScope[]);

      // 2) Role-Grants: alle Rollen des Users in dieser Guild zu einer Vereinigung mergen.
      try {
        const member = guild.members.cache.get(req.auth.discordId)
          ?? await guild.members.fetch(req.auth.discordId).catch(() => null);
        const roleIds = member ? Array.from(member.roles.cache.keys()) : [];
        if (roleIds.length > 0) {
          const roleGrants = await prisma.guildPermissionRoleGrant.findMany({
            where: { guildId, roleDiscordId: { in: roleIds } },
          });
          for (const r of roleGrants) {
            const arr = Array.isArray(r.permissions) ? (r.permissions as string[]) : [];
            for (const s of arr) permsSet.add(s as PermissionScope);
          }
        }
      } catch (e) {
        // Member-Fetch kann fehlschlagen (User nicht mehr in Guild). Dann gibt's keine Role-Grants.
        logAudit('GUILD_MEMBER_FETCH_FAILED', 'SECURITY', {
          userId: req.auth.userId, discordId: req.auth.discordId, guildId,
          err: (e as Error).message,
        });
      }
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
 * DEV-only: braucht User.role===DEVELOPER + aktive DevSession + MFA + IP-Allowlist.
 *
 * P0-Compliance:
 *   - MFA: TwoFactorAuth.isEnabled erforderlich. Grace-Period via
 *     ENV `DEV_MFA_GRACE_PERIOD_END` (ISO-Date) — solange aktiv ist
 *     fehlendes 2FA nur eine Warnung im Audit-Log.
 *   - IP-Allowlist: `IpList(WHITELIST)`. Leere Liste = fail-open.
 *   - DevSession-Scope wird typisiert in `req.devSession` abgelegt
 *     (incl. optionalem `guildIdRestrict` fuer Multi-Guild-Schutz).
 */
export async function requireDev(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  if (req.auth.role !== 'DEVELOPER') {
    res.status(403).json({ error: 'Nur DEVELOPER.' });
    return;
  }
  const session = await prisma.devSession.findFirst({
    where: { userDiscordId: req.auth.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userDiscordId: true, scope: true, expiresAt: true, createdAt: true },
  });
  if (!session) {
    res.status(403).json({ error: 'DEV-Session erforderlich.', code: 'DEV_LOGIN_REQUIRED' });
    return;
  }

  // P1: Auto-Extension bei Activity (idle-extend, hard-capped via createdAt + MAX_LIFETIME).
  // Non-blocking-friendly: failure or no-op extensions don't change request flow.
  let effectiveExpiresAt = session.expiresAt;
  try {
    const ext = await maybeAutoExtendDevSession({
      id: session.id, createdAt: session.createdAt,
      expiresAt: session.expiresAt, userDiscordId: session.userDiscordId,
    });
    if (ext.extended) effectiveExpiresAt = ext.newExpiresAt;
  } catch (e) {
    logAudit('DEV_SESSION_EXTEND_ERROR', 'SECURITY', {
      userId: req.auth.userId, sessionId: session.id, err: (e as Error).message,
    });
  }

  // MFA (mit Grace-Period)
  const mfa = await enforceDevMfa(req.auth.userId);
  if (!mfa.ok) {
    logAudit('DEV_MFA_REQUIRED', 'SECURITY', {
      userId: req.auth.userId, ip: req.ip, reason: mfa.reason ?? 'no_2fa',
    });
    res.status(403).json({
      error: 'DEV-Zugriff erfordert aktives 2FA.',
      code: 'DEV_MFA_REQUIRED',
      setupUrl: '/auth/2fa/setup',
    });
    return;
  }
  if (mfa.reason === 'grace_active') {
    logAudit('DEV_MFA_GRACE_USED', 'SECURITY', {
      userId: req.auth.userId, ip: req.ip,
      graceUntil: mfa.graceUntil?.toISOString() ?? null,
    });
  }

  // IP-Allowlist
  const ipCheck = await enforceDevIpAllowlist(req);
  if (!ipCheck.ok) {
    logAudit('DEV_IP_DENIED', 'SECURITY', {
      userId: req.auth.userId, ip: req.ip, reason: ipCheck.reason, listSize: ipCheck.listSize,
    });
    res.status(403).json({ error: 'IP nicht in DEV-Allowlist.', code: 'DEV_IP_DENIED' });
    return;
  }

  req.devSession = {
    id: session.id,
    userDiscordId: session.userDiscordId,
    scope: parseDevScope(session.scope),
    expiresAt: effectiveExpiresAt,
    mfa: { ok: mfa.ok, reason: mfa.reason, graceUntil: mfa.graceUntil ?? null },
  };

  next();
}
