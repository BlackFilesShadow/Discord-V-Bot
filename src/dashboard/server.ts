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
import { transcriptsRouter } from './routes/transcripts';
import { setDashboardClient } from './clientRegistry';
import { initSocketIo } from './socket';
import { startDevUploadCleanupTimer } from './services/devUpload';
import { startDevSessionCleanupTimer } from './services/devSessionLifecycle';
import { attachPrismaLatencyMiddleware, attachLogRingBuffer } from './services/observability';
import prisma from '../database/prisma';
import { metricsRegistry } from '../utils/metrics';
import type { Client } from 'discord.js';

/**
 * Express `trust proxy`-Wert aus der Konfiguration parsen.
 * Akzeptiert `true`/`false`, eine Hop-Anzahl (z.B. `1`) oder eine
 * Komma-/Whitespace-getrennte IP-/CIDR-Liste.
 */
function parseTrustProxy(value: string): boolean | number | string | string[] {
  const v = (value ?? '').trim();
  if (v === '' ) return 1;
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (v.includes(',')) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return v;
}

/**
 * Leitet die ws/wss-Origin(s) aus der Dashboard-URL ab, damit Socket.IO unter
 * einer engen CSP funktioniert (statt generischer ws:/wss:-Wildcards).
 */
function dashboardWebsocketOrigins(): string[] {
  try {
    const u = new URL(config.dashboard.url);
    const wsScheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return [`${wsScheme}//${u.host}`];
  } catch {
    return [];
  }
}

/**
 * Web-Dashboard Server (Sektion 7 & 12):
 * - Web-Dashboard für Admins/Entwickler
 * - Authentifizierung über Discord OAuth2, 2FA für Developer-Bereich
 * - Developer-Bereich: Erweiterte Logs, Analytics, Fehlerberichte, API-Keys, Feature-Toggles
 */

