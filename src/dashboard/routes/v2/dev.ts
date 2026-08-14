/**
 * Dev-Konsole.
 *
 * POST /login           body: { password } -> erzeugt DevSession (1h gueltig)
 * POST /logout          revoked die aktive DevSession (revokedAt = now)
 * GET  /status          { active, eligible, expiresAt? } — fuer UI-Polling
 * GET  /snapshot        Bot-Stats: Guild-Count, Memory, Uptime, Bot-Heartbeat
 * GET  /logs/tail       Platzhalter — Live-Logs gehen via Socket.IO
 *
 * Login/Status sind durch v2-globalen requireAuth abgedeckt; alle anderen
 * Routen brauchen zusaetzlich requireDev (User.role===DEVELOPER + DevSession).
 *
 * Passwort:
 *   - KEIN Default. Es gilt ausschliesslich der env-Wert DEV_PASSWORD.
 *   - Fehlt DEV_PASSWORD, ist der Login fail-closed (503).
 *   - Vergleich serverseitig mit timingSafeEqual.
 *   - Das Passwort ist ausschliesslich Step-up-Authentisierung und vergibt
 *     niemals eine Rolle oder Identitaet.
 *
 * Brute-Force-Schutz:
 *   - In-Memory-Tracking pro userDiscordId+IP.
 *   - Nach MAX_FAILS Fehlversuchen wird der Account/IP fuer LOCK_MS gesperrt.
 *   - Erfolg leert den Counter.
 *   - Zusaetzlich: express-rate-limit auf POST /login.
 */
import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { requireDev } from '../../middleware/auth';
import { recordDevAuthFailure, recordDevAuthSuccess } from '../../middleware/devSecurity';
import { listActiveDevSessions, forceRevokeDevSession } from '../../services/devSessionLifecycle';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logAudit, logger } from '../../../utils/logger';
import { config } from '../../../config';
import { isGlobalDeveloperEligible } from '../../../modules/auth/globalDeveloperIdentity';

export { isGlobalDeveloperEligible };
export const devRouter = Router();

// --- Brute-Force-Tracking -------------------------------------------------
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
interface FailRecord { count: number; firstAt: number; lockedUntil: number }
const failures = new Map<string, FailRecord>();

function bruteKey(userDiscordId: string, ip: string | undefined): string {
  return `${userDiscordId}|${ip ?? 'unknown'}`;
}

function isLocked(key: string): number {
  const rec = failures.get(key);
  if (!rec) return 0;
  if (rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  if (Date.now() - rec.firstAt > LOCK_MS) failures.delete(key);
  return 0;
}

function registerFail(key: string): void {
  const rec = failures.get(key) ?? { count: 0, firstAt: Date.now(), lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) rec.lockedUntil = Date.now() + LOCK_MS;
  failures.set(key, rec);
}

function clearFails(key: string): void { failures.delete(key); }

async function revokeActiveDevSessions(userDiscordId: string): Promise<void> {
  await prisma.devSession.updateMany({
    where: { userDiscordId, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  }).catch(() => undefined);
}

// --- Passwort-Aufloesung --------------------------------------------------
// Sicherheits-Hardening: KEIN Default-Passwort. Wenn DEV_PASSWORD nicht gesetzt ist,
// fail-closed (alle Login-Versuche werden mit 503 abgelehnt). Verhindert versehentliche
// Production-Deployments mit Default-Credentials.
//
// MIN_DEV_PASSWORD_LEN ist NUR eine Warnschwelle (kein harter Login-Block). Ein
// kuerzeres Passwort funktioniert weiterhin, erzeugt aber eine Warnung im Log.
// MIN_DEV_PASSWORD_LEN ist nur Warnschwelle und projektbedingt auf 3 gesetzt.
// Fuer Produktion empfohlen: laengeres Passwort + MFA + IP Allowlist.
const MIN_DEV_PASSWORD_LEN = 3;
let warnedAboutWeakPassword = false;
function resolveExpectedPassword(): string | null {
  const env = process.env.DEV_PASSWORD;
  if (!env || env.length === 0) return null;
  if (env.length < MIN_DEV_PASSWORD_LEN && !warnedAboutWeakPassword) {
    warnedAboutWeakPassword = true;
    logger.warn(`[DEV] DEV_PASSWORD ist zu kurz (< ${MIN_DEV_PASSWORD_LEN} Zeichen). Bitte verstärken!`);
  }
  return env;
}

// --- Routes ---------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche. Bitte spaeter erneut versuchen.' },
});

