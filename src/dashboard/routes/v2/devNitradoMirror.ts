/**
 * DEV-Routen für den Nitrado-Mirror (READ-ONLY).
 *
 * Mount: /api/v2/dev/nitrado-mirror
 * Auth:  requireDev
 *
 * Endpunkte:
 *   GET  /connections                       Liste aller NitradoConnections (Auswahl im UI)
 *   POST /trigger                            { guildId, connId } -> startet One-Shot Snapshot
 *   GET  /progress/:snapshotId?guildId=..   laufender / fertiger Snapshot-Status
 *   GET  /snapshots?guildId=..&connId=..    Snapshot-Liste pro Connection
 *   GET  /:snapshotId/settings?guildId=..   gespeicherte Settings + Service-Meta
 *   GET  /:snapshotId/files?guildId=..&dir=/   Datei-Listing pro Verzeichnis
 *   GET  /:snapshotId/find?guildId=..&q=..  Datei-Namens-Suche
 *   GET  /:snapshotId/file?guildId=..&path= Inhalt einer Datei (Text inline, Binär als download)
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../../../database/prisma';
import { requireDev } from '../../middleware/auth';
import { logger, logAuditDb } from '../../../utils/logger';
import { startSnapshot, getSnapshotProgress } from '../../../modules/nitrado/mirror/snapshotService';
import {
  listSnapshots, getSettings, listFiles, findFiles, getFile,
} from '../../../modules/nitrado/mirror/queryApi';

export const devNitradoMirrorRouter = Router();

const triggerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10, // max 10 Snapshots / Stunde / DEV-User
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.discordId ?? req.ip ?? 'anon',
  message: { error: 'Zu viele Snapshot-Trigger. Bitte später erneut.' },
});

devNitradoMirrorRouter.use(requireDev);

devNitradoMirrorRouter.get('/connections', async (_req, res) => {
  try {
    // DEV-only: requireDev (Bot-Owner) ist auf Router-Ebene aktiv. Cross-Guild-Listing ist hier explizit gewollt,
    // damit die DEV-UI alle Connections fuer Snapshot-Trigger anzeigen kann.
    // eslint-disable-next-line local/no-unscoped-prisma-query
    const rows = await prisma.nitradoConnection.findMany({
      orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
      select: {
        id: true, guildId: true, slot: true, alias: true, alias5: true,
        nitradoServerId: true, serviceId: true, status: true, lastValidatedAt: true,
      },
    });
    res.json({ connections: rows });
  } catch (e) {
    logger.error('[DEV-Mirror] connections', e as Error);
    res.status(500).json({ error: 'Laden fehlgeschlagen.' });
  }
});

devNitradoMirrorRouter.post('/trigger', triggerLimiter, async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const guildId = String(req.body?.guildId ?? '').trim();
  const connId = String(req.body?.connId ?? '').trim();
  if (!guildId || !connId) return res.status(400).json({ error: 'guildId und connId erforderlich.' });
  try {
    const { snapshotId } = await startSnapshot({ guildId, nitradoConnId: connId, triggeredBy: userId });
    logAuditDb('DEV_MIRROR_SNAPSHOT_TRIGGERED', 'NITRADO', {
      actorUserId: req.auth?.userId ?? null,
      guildId,
      details: { snapshotId, connId },
      ip: req.ip ?? null,
      userAgent: String(req.headers['user-agent'] ?? '') || null,
    });
    res.status(202).json({ snapshotId });
  } catch (e) {
    logger.error('[DEV-Mirror] trigger', e as Error);
    logAuditDb('DEV_MIRROR_SNAPSHOT_FAILED', 'NITRADO', {
      actorUserId: req.auth?.userId ?? null,
      guildId,
      details: { connId, error: (e as Error).message },
      ip: req.ip ?? null,
    });
    res.status(400).json({ error: (e as Error).message });
  }
});

devNitradoMirrorRouter.get('/progress/:snapshotId', async (req, res) => {
  const guildId = String(req.query.guildId ?? '').trim();
  if (!guildId) return res.status(400).json({ error: 'guildId erforderlich.' });
  const p = await getSnapshotProgress(req.params.snapshotId, guildId);
  if (!p) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  res.json({
    ...p,
    totalBytes: p.totalBytes.toString(),
    storedBytes: p.storedBytes.toString(),
  });
});

devNitradoMirrorRouter.get('/snapshots', async (req, res) => {
  const guildId = String(req.query.guildId ?? '').trim();
  const connId = String(req.query.connId ?? '').trim();
  if (!guildId || !connId) return res.status(400).json({ error: 'guildId und connId erforderlich.' });
  const rows = await listSnapshots(guildId, connId);
  res.json({
    snapshots: rows.map(r => ({
      ...r,
      totalBytes: r.totalBytes.toString(),
      storedBytes: r.storedBytes.toString(),
    })),
  });
});

async function assertSnapshotInGuild(snapshotId: string, guildId: string): Promise<boolean> {
  const s = await prisma.nitradoSnapshot.findFirst({ where: { id: snapshotId, guildId }, select: { id: true } });
  return !!s;
}

devNitradoMirrorRouter.get('/:snapshotId/settings', async (req, res) => {
  const guildId = String(req.query.guildId ?? '').trim();
  if (!guildId) return res.status(400).json({ error: 'guildId erforderlich.' });
  if (!await assertSnapshotInGuild(req.params.snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  const s = await getSettings(req.params.snapshotId);
  if (!s) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  res.json(s);
});

devNitradoMirrorRouter.get('/:snapshotId/files', async (req, res) => {
  const guildId = String(req.query.guildId ?? '').trim();
  if (!guildId) return res.status(400).json({ error: 'guildId erforderlich.' });
  if (!await assertSnapshotInGuild(req.params.snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  const dir = String(req.query.dir ?? '/');
  const rows = await listFiles(req.params.snapshotId, dir);
  res.json({
    dir,
    entries: rows.map(r => ({ ...r, sizeBytes: r.sizeBytes.toString() })),
  });
});

devNitradoMirrorRouter.get('/:snapshotId/find', async (req, res) => {
  const guildId = String(req.query.guildId ?? '').trim();
  if (!guildId) return res.status(400).json({ error: 'guildId erforderlich.' });
  if (!await assertSnapshotInGuild(req.params.snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  const q = String(req.query.q ?? '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'q (≥ 2 Zeichen) erforderlich.' });
  const rows = await findFiles(req.params.snapshotId, q, 200);
  res.json({ entries: rows.map(r => ({ ...r, sizeBytes: r.sizeBytes.toString() })) });
});

devNitradoMirrorRouter.get('/:snapshotId/file', async (req, res) => {
  const guildId = String(req.query.guildId ?? '').trim();
  if (!guildId) return res.status(400).json({ error: 'guildId erforderlich.' });
  if (!await assertSnapshotInGuild(req.params.snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  const filePath = String(req.query.path ?? '');
  if (!filePath) return res.status(400).json({ error: 'path erforderlich.' });
  try {
    const f = await getFile(req.params.snapshotId, filePath);
    if (!f) return res.status(404).json({ error: 'Datei nicht im Snapshot.' });
    if (f.meta.oversize) {
      return res.json({
        meta: { ...f.meta, sizeBytes: f.meta.sizeBytes.toString() },
        text: null,
        oversize: true,
      });
    }
    if (f.meta.isText && f.textContent !== null) {
      return res.json({
        meta: { ...f.meta, sizeBytes: f.meta.sizeBytes.toString() },
        text: f.textContent,
        oversize: false,
      });
    }
    if (f.content) {
      // Binär: als download liefern. Filename ASCII-only sanitiert; UTF-8-Original via filename* (RFC 5987).
      const safeAscii = f.meta.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
      res.setHeader('Content-Type', f.meta.mimeGuess ?? 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
      );
      return res.send(f.content);
    }
    return res.json({ meta: { ...f.meta, sizeBytes: f.meta.sizeBytes.toString() }, text: null, oversize: false });
  } catch (e) {
    logger.error('[DEV-Mirror] file', e as Error);
    res.status(500).json({ error: 'Lesen fehlgeschlagen.' });
  }
});
