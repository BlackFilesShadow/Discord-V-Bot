/**
 * Socket.IO-Setup.
 *
 * Zwei Namespaces:
 *  /dev          — DEVELOPER-only Live-Logs + Heartbeat (1s).
 *  /guild/:id    — Per-Guild Update-Stream (Whitelist-Sync, Job-Status,
 *                  Permission-Updates, Casino-Stats). Beitritt nur, wenn
 *                  der eingeloggte User Owner der Guild ist ODER mindestens
 *                  einen Permission-Grant hat.
 *
 * Auth:
 *  Wir teilen die express-session via klassischem Engine.IO-Handshake.
 *  Cookie wird von socket.io-Client automatisch mitgesendet (gleiche Origin).
 *  Im Handshake parsen wir die Session via uebergebenem express-Middleware,
 *  also ist `socket.request.session` verfuegbar.
 */

import type { Server as HttpServer } from 'http';
import { Server as IOServer } from 'socket.io';
import type { RequestHandler } from 'express';
import { logger } from '../../utils/logger';
import { registerDevNamespace } from './dev';
import { registerGuildNamespace } from './guild';
import { setIo } from './emitter';

export interface SocketSessionShape {
  userId?: string;
  discordId?: string;
  role?: string;
  twoFactorVerified?: boolean;
  requires2FA?: boolean;
}

/**
 * Initialisiert Socket.IO am bestehenden HTTP-Server, teilt die
 * express-session-Middleware und registriert beide Namespaces.
 */
export function initSocketIo(httpServer: HttpServer, sessionMiddleware: RequestHandler): IOServer {
  // CORS-Origin: ausschliesslich explizit konfigurierte DASHBOARD_URL erlauben.
  // KEIN Fallback auf `true` (any-origin) — das wuerde mit credentials:true
  // CSRF/XSS-Vektoren von beliebigen Domains oeffnen.
  const allowedOrigin = process.env.DASHBOARD_URL?.trim();
  if (!allowedOrigin) {
    logger.error('Socket.IO: DASHBOARD_URL nicht gesetzt — Socket.IO wird CORS-streng nur same-origin akzeptieren.');
  }
  const io = new IOServer(httpServer, {
    cors: {
      origin: allowedOrigin ? [allowedOrigin] : false,
      credentials: true,
    },
    // Restriktive Defaults: nur WebSocket+Polling, kleine Timeouts
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6, // 1 MB
  });

  // Session in den Engine.IO-Handshake einklinken (typsicheres Wrapping).
  const wrap = (mw: RequestHandler) =>
    (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: (err?: unknown) => void) =>
      mw(req, res, next as Parameters<RequestHandler>[2]);

  io.engine.use(wrap(sessionMiddleware));

  registerDevNamespace(io);
  registerGuildNamespace(io);
  setIo(io);

  logger.info('Socket.IO initialisiert (Namespaces: /dev, /guild)');
  return io;
}