devRouter.post('/login', loginLimiter, async (req, res) => {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }

  // Fail-closed: Ohne kanonische globale Developer-ID ist die DEV-Konsole nicht
  // korrekt konfiguriert. Ein Passwort darf diesen Zustand niemals ueberbruecken.
  if (!config.discord.ownerId) {
    logger.error('[DEV] Login-Versuch abgelehnt: BOT_OWNER_ID/DISCORD_OWNER_ID fehlt.');
    logAudit('DEV_LOGIN_MISCONFIGURED', 'SECURITY', { userId: req.auth.userId, ip: req.ip });
    res.status(503).json({ error: 'DEV-Login serverseitig nicht konfiguriert (BOT_OWNER_ID fehlt).' });
    return;
  }

  // Frische DB-Rolle ist zwingend. Ein geloeschter DB-User darf niemals ueber
  // eine alte Session-Rolle weiterhin fuer DEV berechtigt erscheinen.
  const dbUser = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { role: true },
  });
  if (!dbUser) {
    await revokeActiveDevSessions(String(req.auth.discordId));
    logAudit('DEV_LOGIN_NOT_ELIGIBLE', 'SECURITY', {
      userId: req.auth.userId,
      discordId: req.auth.discordId,
      role: req.auth.role,
      reason: 'DB_USER_MISSING',
      ip: req.ip,
    });
    recordDevAuthFailure({
      userId: req.auth.userId,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      reason: 'not_eligible',
      failureCount: 1,
    });
    res.status(403).json({ error: 'Keine DEV-Berechtigung.' });
    return;
  }
  const currentRole = dbUser.role;
  if (currentRole !== req.auth.role) {
    (req.session as unknown as { role?: string }).role = currentRole;
    req.auth.role = currentRole;
  }

  if (!isGlobalDeveloperEligible(String(req.auth.discordId), currentRole)) {
    logAudit('DEV_LOGIN_NOT_ELIGIBLE', 'SECURITY', {
      userId: req.auth.userId,
      discordId: req.auth.discordId,
      role: currentRole,
      ip: req.ip,
    });
    recordDevAuthFailure({
      userId: req.auth.userId,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      reason: 'not_eligible',
      failureCount: 1,
    });
    res.status(403).json({ error: 'Keine DEV-Berechtigung.' });
    return;
  }

  const key = bruteKey(req.auth.discordId, req.ip);
  const lockedFor = isLocked(key);
  if (lockedFor > 0) {
    logAudit('DEV_LOGIN_LOCKED', 'SECURITY', { userId: req.auth.userId, ip: req.ip, lockedForMs: lockedFor });
    recordDevAuthFailure({
      userId: req.auth.userId, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''),
      reason: 'locked', failureCount: failures.get(key)?.count ?? MAX_FAILS,
      lockedUntil: new Date(Date.now() + lockedFor),
    });
    res.status(429).json({ error: 'Zu viele Fehlversuche. Account voruebergehend gesperrt.', retryAfterMs: lockedFor });
    return;
  }

  const provided = (req.body?.password ?? '') as string;
  if (typeof provided !== 'string' || provided.length === 0) {
    res.status(400).json({ error: 'password fehlt.' });
    return;
  }

  const expected = resolveExpectedPassword();
  if (expected === null) {
    // Fail-closed: Server ist nicht korrekt konfiguriert (DEV_PASSWORD fehlt).
    logger.error('[DEV] Login-Versuch abgelehnt: DEV_PASSWORD env nicht gesetzt.');
    res.status(503).json({ error: 'DEV-Login serverseitig nicht konfiguriert (DEV_PASSWORD fehlt).' });
    return;
  }
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    registerFail(key);
    const rec = failures.get(key);
    logAudit('DEV_LOGIN_FAILED', 'SECURITY', { userId: req.auth.userId, ip: req.ip, count: rec?.count ?? 1 });
    recordDevAuthFailure({
      userId: req.auth.userId, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''),
      reason: 'bad_password', failureCount: rec?.count ?? 1,
      lockedUntil: rec?.lockedUntil ? new Date(rec.lockedUntil) : null,
    });
    res.status(403).json({ error: 'Passwort falsch.' });
    return;
  }

  clearFails(key);

  // Vorhandene DevSessions des Users widerrufen, damit nur eine aktiv ist.
  await revokeActiveDevSessions(String(req.auth.discordId));

  const session = await prisma.devSession.create({
    data: {
      userDiscordId: req.auth.discordId,
      scope: { logs: true, snapshot: true },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  logAudit('DEV_LOGIN_OK', 'SECURITY', { userId: req.auth.userId, sessionId: session.id, ip: req.ip });
  void recordDevAuthSuccess({
    userId: req.auth.userId, ip: req.ip ?? null,
    userAgent: String(req.headers['user-agent'] ?? '') || null, sessionId: session.id,
  });
  res.json({ ok: true, expiresAt: session.expiresAt });
});

devRouter.post('/logout', async (req, res) => {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  const result = await prisma.devSession.updateMany({
    where: { userDiscordId: req.auth.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    logAudit('DEV_LOGOUT', 'SECURITY', { userId: req.auth.userId, count: result.count });
  }
  res.json({ ok: true, revoked: result.count });
});

devRouter.get('/status', async (req, res) => {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  // Frische DB-Rolle ist zwingend; fehlt der DB-User, wird eine eventuell noch
  // aktive DEV-Session widerrufen und die Berechtigung fail-closed verneint.
  const dbUser = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { role: true },
  });
  if (!dbUser) {
    await revokeActiveDevSessions(String(req.auth.discordId));
    res.json({ active: false, eligible: false });
    return;
  }
  const currentRole = dbUser.role;
  if (currentRole !== req.auth.role) {
    (req.session as unknown as { role?: string }).role = currentRole;
    req.auth.role = currentRole;
  }
  if (!isGlobalDeveloperEligible(String(req.auth.discordId), currentRole)) {
    res.json({ active: false, eligible: false });
    return;
  }
  const session = await prisma.devSession.findFirst({
    where: { userDiscordId: req.auth.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { expiresAt: true },
  });
  res.json({ active: !!session, eligible: true, expiresAt: session?.expiresAt ?? null });
});

devRouter.get('/snapshot', requireDev, (_req, res) => {
  const client = tryGetDashboardClient();
  const mem = process.memoryUsage();
  res.json({
    botReady: !!client,
    uptimeSec: Math.round(process.uptime()),
    guildCount: client?.guilds.cache.size ?? 0,
    memory: {
      rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal,
    },
    nodeVersion: process.version,
  });
});

devRouter.get('/logs/tail', requireDev, (req, res) => {
  const n = Math.min(Number(req.query.n) || 50, 200);
  res.json({
    lines: [],
    note: `Live-Logs via Socket.IO Namespace /dev. Diese Route ist Platzhalter (n=${n}).`,
  });
  logger.debug('Dev-Logs-Tail angefragt');
});

// --- P1: Admin-Force-Revoke ----------------------------------------------
//
// Sichtbar fuer DEVELOPER (requireDev erzwingt Rolle + aktive Session + MFA + IP).
// Force-Revoke kann jeder DEVELOPER ausloesen — sowohl fuer fremde Sessions
// als auch fuer die eigene (z.B. wenn ein verlorener Browser-Tab gesperrt
// werden soll). Eskalation auf eine separate Owner-Rolle ist Teil von P2.

devRouter.get('/sessions', requireDev, async (_req, res) => {
  const rows = await listActiveDevSessions();
  res.json({ sessions: rows });
});

devRouter.post('/sessions/:id/revoke', requireDev, async (req, res) => {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  const sessionId = String(req.params.id ?? '');
  const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '');
  const result = await forceRevokeDevSession({
    sessionId,
    byUserId: req.auth.userId,
    byDiscordId: String(req.auth.discordId),
    reason,
    ip: req.ip ?? null,
  });
  if (!result.ok) {
    const status = result.error === 'reason_too_short' ? 400
      : result.error === 'not_found' ? 404
      : 409;
    res.status(status).json({ error: result.error ?? 'force_revoke_failed' });
    return;
  }
  res.json({ ok: true, revoked: result.revoked });
});
