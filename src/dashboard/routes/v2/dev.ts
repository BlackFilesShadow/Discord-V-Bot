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
 *   - Default = "HAS" (Spec). Wenn DEV_PASSWORD env gesetzt ist, gilt der
 *     env-Wert (Production-Empfehlung: starkes Passwort setzen).
 *   - Vergleich serverseitig mit timingSafeEqual.
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
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logAudit, logger } from '../../../utils/logger';

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

// --- Passwort-Aufloesung --------------------------------------------------
const DEFAULT_DEV_PASSWORD = 'HAS';
let warnedAboutDefault = false;
function resolveExpectedPassword(): string {
  const env = process.env.DEV_PASSWORD;
  if (env && env.length > 0) return env;
  if (!warnedAboutDefault) {
    warnedAboutDefault = true;
    logger.warn('[DEV] DEV_PASSWORD env nicht gesetzt — verwende Default "HAS". Fuer Produktion DRINGEND ueberschreiben.');
  }
  return DEFAULT_DEV_PASSWORD;
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
  if (req.auth.role !== 'DEVELOPER') { res.status(403).json({ error: 'Nur DEVELOPER.' }); return; }

  const key = bruteKey(req.auth.discordId, req.ip);
  const lockedFor = isLocked(key);
  if (lockedFor > 0) {
    logAudit('DEV_LOGIN_LOCKED', 'SECURITY', { userId: req.auth.userId, ip: req.ip, lockedForMs: lockedFor });
    res.status(429).json({ error: 'Zu viele Fehlversuche. Account voruebergehend gesperrt.', retryAfterMs: lockedFor });
    return;
  }

  const provided = (req.body?.password ?? '') as string;
  if (typeof provided !== 'string' || provided.length === 0) {
    res.status(400).json({ error: 'password fehlt.' });
    return;
  }

  const expected = resolveExpectedPassword();
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    registerFail(key);
    logAudit('DEV_LOGIN_FAILED', 'SECURITY', { userId: req.auth.userId, ip: req.ip });
    res.status(403).json({ error: 'Passwort falsch.' });
    return;
  }

  clearFails(key);

  // Vorhandene DevSessions des Users widerrufen, damit nur eine aktiv ist.
  await prisma.devSession.updateMany({
    where: { userDiscordId: req.auth.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  });

  const session = await prisma.devSession.create({
    data: {
      userDiscordId: req.auth.discordId,
      scope: { logs: true, snapshot: true },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  logAudit('DEV_LOGIN_OK', 'SECURITY', { userId: req.auth.userId, sessionId: session.id, ip: req.ip });
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
  if (req.auth.role !== 'DEVELOPER') {
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
