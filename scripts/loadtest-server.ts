/**
 * Mini-Test-Server fuer den Lasttest. Bietet die kritischen Endpunkte ohne
 * Discord-Token / OAuth, damit wir lokal echten HTTP-Traffic messen koennen.
 *
 *   PUBLIC:  /health
 *   GUARDED: /api/v2/dev/status/system     (requireAuth -> 401 ohne Cookie)
 *
 * Aufruf: PORT=4711 npx ts-node scripts/loadtest-server.ts
 */
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { devStatusRouter } from '../src/dashboard/routes/v2/devStatus';
import { requireAuth } from '../src/dashboard/middleware/auth';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json());
app.use(session({
  secret: 'loadtest-only-not-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.use('/api/v2', requireAuth);
app.use('/api/v2/dev/status', devStatusRouter);
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const port = Number(process.env.PORT ?? 4711);
const server = app.listen(port, () => {
  console.log(`[loadtest-server] http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
