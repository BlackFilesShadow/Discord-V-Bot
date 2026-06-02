/**
 * DEV-Analyse-Routen (Phase 2).
 *
 * Bedienen die UI-Tools fuer ADM/RPT/XML/JSON. Alle Endpunkte verlangen
 * requireDev (DEVELOPER + DevSession). Inhalt-Quellen:
 *
 *  - GET /adm/:uploadId/all              -> alle 8 Analytics in einem Call
 *  - GET /adm/:uploadId/<tool>           -> einzelnes AI-Tool
 *  - GET /rpt/:uploadId                  -> RPT-Zusammenfassung
 *  - POST /validate/xml { content } | upload-id
 *  - POST /validate/json { content } | upload-id
 *
 * Eingabe-Variante 1: { uploadId } -> Service liest gespeicherte Datei.
 * Eingabe-Variante 2: { content }  -> Inline-Validierung (kein Speichern).
 *
 * GUID-Strict (Spec 13) ist Default. Optional ?includeUnknown=1 zeigt,
 * wie viele Eintraege ignoriert wurden, ABER mischt sie nicht in Analytics.
 */
import { Router } from 'express';
import { requireDev } from '../../middleware/auth';
import { readDevUploadContent } from '../../services/devUpload';
import { parseAdm, parseRpt } from '../../services/admParser';
import {
  buildAllAnalytics,
  buildKillfeed,
  buildPlayerTracking,
  buildRaidAnalysis,
  buildBaseProximity,
  buildMovementHeatmap,
  buildSuspiciousActivity,
  buildFactionActivity,
  buildVehicleTracking,
} from '../../services/admAnalytics';
import { validateJson, validateXml, validateDayzXml } from '../../services/devValidators';
import { logger } from '../../../utils/logger';

export const devAnalyticsRouter = Router();
devAnalyticsRouter.use(requireDev);

const MAX_INLINE_BYTES = 5 * 1024 * 1024; // 5 MB inline-Validate

async function loadAdm(userDiscordId: string, uploadId: string): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  const data = await readDevUploadContent(userDiscordId, uploadId);
  if (!data) return { ok: false, status: 404, error: 'Upload nicht gefunden.' };
  if (data.record.kind !== 'ADM' && data.record.kind !== 'RPT') {
    return { ok: false, status: 400, error: `Upload ist vom Typ ${data.record.kind}, kein ADM/RPT.` };
  }
  return { ok: true, content: data.buffer.toString('utf8') };
}

devAnalyticsRouter.get('/adm/:id/all', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const r = await loadAdm(userId, req.params.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const parsed = parseAdm(r.content);
  res.json(buildAllAnalytics(parsed));
});

const toolMap = {
  killfeed: buildKillfeed,
  playertracking: buildPlayerTracking,
  raid: buildRaidAnalysis,
  baseproximity: buildBaseProximity,
  heatmap: buildMovementHeatmap,
  suspicious: buildSuspiciousActivity,
  factions: buildFactionActivity,
  vehicles: buildVehicleTracking,
} as const;

devAnalyticsRouter.get('/adm/:id/:tool', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const tool = req.params.tool.toLowerCase() as keyof typeof toolMap;
  if (!(tool in toolMap)) return res.status(400).json({ error: `Unbekanntes Tool: ${req.params.tool}` });
  const r = await loadAdm(userId, req.params.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const parsed = parseAdm(r.content);
  const fn = toolMap[tool];
  res.json({ tool, data: fn(parsed), meta: { guidEvents: parsed.guidEvents.length, ignoredNoGuid: parsed.unknownPlayerEvents } });
});

devAnalyticsRouter.get('/rpt/:id', async (req, res) => {
  const userId = req.auth?.discordId;
  if (!userId) return res.status(401).json({ error: 'Nicht eingeloggt.' });
  const r = await loadAdm(userId, req.params.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(parseRpt(r.content));
});

async function loadValidatorInput(req: { auth?: { discordId?: string }; body?: { uploadId?: string; content?: string } }, expectKind: 'XML' | 'JSON'): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  const body = req.body ?? {};
  if (typeof body.content === 'string') {
    if (Buffer.byteLength(body.content, 'utf8') > MAX_INLINE_BYTES) {
      return { ok: false, status: 413, error: `Inline-Inhalt > ${MAX_INLINE_BYTES} Bytes — bitte als Upload senden.` };
    }
    return { ok: true, content: body.content };
  }
  if (typeof body.uploadId === 'string' && req.auth?.discordId) {
    const data = await readDevUploadContent(req.auth.discordId, body.uploadId);
    if (!data) return { ok: false, status: 404, error: 'Upload nicht gefunden.' };
    if (data.record.kind !== expectKind) return { ok: false, status: 400, error: `Upload ist ${data.record.kind}, kein ${expectKind}.` };
    return { ok: true, content: data.buffer.toString('utf8') };
  }
  return { ok: false, status: 400, error: 'content oder uploadId erforderlich.' };
}

devAnalyticsRouter.post('/validate/xml', async (req, res) => {
  const r = await loadValidatorInput(req, 'XML');
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  try {
    // DayZ-Dateien (types/events/globals.xml) erhalten zusaetzliche Strukturpruefung.
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : undefined;
    const dayz = validateDayzXml(r.content, fileName);
    if (dayz.kind !== 'generic') {
      res.json(dayz);
    } else {
      res.json(validateXml(r.content));
    }
  } catch (err) {
    logger.error('[DEV-Validate] xml failed', err as Error);
    res.status(500).json({ error: 'Validator-Fehler.' });
  }
});

devAnalyticsRouter.post('/validate/json', async (req, res) => {
  const r = await loadValidatorInput(req, 'JSON');
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  try {
    res.json(validateJson(r.content));
  } catch (err) {
    logger.error('[DEV-Validate] json failed', err as Error);
    res.status(500).json({ error: 'Validator-Fehler.' });
  }
});
