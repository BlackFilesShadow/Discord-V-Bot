import express from 'express';
import http from 'http';
import path from 'node:path';
import fs from 'node:fs';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { authRouter, apiRouter, adminRouter, testRouter, webhookRouter, setWebhookClient } from './routes';
import { v2Router } from './routes/v2';
import { discordHealthRouter } from './routes/discordHealth';
import { setDashboardClient } from './clientRegistry';
import { initSocketIo } from './socket';
import { metricsRegistry } from '../utils/metrics';
import type { Client } from 'discord.js';

/**
 * Web-Dashboard Server (Sektion 7 & 12):
 * - Web-Dashboard für Admins/Entwickler
 * - Authentifizierung über Discord OAuth2, 2FA für Developer-Bereich
 * - Developer-Bereich: Erweiterte Logs, Analytics, Fehlerberichte, API-Keys, Feature-Toggles
 */

export function startDashboard(client?: Client): void {
  const app = express();
  if (client) {
    setWebhookClient(client);
    setDashboardClient(client);
  }

  // Hinter Reverse-Proxy (Caddy/nginx) -> X-Forwarded-* honorieren,
  // sonst sieht Express die Verbindung als HTTP und setzt secure-Cookies
  // nicht -> OAuth-State geht verloren -> CSRF-Mismatch.
  app.set('trust proxy', 1);

  // Security Middleware (Sektion 4: Sicherheit)
  app.use(helmet());
  app.use(cors({
    origin: config.dashboard.url,
    credentials: true,
  }));

  // Rate Limiting (Sektion 12: Rate-Limit für Login-Versuche)
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minuten
    max: config.security.maxLoginAttempts,
    message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Session (Sektion 12: Session-Management)
  // Persistenter Session-Store auf Postgres -> kein MemoryStore-Leak,
  // ueberlebt Container-Restarts.
  const PgStore = connectPgSimple(session);
  const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sessionStore = new PgStore({
    pool: sessionPool,
    tableName: 'session',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15, // alle 15 min aufraeumen
  });
  sessionPool.on('error', err => logger.error('Session-Pool-Fehler:', err));

  const sessionMiddleware = session({
    store: sessionStore,
    secret: config.dashboard.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: config.security.sessionTimeoutMinutes * 60 * 1000,
      sameSite: 'lax',
    },
  });
  app.use(sessionMiddleware);

  // Request-Logging
  app.use((req, _res, next) => {
    logger.debug(`Dashboard: ${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    next();
  });

  // Routes
  app.use('/auth', loginLimiter, authRouter);
  // Webhook-Endpunkt OHNE Session-Auth (eigene HMAC-Pruefung im Router).
  // MUSS vor dem JSON-Bodyparser bleiben? -> raw-Parser ist im Router lokal.
  app.use('/webhooks', apiLimiter, webhookRouter);
  // Discord-Setup-Diagnose: MUSS vor /api stehen, sonst greift apiRouter
  // mit requireAuth zuerst und blockt den Owner-Self-Service.
  app.use('/api/health', apiLimiter, discordHealthRouter);
  app.use('/api', apiLimiter, apiRouter);
  app.use('/api/v2', apiLimiter, v2Router);
  app.use('/admin', apiLimiter, adminRouter);
  app.use('/test', apiLimiter, testRouter);

  // Health Check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Prometheus-Metriken (text/plain). Optional Token-geschuetzt via METRICS_TOKEN.
  if (config.monitoring.metricsEnabled) {
    app.get('/metrics', async (req, res) => {
      const token = config.monitoring.metricsToken;
      if (token) {
        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (provided !== token) {
          res.status(401).type('text/plain').send('unauthorized');
          return;
        }
      }
      try {
        res.set('Content-Type', metricsRegistry.contentType);
        res.send(await metricsRegistry.metrics());
      } catch (err) {
        logger.error('Metrics-Export-Fehler:', err as Error);
        res.status(500).type('text/plain').send('metrics error');
      }
    });
    logger.info('Metrics: /metrics aktiv' + (config.monitoring.metricsToken ? ' (Bearer-geschuetzt)' : ' (offen)'));
  }

  // Statische Auslieferung der hochgeladenen Faction-Assets.
  // Pfad-Schema: /uploads/factions/<guildId>/<factionId>/<kind>.<ext>
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (fs.existsSync(uploadsDir)) {
    app.use('/uploads', express.static(uploadsDir, {
      index: false,
      maxAge: '1h',
      // Verhindert Path-Traversal-Tricks (express.static normalisiert bereits).
      dotfiles: 'deny',
    }));
  }

  // Phase 4: Statische Auslieferung des Vite-Frontends + SPA-Fallback.
  // Build-Output liegt in src/dashboard/public (vom dashboard-ui via `npm run build:ui`).
  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|auth|admin|test|webhooks|metrics|health|uploads|socket\.io).*/, (_req, res, next) => {
      const indexHtml = path.join(publicDir, 'index.html');
      if (!fs.existsSync(indexHtml)) { next(); return; }
      res.sendFile(indexHtml);
    });
    logger.info(`Dashboard-Frontend wird aus ${publicDir} ausgeliefert.`);
  } else {
    logger.info('Dashboard-Frontend nicht gebuildet (src/dashboard/public fehlt) - nur API verfuegbar.');
  }

  // Error Handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Dashboard-Fehler:', err);
    // Push an Error-Sink (Discord-Webhook, falls konfiguriert)
    // Lazy-Import vermeidet Zirkel-Abhängigkeiten beim Boot.
    import('../utils/errorSink.js').then(m => m.reportError(err, { source: 'dashboard' })).catch(() => { /* */ });
    res.status(500).json({ error: 'Interner Serverfehler' });
  });

  const httpServer = http.createServer(app);
  initSocketIo(httpServer, sessionMiddleware);

  httpServer.listen(config.dashboard.port, () => {
    logger.info(`Dashboard gestartet auf Port ${config.dashboard.port}`);
  });
}
