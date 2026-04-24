import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { logger, logAudit } from '../utils/logger';
import { authRouter, apiRouter, adminRouter, testRouter, webhookRouter, setWebhookClient } from './routes';
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
  if (client) setWebhookClient(client);

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

  app.use(session({
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
  }));

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
  app.use('/api', apiLimiter, apiRouter);
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

  // Error Handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Dashboard-Fehler:', err);
    // Push an Error-Sink (Discord-Webhook, falls konfiguriert)
    // Lazy-Import vermeidet Zirkel-Abhängigkeiten beim Boot.
    import('../utils/errorSink.js').then(m => m.reportError(err, { source: 'dashboard' })).catch(() => { /* */ });
    res.status(500).json({ error: 'Interner Serverfehler' });
  });

  app.listen(config.dashboard.port, () => {
    logger.info(`Dashboard gestartet auf Port ${config.dashboard.port}`);
  });
}
