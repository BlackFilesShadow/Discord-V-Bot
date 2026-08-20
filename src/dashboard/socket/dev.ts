/**
 * /dev Namespace — globale DEVELOPER-Identitaet only.
 *
 * Auth: Session-User muss der kanonischen Bot-Owner-ID entsprechen, seine
 * aktuelle DB-Rolle muss DEVELOPER sein UND exakt die beim Handshake bestaetigte
 * DevSession muss weiterhin aktiv sein. Eine veraltete Session-Rolle oder nur
 * das Shared Password reicht damit niemals fuer Socket-Zugriff.
 *
 * Bestehende Sockets werden serverseitig fortlaufend revalidiert. Logout,
 * Force-Revoke, Ablauf oder Rollenentzug beendet den Stream fail-closed auch
 * dann, wenn der Browser seinen HTTP-Status noch nicht erneut gepollt hat.
 * Ein Rollen-/Identitaetsverlust widerruft dabei die noch aktive Step-up-Session,
 * damit eine spaetere Rollenwiederherstellung keine alte DEV-Session reaktiviert.
 *
 * Events:
 *  -> 'log'        redigierte Live-Log-Zeile (winston-Tap, gepuffert).
 *  -> 'heartbeat'  alle 5s {ts, uptimeSec, memMB, guildCount}.
 *  <- 'subscribe'  Client signalisiert Bereitschaft (no-op, future filter).
 */

import type { Server as IOServer, Socket } from 'socket.io';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../clientRegistry';
import { emitDevLog } from './emitter';
import type { SocketSessionShape } from './index';
import { isGlobalDeveloperEligible } from '../../modules/auth/globalDeveloperIdentity';

const HEARTBEAT_MS = 5_000;
const DEV_AUTH_RECHECK_MS = 1_000;

interface DevSocketData {
  devUserId?: string;
  devUserDiscordId?: string;
  devSessionId?: string;
}

async function revokeActiveSessionsFailClosed(userDiscordId: string): Promise<void> {
  await prisma.devSession.updateMany({
    where: {
      userDiscordId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { revokedAt: new Date() },
  }).catch(() => undefined);
}

async function isDevSocketAccessCurrent(socket: Socket): Promise<boolean> {
  const data = socket.data as DevSocketData;
  if (!data.devUserId || !data.devUserDiscordId || !data.devSessionId) return false;

  const dbUser = await prisma.user.findUnique({
    where: { id: data.devUserId },
    select: { role: true },
  });
  if (!dbUser || !isGlobalDeveloperEligible(data.devUserDiscordId, dbUser.role)) {
    await revokeActiveSessionsFailClosed(data.devUserDiscordId);
    return false;
  }

  const dev = await prisma.devSession.findFirst({
    where: {
      id: data.devSessionId,
      userDiscordId: data.devUserDiscordId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return Boolean(dev);
}

function safeLogMessage(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return `${msg.name}: ${msg.message}`;
  try {
    const json = JSON.stringify(msg);
    return typeof json === 'string' ? json : String(msg);
  } catch {
    return String(msg);
  }
}

export function registerDevNamespace(io: IOServer): void {
  const ns = io.of('/dev');

  ns.use(async (socket, next) => {
    const req = socket.request as { session?: SocketSessionShape };
    const session = req.session;
    if (!session?.userId || !session.discordId) {
      next(new Error('forbidden: authenticated user required'));
      return;
    }

    try {
      const dbUser = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { role: true },
      });
      if (!dbUser || !isGlobalDeveloperEligible(session.discordId, dbUser.role)) {
        await revokeActiveSessionsFailClosed(session.discordId);
        next(new Error('forbidden: global DEVELOPER identity required'));
        return;
      }

      const dev = await prisma.devSession.findFirst({
        where: { userDiscordId: session.discordId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!dev) {
        next(new Error('forbidden: no active DevSession'));
        return;
      }

      const data = socket.data as DevSocketData;
      data.devUserId = session.userId;
      data.devUserDiscordId = session.discordId;
      data.devSessionId = dev.id;
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

  // Fortlaufende serverseitige AuthZ. Die exakte beim Handshake bestaetigte
  // DevSession-ID wird geprueft, damit eine spaeter neu erstellte Session einen
  // alten/revoketen Socket niemals wieder legitimiert.
  let authSweepRunning = false;
  setInterval(() => {
    if (authSweepRunning || ns.sockets.size === 0) return;
    authSweepRunning = true;
    void (async () => {
      for (const socket of ns.sockets.values()) {
        let valid = false;
        let validationError: unknown = null;
        try {
          valid = await isDevSocketAccessCurrent(socket);
        } catch (error) {
          validationError = error;
        }
        if (!valid) {
          // Erst trennen, dann loggen: ein Fehlerlog darf nicht mehr an den
          // gerade als ungueltig erkannten Socket gespiegelt werden.
          socket.disconnect(true);
          if (validationError) {
            logger.error('Dev-Namespace-Revalidierung fehlgeschlagen:', validationError as Error);
          } else {
            logger.warn('Dev-Namespace-Socket wegen verlorener Berechtigung getrennt.');
          }
        }
      }
    })().finally(() => { authSweepRunning = false; });
  }, DEV_AUTH_RECHECK_MS).unref();

  // Heartbeat broadcast (laeuft solange Prozess lebt). Nur Sockets, die den
  // fortlaufenden Auth-Sweep ueberlebt haben, bleiben im Namespace.
  setInterval(() => {
    if (ns.sockets.size === 0) return;
    const client = tryGetDashboardClient();
    const mem = process.memoryUsage();
    ns.emit('heartbeat', {
      ts: Date.now(),
      uptimeSec: Math.round(process.uptime()),
      memMB: Math.round(mem.heapUsed / 1024 / 1024),
      guildCount: client?.guilds.cache.size ?? 0,
    });
  }, HEARTBEAT_MS).unref();

  // Winston-Tap: Logs an /dev-Subscriber spiegeln (best-effort). Die finale
  // Secret-Redaction findet zentral in emitDevLog() unmittelbar vor Broadcast
  // statt und kann daher von keinem Logger-Callsite vergessen werden.
  attachLogStream();
}

let logStreamAttached = false;

function attachLogStream(): void {
  if (logStreamAttached) return;
  logStreamAttached = true;

  // winston bietet keinen einfachen "tap"; wir wrappen die Methoden
  // info/warn/error so, dass jede Zeile zusaetzlich an /dev geht.
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
              message: safeLogMessage(msg),
              meta: rest.length > 0 ? { rest } : undefined,
            });
          } catch { /* best-effort transport; niemals Primärlogging blockieren */ }
          inEmit = false;
        }
        return out;
      };
  }
}
