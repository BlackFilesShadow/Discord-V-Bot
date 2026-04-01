import { Router, Request, Response } from 'express';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { validateFile } from '../../utils/validator';
import { getAllFeatureToggles, setFeatureToggle } from '../../modules/featureToggles/featureToggleManager';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Dashboard Testumgebung (Sektion 7):
 * - Systemstatus & Health-Checks
 * - DB-Konnektivität
 * - Validierungs-Tests
 * - Feature-Toggle Steuerung
 * - Diagnose-Endpoints
 */

const testRouter = Router();

// Middleware: Nur Admins/Developer
testRouter.use(async (req: Request, res: Response, next) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: 'Nicht authentifiziert.' });
  if (session.requires2FA) return res.status(403).json({ error: '2FA erforderlich.' });

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) {
    return res.status(403).json({ error: 'Keine Berechtigung.' });
  }

  next();
});

/**
 * GET /test/health – System-Health-Check
 */
testRouter.get('/health', async (_req: Request, res: Response) => {
  const checks: Record<string, { status: string; latency?: number; details?: string }> = {};

  // 1. Datenbank
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok', latency: Date.now() - start };
  } catch (error) {
    checks.database = { status: 'error', details: 'DB nicht erreichbar' };
  }

  // 2. Dateisystem
  try {
    const testPath = path.join(os.tmpdir(), '.dvb-health-check');
    fs.writeFileSync(testPath, 'test');
    fs.unlinkSync(testPath);
    checks.filesystem = { status: 'ok' };
  } catch {
    checks.filesystem = { status: 'error', details: 'Dateisystem nicht beschreibbar' };
  }

  // 3. Speicher
  const memUsage = process.memoryUsage();
  checks.memory = {
    status: memUsage.heapUsed / memUsage.heapTotal < 0.9 ? 'ok' : 'warning',
    details: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
  };

  // 4. Uptime
  checks.uptime = {
    status: 'ok',
    details: `${Math.floor(process.uptime())}s`,
  };

  const allOk = Object.values(checks).every(c => c.status === 'ok');
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'healthy' : 'degraded', checks });
});

/**
 * POST /test/validate – Datei-Validierung testen
 */
testRouter.post('/validate', async (req: Request, res: Response) => {
  const { content, fileType } = req.body;
  if (!content || !fileType) {
    return res.status(400).json({ error: 'content und fileType erforderlich.' });
  }

  // Temporäre Datei für Validierung
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `test_${Date.now()}.${fileType}`);

  try {
    fs.writeFileSync(tmpFile, content);
    const result = await validateFile(tmpFile);
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: 'Validierung fehlgeschlagen.' });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
  }
});

/**
 * GET /test/db-stats – Datenbank-Statistiken
 */
testRouter.get('/db-stats', async (_req: Request, res: Response) => {
  try {
    const [users, packages, uploads, downloads, cases, giveaways] = await Promise.all([
      prisma.user.count(),
      prisma.package.count(),
      prisma.upload.count(),
      prisma.download.count(),
      prisma.moderationCase.count(),
      prisma.giveaway.count(),
    ]);

    res.json({
      tables: { users, packages, uploads, downloads, moderationCases: cases, giveaways },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: 'DB-Statistiken nicht verfügbar.' });
  }
});

/**
 * GET /test/features – Alle Feature-Toggles abrufen
 */
testRouter.get('/features', async (_req: Request, res: Response) => {
  const toggles = await getAllFeatureToggles();
  res.json({ features: toggles });
});

/**
 * PUT /test/features/:key – Feature-Toggle setzen
 */
testRouter.put('/features/:key', async (req: Request, res: Response) => {
  const key = String(req.params.key);
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) erforderlich.' });
  }

  const session = req.session as any;
  await setFeatureToggle(key, enabled, session.userId);
  res.json({ success: true, feature: key, enabled });
});

/**
 * GET /test/env – Environment-Info (sichere Teilmenge)
 */
testRouter.get('/env', (_req: Request, res: Response) => {
  res.json({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    memoryUsage: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    },
    cpuUsage: process.cpuUsage(),
  });
});

/**
 * POST /test/echo – Echo-Endpoint für API-Tests
 */
testRouter.post('/echo', (req: Request, res: Response) => {
  res.json({
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
    },
    body: req.body,
    timestamp: new Date().toISOString(),
  });
});

export default testRouter;
