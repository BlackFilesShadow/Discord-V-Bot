/**
 * Dev-Konsole.
 *
 * POST /login           body: { password } -> erzeugt DevSession (1h gueltig)
 * GET  /snapshot        Bot-Stats: Guild-Count, Memory, Uptime, Bot-Heartbeat
 * GET  /logs/tail       liefert die letzten N Logs aus winston (best-effort)
 *
 * Alle Routen brauchen requireDev (User.role===DEVELOPER + DevSession aktiv).
 * Ausnahme: /login — braucht nur requireAuth (das ist via v2-Router-Stack
 * schon davor) + Passwort-Vergleich gegen DEV_PASSWORD env.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { requireDev } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logAudit, logger } from '../../../utils/logger';

export const devRouter = Router();

devRouter.post('/login', async (req, res) => {
  if (!req.auth) { res.status(401).json({ error: 'Nicht angemeldet.' }); return; }
  if (req.auth.role !== 'DEVELOPER') { res.status(403).json({ error: 'Nur DEVELOPER.' }); return; }
  const expected = process.env.DEV_PASSWORD;
  if (!expected || expected.length < 8) { res.status(503).json({ error: 'DEV_PASSWORD nicht konfiguriert.' }); return; }
  const provided = (req.body?.password ?? '') as string;
  if (typeof provided !== 'string' || provided.length === 0) { res.status(400).json({ error: 'password fehlt.' }); return; }

  // Konstantzeit-Vergleich
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    logAudit('DEV_LOGIN_FAILED', 'SECURITY', { userId: req.auth.userId, ip: req.ip });
    res.status(403).json({ error: 'Passwort falsch.' });
    return;
  }

  const session = await prisma.devSession.create({
    data: {
      userDiscordId: req.auth.discordId,
      scope: { logs: true, snapshot: true },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  logAudit('DEV_LOGIN_OK', 'SECURITY', { userId: req.auth.userId, sessionId: session.id });
  res.json({ ok: true, expiresAt: session.expiresAt });
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
  // Best-effort: winston hat einen File-Transport in logs/. Wir lesen ihn nicht,
  // sondern geben einen Hinweis zurueck — Live-Stream kommt ueber Socket.IO.
  const n = Math.min(Number(req.query.n) || 50, 200);
  res.json({
    lines: [],
    note: `Live-Logs via Socket.IO Namespace /dev. Diese Route ist Platzhalter (n=${n}).`,
  });
  logger.debug('Dev-Logs-Tail angefragt');
});
