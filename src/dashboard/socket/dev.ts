/**
 * /dev Namespace — DEVELOPER-only.
 *
 * Auth: Session-User muss role===DEVELOPER haben UND eine aktive
 * DevSession besitzen (gleiche Logik wie requireDev-Middleware).
 *
 * Events:
 *  -> 'log'        Live-Log-Zeile (winston-Tap, gepuffert).
 *  -> 'heartbeat'  alle 5s {ts, uptimeSec, memMB, guildCount}.
 *  <- 'subscribe'  Client signalisiert Bereitschaft (no-op, future filter).
 */

import type { Server as IOServer } from 'socket.io';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../clientRegistry';
import { emitDevLog } from './emitter';
import type { SocketSessionShape } from './index';

const HEARTBEAT_MS = 5_000;

export function registerDevNamespace(io: IOServer): void {
  const ns = io.of('/dev');

  ns.use(async (socket, next) => {
    const req = socket.request as { session?: SocketSessionShape };
    const session = req.session;
    if (!session?.userId || session.role !== 'DEVELOPER') {
      next(new Error('forbidden: DEVELOPER required'));
      return;
    }
    if (!session.discordId) {
      next(new Error('forbidden: missing discordId'));
      return;
    }
    try {
      const dev = await prisma.devSession.findFirst({
        where: { userDiscordId: session.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (!dev) {
        next(new Error('forbidden: no active DevSession'));
        return;
      }
      next();
    } catch (e) {
      logger.error('Dev-Namespace-Auth-Fehler:', e as Error);
      next(new Error('internal'));
    }
  });

  ns.on('connection', socket => {
    logger.debug(`/dev verbunden: ${socket.id}`);
    socket.emit('hello', { ts: Date.now() });

    socket.on('disconnect', reason => {
      logger.debug(`/dev getrennt: ${socket.id} (${reason})`);
    });
  });

  // Heartbeat broadcast (laeuft solange Prozess lebt)
  setInterval(() => {
    if (ns.sockets.size === 0) return; // sparen wenn keiner zuhoert
    const client = tryGetDashboardClient();
    const mem = process.memoryUsage();
    ns.emit('heartbeat', {
      ts: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      memMB: Math.round(mem.heapUsed / 1024 / 1024),
      guildCount: client?.guilds.cache.size ?? 0,
    });
  }, HEARTBEAT_MS).unref();

  // Winston-Tap: Logs an /dev-Subscriber spiegeln (best-effort).
  // Wir haengen einen On-Data-Stream nicht direkt an winston (das wuerde
  // Doppel-IO verursachen), sondern oeffnen einen Stream-Transport.
  attachLogStream();
}

let logStreamAttached = false;

function attachLogStream(): void {
  if (logStreamAttached) return;
  logStreamAttached = true;

  // winston bietet keinen einfachen "tap"; wir wrappen die Methoden
  // info/warn/error so, dass jede Zeile zusaetzlich an /dev geht.
  // Reentry-Schutz via Async-Local-Boolean.
  const levels: Array<'info' | 'warn' | 'error' | 'debug'> = ['info', 'warn', 'error', 'debug'];
  let inEmit = false;
  for (const lvl of levels) {
    const orig = logger[lvl].bind(logger);
    (logger as unknown as Record<string, (msg: unknown, ...rest: unknown[]) => void>)[lvl] =
      (msg: unknown, ...rest: unknown[]) => {
        const out = orig(msg as string, ...rest);
        if (!inEmit) {
          inEmit = true;
          try {
            emitDevLog({
              ts: Date.now(),
              level: lvl,
              message: typeof msg === 'string' ? msg : JSON.stringify(msg),
              meta: rest.length > 0 ? { rest } : undefined,
            });
          } catch { /* swallow */ }
          inEmit = false;
        }
        return out;
      };
  }
}