export async function startDashboard(client?: Client): Promise<void> {
  const app = express();
  if (client) {
    setWebhookClient(client);
    setDashboardClient(client);
  }

  // Hinter Reverse-Proxy (Caddy/nginx) -> X-Forwarded-* honorieren,
  // sonst sieht Express die Verbindung als HTTP und setzt secure-Cookies
  // nicht -> OAuth-State geht verloren -> CSRF-Mismatch.
  // Konfigurierbar via TRUST_PROXY (siehe README). Standard: 1 Hop.
  app.set('trust proxy', parseTrustProxy(config.dashboard.trustProxy));

  // Security Middleware (Sektion 4: Sicherheit)
  // Helmet-Defaults sind bereits aktiv (CSP, X-Content-Type-Options, X-Frame-Options,
  // HSTS via reverse proxy etc.). Zusaetzlich:
  // - Permissions-Policy: deaktiviert Browser-APIs, die das Dashboard nicht braucht
  //   (Geolocation, Mikrofon, Kamera, Payment, USB) -> reduziert Angriffsoberflaeche
  //   bei kompromittierten Drittanbieter-Skripten.
  // - Referrer-Policy: 'no-referrer' verhindert Leak von Session-IDs/Pfaden in
  //   Outbound-Requests (z.B. zu cdn.discordapp.com fuer Avatare).
  // - CSP-Report-Endpoint: nimmt Browser-Verstoesse entgegen -> sichtbar in Logs,
  //   bevor sie zu echten Funktionsproblemen werden.
  app.use(helmet({
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Helmet-default plus eigener Report-Endpoint. Discord-CDN fuer
        // OAuth-Avatare; data: fuer Vite-inline Assets.
        'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com'],
        // Eng gefasst: nur same-origin + die explizite Dashboard-Origin als
        // ws/wss (fuer Socket.IO). KEINE generischen ws:/wss:-Wildcards mehr.
        'connect-src': ["'self'", ...dashboardWebsocketOrigins()],
        'frame-ancestors': ["'none'"],
        'report-uri': ['/api/csp-report'],
      },
    },
  }));
  app.use((_req, res, next) => {
    // Permissions-Policy (frueher Feature-Policy) — Browser-APIs whitelisten
    res.setHeader('Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=()');
    next();
  });
  // CSP-Violation-Reports: niedrige Frequenz erwartet, aber als Defense-in-depth
  // wichtig. KEIN Auth, da Browser-initiiert; Body-Limit klein, um Spam zu vermeiden.
  app.post('/api/csp-report',
    express.json({ type: ['application/csp-report', 'application/json'], limit: '10kb' }),
    (req, res) => {
      try {
        // Truncate, damit Logs nicht explodieren
        const raw = JSON.stringify(req.body ?? {}).slice(0, 2000);
        logger.warn(`CSP-Report von ${req.ip}: ${raw}`);
      } catch { /* ignore */ }
      res.status(204).end();
    });
  app.use(cors({
    origin: config.dashboard.url,
    credentials: true,
  }));

  // Login-Limiter: NUR auf Login-Initiierung + OAuth-Callback + 2FA-Verify.
  // Frueher war der Limiter auf das komplette /auth gemountet, was auch
  // den Status-Polling-Endpoint /auth/status traf -> nach 5 Polls war
  // jeglicher Login fuer 15 Min blockiert. /auth/logout, /auth/status
  // und /auth/discord (Redirect) brauchen kein Brute-Force-Limit.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 Minuten
    max: Math.max(config.security.maxLoginAttempts, 20),
    message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });

  // /api/v2 deckt das gesamte DEV-Dashboard ab (Live-Polling, viele
  // Tools mit eigenen Refresh-Intervallen). Authentifizierte Nutzer
  // (req.session.userId vorhanden) durchlaufen ohnehin requireAuth/requireDev
  // und sind kein Brute-Force-Vektor — fuer sie wird der Limiter geskippt.
  // Anonyme Aufrufer bleiben auf 600/min/IP gedeckelt (DoS-Schutz auf
  // /webhooks, /api/health, ungesicherte /api-Pfade).
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => Boolean((req.session as unknown as { userId?: string } | undefined)?.userId),
    keyGenerator: (req) => req.ip ?? 'unknown',
    message: { error: 'rate_limited', message: 'Zu viele Anfragen. Bitte kurz warten.' },
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Session (Sektion 12: Session-Management)
  // Persistenter Session-Store auf Postgres -> kein MemoryStore-Leak,
  // ueberlebt Container-Restarts.
  const PgStore = connectPgSimple(session);
  const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Tabelle proaktiv anlegen, BEVOR der erste Request reinkommt.
  // createTableIfMissing:true von connect-pg-simple hat eine Race-Condition
  // (erster Request kann fehlschlagen mit "relation \"session\" does not exist"),
  // weil das CREATE async und unkoordiniert mit eingehenden Requests laeuft.
  try {
    await sessionPool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL
      ) WITH (OIDS=FALSE);
    `);
    await sessionPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey') THEN
          ALTER TABLE "session"
            ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
        END IF;
      END$$;
    `);
    await sessionPool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`);
    logger.info('Session-Tabelle bereit.');
  } catch (e) {
    logger.error(`Session-Tabelle konnte nicht initialisiert werden: ${(e as Error).message}`);
  }

  const sessionStore = new PgStore({
    pool: sessionPool,
    tableName: 'session',
    createTableIfMissing: false, // wir haben sie selbst angelegt
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
  // Auth-Routes: Limiter NUR auf den Login-/Callback-/2FA-Pfaden.
  // /auth/status (vom Frontend gepollt) und /auth/logout bleiben frei.
  app.use('/auth/login', loginLimiter);
  app.use('/auth/callback', loginLimiter);
  app.use('/auth/2fa', loginLimiter);
  app.use('/auth', authRouter);
  // Webhook-Endpunkt OHNE Session-Auth (eigene HMAC-Pruefung im Router).
  // MUSS vor dem JSON-Bodyparser bleiben? -> raw-Parser ist im Router lokal.
  app.use('/webhooks', apiLimiter, webhookRouter);
  // Discord-Setup-Diagnose: MUSS vor /api stehen, sonst greift apiRouter
  // mit requireAuth zuerst und blockt den Owner-Self-Service.
  app.use('/api/health', apiLimiter, discordHealthRouter);
  app.use('/api', apiLimiter, apiRouter);
  // Hinweis: /api/v2 wird bereits durch den /api-apiLimiter oben gezaehlt.
  // Kein zweites Mount, sonst dekrementiert das Limit pro Request doppelt
  // (-> verfruehte 429s fuer unauthentifizierte Polls).
  app.use('/api/v2', v2Router);
  app.use('/admin', apiLimiter, adminRouter);
  app.use('/test', apiLimiter, testRouter);
  // Public Web-Transcripts (KEINE Auth — UUID-basierte unguessable URL).
  // MUSS vor dem SPA-Fallback liegen, sonst frisst React den Pfad.
  app.use('/transcripts', apiLimiter, transcriptsRouter);

  // Health Check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Prometheus-Metriken (text/plain). Token-pflichtig via METRICS_TOKEN.
  if (config.monitoring.metricsEnabled) {
    const token = config.monitoring.metricsToken;
    if (!token) {
      logger.warn('Metrics: METRICS_ENABLED=true aber METRICS_TOKEN nicht gesetzt -> /metrics deaktiviert (Sicherheitsfallback).');
    } else {
      app.get('/metrics', async (req, res) => {
        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (provided !== token) {
          res.status(401).type('text/plain').send('unauthorized');
          return;
        }
        try {
          res.set('Content-Type', metricsRegistry.contentType);
          res.send(await metricsRegistry.metrics());
        } catch (err) {
          logger.error('Metrics-Export-Fehler:', err as Error);
          res.status(500).type('text/plain').send('metrics error');
        }
      });
      logger.info('Metrics: /metrics aktiv (Bearer-geschuetzt)');
    }
  }

  // Statische Auslieferung der hochgeladenen Faction-Assets.
  // Pfad-Schema: /uploads/factions/<guildId>/<factionId>/<kind>.<ext>
  //
  // WICHTIG: Es werden AUSSCHLIESSLICH die bekannten oeffentlichen Unterordner
  // ausgeliefert (factions, media) — niemals das gesamte uploads-Verzeichnis.
  // DEV-Log-Uploads liegen in config.upload.devUploadDir (./private/dev-logs)
  // und sind nur ueber den authentifizierten DEV-Endpoint erreichbar, nie als
  // Static-Asset. Exporte liegen ebenfalls privat (config.upload.exportDir).
  const staticOpts = { index: false, maxAge: '1h', dotfiles: 'deny' as const };
  const factionsDir = config.upload.factionsDir;
  if (fs.existsSync(factionsDir)) {
    app.use('/uploads/factions', express.static(factionsDir, staticOpts));
  }
  // Willkommens-/Medien-Assets (Discord-Embeds laden diese URLs serverseitig).
  const mediaDir = path.join(config.upload.dir, 'media');
  if (fs.existsSync(mediaDir)) {
    app.use('/uploads/media', express.static(mediaDir, staticOpts));
  }

  // Phase 4: Statische Auslieferung des Vite-Frontends + SPA-Fallback.
  // Build-Output liegt in src/dashboard/public (vom dashboard-ui via `npm run build:ui`).
  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|auth|admin|test|webhooks|metrics|health|uploads|transcripts|socket\.io).*/, (_req, res, next) => {
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
  startDevUploadCleanupTimer();
  startDevSessionCleanupTimer();
  attachPrismaLatencyMiddleware(prisma as unknown as Parameters<typeof attachPrismaLatencyMiddleware>[0]);
  attachLogRingBuffer(logger);

  httpServer.listen(config.dashboard.port, () => {
    logger.info(`Dashboard gestartet auf Port ${config.dashboard.port}`);
  });
}
