/**
 * DEV-Upload-Routen.
 *
 * Alle Endpunkte erfordern requireDev (DEVELOPER + aktive DevSession).
 * Multer mit memoryStorage; eigentliche Disk-Persistenz im Service.
 *
 * POST   /            multipart/form-data: kind=ADM|RPT|XML|JSON, files[]
 * GET    /            ?kind=ADM        Liste eigener Uploads
 * GET    /:id         Metadaten eines Uploads
 * GET    /:id/content Roh-Inhalt (Content-Disposition: attachment)
 * DELETE /:id         Soft-Delete + Datei-Unlink
 */
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireDev } from '../../middleware/auth';
import { logAuditDb } from '../../../utils/logger';
import {
  saveDevUpload,
  listDevUploads,
  getDevUpload,
  readDevUploadContent,
  deleteDevUpload,
  validateDevUpload,
  DEV_UPLOAD_KINDS,
  MAX_DEV_UPLOAD_BYTES,
  MAX_DEV_UPLOADS_PER_REQUEST,
  type DevUploadKind,
} from '../../services/devUpload';
import { logger } from '../../../utils/logger';

export const devUploadsRouter = Router();

const upload = multer({
  // memoryStorage: Validierung im Service, danach Disk-Persistenz. RAM-Obergrenze
  // pro Request = fileSize × files (15 MB × 5 = 75 MB worst-case, vor Limiter).
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DEV_UPLOAD_BYTES, files: MAX_DEV_UPLOADS_PER_REQUEST, fields: 10, parts: MAX_DEV_UPLOADS_PER_REQUEST + 6 },
});

// Rate-Limit fuer Uploads: 30 Anfragen / 10 min / DEV-User.
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.discordId ?? req.ip ?? 'anon',
  message: { error: 'Zu viele Upload-Versuche. Bitte spaeter erneut.' },
});

function isDevUploadKind(v: unknown): v is DevUploadKind {
  return typeof v === 'string' && (DEV_UPLOAD_KINDS as readonly string[]).includes(v);
}

devUploadsRouter.use(requireDev);

devUploadsRouter.post('/', uploadLimiter, upload.array('files', MAX_DEV_UPLOADS_PER_REQUEST), async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });

  const kindRaw = (req.body?.kind ?? '').toString().toUpperCase();
  if (!isDevUploadKind(kindRaw)) {
    return res.status(400).json({ error: `kind muss ${DEV_UPLOAD_KINDS.join('|')} sein.` });
  }
  const kind: DevUploadKind = kindRaw;

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) return res.status(400).json({ error: 'Keine Datei hochgeladen.' });

  const results: Array<{ ok: boolean; name: string; id?: string; error?: string }> = [];
  for (const f of files) {
    const v = validateDevUpload(kind, f.mimetype, f.buffer);
    if (!v.ok) {
      results.push({ ok: false, name: f.originalname, error: v.error });
      continue;
    }
    try {
      const rec = await saveDevUpload({
        userDiscordId: userId,
        kind,
        originalName: f.originalname,
        buffer: f.buffer,
        mimeType: f.mimetype,
      });
      results.push({ ok: true, name: f.originalname, id: rec.id });
    } catch (err) {
      logger.error('[DEV-Upload] save failed', err as Error);
      results.push({ ok: false, name: f.originalname, error: 'Speichern fehlgeschlagen.' });
    }
  }
  const anyOk = results.some(r => r.ok);
  if (anyOk) {
    logAuditDb('DEV_UPLOAD_CREATED', 'UPLOAD', {
      actorUserId: req.auth?.userId ?? null,
      details: {
        kind,
        files: results.map(r => ({ name: r.name, ok: r.ok, id: r.id, error: r.error })),
      },
      ip: req.ip ?? null,
      userAgent: String(req.headers['user-agent'] ?? '') || null,
    });
  }
  res.status(anyOk ? 201 : 400).json({ results });
});

devUploadsRouter.get('/', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const kindRaw = req.query.kind ? String(req.query.kind).toUpperCase() : undefined;
  const kind = isDevUploadKind(kindRaw) ? kindRaw : undefined;
  const uploads = await listDevUploads(userId, kind);
  res.json({ uploads });
});

devUploadsRouter.get('/:id', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const rec = await getDevUpload(userId, req.params.id);
  if (!rec) return res.status(404).json({ error: 'Upload nicht gefunden.' });
  res.json({ upload: rec });
});

devUploadsRouter.get('/:id/content', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const data = await readDevUploadContent(userId, req.params.id);
  if (!data) return res.status(404).json({ error: 'Upload nicht gefunden.' });
  res.setHeader('Content-Type', data.record.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${data.record.originalName.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(data.buffer);
});

devUploadsRouter.delete('/:id', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const ok = await deleteDevUpload(userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Upload nicht gefunden.' });
  logAuditDb('DEV_UPLOAD_DELETED', 'UPLOAD', {
    actorUserId: req.auth?.userId ?? null,
    details: { uploadId: req.params.id },
    ip: req.ip ?? null,
    userAgent: String(req.headers['user-agent'] ?? '') || null,
  });
  res.json({ ok: true });
});
