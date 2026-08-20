/**
 * DEV-Routen fuer den Nitrado-Mirror.
 *
 * Mount: /api/v2/dev/nitrado-mirror
 * Auth:  requireDev; der Snapshot-Trigger verlangt zusaetzlich kryptografischen
 *        DEV-Step-Up. Nitrado selbst wird nur gelesen, die Snapshot-Erfassung
 *        persistiert aber interne Daten und ist deshalb eine privilegierte Aktion.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../../../database/prisma';
import { requireDev } from '../../middleware/auth';
import { requireVerifiedDevMutationStepUp } from '../../middleware/devStepUp';
import { logger, logAuditDb } from '../../../utils/logger';
import { startSnapshot, getSnapshotProgress } from '../../../modules/nitrado/mirror/snapshotService';
import {
  listSnapshots, getSettings, listFiles, findFiles, getFile,
} from '../../../modules/nitrado/mirror/queryApi';

export const devNitradoMirrorRouter = Router();

const SNOWFLAKE_RE = /^\d{17,20}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const triggerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.auth?.discordId ?? req.ip ?? 'anon',
  message: { error: 'Zu viele Snapshot-Trigger. Bitte spaeter erneut.' },
});

devNitradoMirrorRouter.use(requireDev);

function strictString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_CHAR_RE.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return null;
  return value;
}

function parseGuildId(value: unknown): string | null {
  const text = strictString(value, 20);
  return text && SNOWFLAKE_RE.test(text) ? text : null;
}

function parseOpaqueId(value: unknown): string | null {
  const text = strictString(value, 128);
  return text && SAFE_ID_RE.test(text) ? text : null;
}

function parseSearch(value: unknown): string | null {
  if (typeof value !== 'string' || CONTROL_CHAR_RE.test(value)) return null;
  const text = value.trim();
  return text.length >= 2 && text.length <= 200 ? text : null;
}

function parseMirrorPath(value: unknown, fallback?: string): string | null {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || CONTROL_CHAR_RE.test(value)) return null;
  if (!value.startsWith('/') || value.includes('\\')) return null;
  const segments = value.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) return null;
  return value;
}

function rejectOutsideRestrictedGuild(req: Request, res: Response, guildId: string): boolean {
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  if (!restrict || restrict === guildId) return false;
  res.status(403).json({
    error: 'Diese DEV-Session ist auf eine andere Guild beschraenkt.',
    code: 'DEV_SCOPE_RESTRICTED',
  });
  return true;
}

async function connectionExistsInGuild(connId: string, guildId: string): Promise<boolean> {
  const row = await prisma.nitradoConnection.findFirst({
    where: { id: connId, guildId },
    select: { id: true },
  });
  return !!row;
}

async function snapshotExistsInGuild(snapshotId: string, guildId: string): Promise<boolean> {
  const row = await prisma.nitradoSnapshot.findFirst({
    where: { id: snapshotId, guildId },
    select: { id: true },
  });
  return !!row;
}

devNitradoMirrorRouter.get('/connections', async (req, res) => {
  try {
    const restrict = req.devSession?.scope.guildIdRestrict ?? null;
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globale DEV-Session darf absichtlich alle Connections sehen; restricted wird serverseitig gefiltert.
    const rows = await prisma.nitradoConnection.findMany({
      where: restrict ? { guildId: restrict } : undefined,
      orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
      select: {
        id: true, guildId: true, slot: true, alias: true, alias5: true,
        nitradoServerId: true, status: true, lastValidatedAt: true,
      },
    });
    res.json({
      connections: rows.map(row => ({ ...row, serviceId: row.nitradoServerId ?? null })),
      scope: restrict ? { guildIdRestrict: restrict } : { global: true },
    });
  } catch (e) {
    logger.error('[DEV-Mirror] connections', e as Error);
    res.status(500).json({ error: 'Laden fehlgeschlagen.' });
  }
});

devNitradoMirrorRouter.post('/trigger', requireVerifiedDevMutationStepUp, triggerLimiter, async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });

  const guildId = parseGuildId(req.body?.guildId);
  const connId = parseOpaqueId(req.body?.connId);
  if (!guildId || !connId) return res.status(400).json({ error: 'guildId oder connId ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;

  try {
    if (!await connectionExistsInGuild(connId, guildId)) return res.status(404).json({ error: 'Nitrado-Connection nicht gefunden.' });
    const { snapshotId } = await startSnapshot({ guildId, nitradoConnId: connId, triggeredBy: userId });
    logAuditDb('DEV_MIRROR_SNAPSHOT_TRIGGERED', 'NITRADO', {
      actorUserId: req.auth?.userId ?? null,
      guildId,
      details: { snapshotId, connId },
      ip: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
    return res.status(202).json({ snapshotId });
  } catch (e) {
    logger.error('[DEV-Mirror] trigger', e as Error);
    logAuditDb('DEV_MIRROR_SNAPSHOT_FAILED', 'NITRADO', {
      actorUserId: req.auth?.userId ?? null,
      guildId,
      details: { connId, error: (e as Error).message },
      ip: req.ip ?? null,
    });
    return res.status(400).json({ error: 'Snapshot konnte nicht gestartet werden.' });
  }
});

devNitradoMirrorRouter.get('/progress/:snapshotId', async (req, res) => {
  const guildId = parseGuildId(req.query.guildId);
  const snapshotId = parseOpaqueId(req.params.snapshotId);
  if (!guildId || !snapshotId) return res.status(400).json({ error: 'guildId oder snapshotId ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;

  const p = await getSnapshotProgress(snapshotId, guildId);
  if (!p) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  return res.json({
    ...p,
    totalBytes: p.totalBytes.toString(),
    storedBytes: p.storedBytes.toString(),
  });
});

devNitradoMirrorRouter.get('/snapshots', async (req, res) => {
  const guildId = parseGuildId(req.query.guildId);
  const connId = parseOpaqueId(req.query.connId);
  if (!guildId || !connId) return res.status(400).json({ error: 'guildId oder connId ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;
  if (!await connectionExistsInGuild(connId, guildId)) return res.status(404).json({ error: 'Nitrado-Connection nicht gefunden.' });

  const rows = await listSnapshots(guildId, connId);
  return res.json({
    snapshots: rows.map(r => ({
      ...r,
      totalBytes: r.totalBytes.toString(),
      storedBytes: r.storedBytes.toString(),
    })),
  });
});

devNitradoMirrorRouter.get('/:snapshotId/settings', async (req, res) => {
  const guildId = parseGuildId(req.query.guildId);
  const snapshotId = parseOpaqueId(req.params.snapshotId);
  if (!guildId || !snapshotId) return res.status(400).json({ error: 'guildId oder snapshotId ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;
  if (!await snapshotExistsInGuild(snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });

  const settings = await getSettings(snapshotId);
  if (!settings) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });
  return res.json(settings);
});

devNitradoMirrorRouter.get('/:snapshotId/files', async (req, res) => {
  const guildId = parseGuildId(req.query.guildId);
  const snapshotId = parseOpaqueId(req.params.snapshotId);
  const dir = parseMirrorPath(req.query.dir, '/');
  if (!guildId || !snapshotId || !dir) return res.status(400).json({ error: 'guildId, snapshotId oder dir ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;
  if (!await snapshotExistsInGuild(snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });

  const rows = await listFiles(snapshotId, dir);
  return res.json({
    dir,
    entries: rows.map(r => ({ ...r, sizeBytes: r.sizeBytes.toString() })),
  });
});

devNitradoMirrorRouter.get('/:snapshotId/find', async (req, res) => {
  const guildId = parseGuildId(req.query.guildId);
  const snapshotId = parseOpaqueId(req.params.snapshotId);
  const q = parseSearch(req.query.q);
  if (!guildId || !snapshotId || !q) return res.status(400).json({ error: 'guildId, snapshotId oder q ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;
  if (!await snapshotExistsInGuild(snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });

  const rows = await findFiles(snapshotId, q, 200);
  return res.json({ entries: rows.map(r => ({ ...r, sizeBytes: r.sizeBytes.toString() })) });
});

devNitradoMirrorRouter.get('/:snapshotId/file', async (req, res) => {
  const guildId = parseGuildId(req.query.guildId);
  const snapshotId = parseOpaqueId(req.params.snapshotId);
  const filePath = parseMirrorPath(req.query.path);
  if (!guildId || !snapshotId || !filePath) return res.status(400).json({ error: 'guildId, snapshotId oder path ungueltig.' });
  if (rejectOutsideRestrictedGuild(req, res, guildId)) return;
  if (!await snapshotExistsInGuild(snapshotId, guildId)) return res.status(404).json({ error: 'Snapshot nicht gefunden.' });

  try {
    const file = await getFile(snapshotId, filePath);
    if (!file) return res.status(404).json({ error: 'Datei nicht im Snapshot.' });
    if (file.meta.oversize) {
      return res.json({
        meta: { ...file.meta, sizeBytes: file.meta.sizeBytes.toString() },
        text: null,
        oversize: true,
      });
    }
    if (file.meta.isText && file.textContent !== null) {
      return res.json({
        meta: { ...file.meta, sizeBytes: file.meta.sizeBytes.toString() },
        text: file.textContent,
        oversize: false,
      });
    }
    if (file.content) {
      const safeAscii = file.meta.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
      res.setHeader('Content-Type', file.meta.mimeGuess ?? 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`,
      );
      return res.send(file.content);
    }
    return res.json({
      meta: { ...file.meta, sizeBytes: file.meta.sizeBytes.toString() },
      text: null,
      oversize: false,
    });
  } catch (e) {
    logger.error('[DEV-Mirror] file', e as Error);
    return res.status(500).json({ error: 'Lesen fehlgeschlagen.' });
  }
});
