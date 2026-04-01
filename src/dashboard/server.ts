import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { logger, logAudit } from '../utils/logger';
import { authRouter, apiRouter, adminRouter, testRouter } from './routes';

/**
 * Web-Dashboard Server (Sektion 7 & 12):
 * - Web-Dashboard für Admins/Entwickler
 * - Authentifizierung über Discord OAuth2, 2FA für Developer-Bereich
 * - Developer-Bereich: Erweiterte Logs, Analytics, Fehlerberichte, API-Keys, Feature-Toggles
 */

export function startDashboard(): void {
  const app = express();

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
  app.use(session({
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
  app.use('/api', apiLimiter, apiRouter);
  app.use('/admin', apiLimiter, adminRouter);
  app.use('/test', apiLimiter, testRouter);

  // Health Check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Error Handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Dashboard-Fehler:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  });

  app.listen(config.dashboard.port, () => {
    logger.info(`Dashboard gestartet auf Port ${config.dashboard.port}`);
  });
}
