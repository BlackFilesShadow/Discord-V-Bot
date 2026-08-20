import { Router, type Request, type Response } from 'express';
import prisma from '../../../database/prisma';
import { logAuditDb, logger } from '../../../utils/logger';
import {
  addKnowledge,
  exportKnowledge,
  importKnowledge,
  listKnowledgeAdmin,
  reembedKnowledge,
  regenerateAiBrief,
  removeKnowledge,
  setKnowledgeActive,
  setPersonaOverride,
  updateKnowledge,
} from '../../../modules/ai/guildKnowledge';
import { listKnowledgeGameservers } from '../../../modules/ai/knowledgeScope';
import {
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_TRUST_LEVELS,
  type KnowledgeProvenanceInput,
} from '../../../modules/ai/knowledgeProvenance';

export const botAdminKnowledgeRouter = Router();
const SNOWFLAKE_RE = /^\d{17,20}$/;
const PROVENANCE_KEYS = ['sourceKind', 'trustLevel', 'sourceRef', 'sourceVersion', 'observedAt', 'validUntil'] as const;

type ParsedProvenance =
  | { ok: true; present: false }
  | { ok: true; present: true; value: KnowledgeProvenanceInput }
  | { ok: false; message: string };

function reqGuildId(req: Request, res: Response): string | null {
  const raw = req.query.guildId ?? (req.body as { guildId?: unknown } | undefined)?.guildId;
  const gid = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0]) : '';
  if (!SNOWFLAKE_RE.test(gid)) {
    res.status(400).json({ error: 'guildId fehlt oder ist ungueltig.' });
    return null;
  }
  return gid;
}

function actor(req: Request): string {
  return req.auth!.discordId;
}

function audit(req: Request, action: string, guildId: string, details: Record<string, unknown>): void {
  logAuditDb(action, 'ADMIN', {
    actorUserId: req.auth!.userId,
    guildId,
    targetUserId: null,
    channelId: null,
    details,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? null,
  });
}

function parseNitradoConnId(value: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, message: 'nitradoConnId muss String oder null sein.' };
  const id = value.trim();
  if (!id || id.length > 80) return { ok: false, message: 'nitradoConnId ist ungueltig.' };
  return { ok: true, value: id };
}

/**
 * Provenance ist absichtlich ein vollstaendiger atomarer Vertrag. Sobald ein
 * Feld gesetzt wird, muessen alle sechs Felder vorhanden sein (optionale Werte
 * explizit als null). So kann ein partieller PATCH niemals sourceRef/version/
 * validUntil still loeschen.
 */
function parseProvenance(body: unknown): ParsedProvenance {
  if (!body || typeof body !== 'object') return { ok: true, present: false };
  const record = body as Record<string, unknown>;
  const present = PROVENANCE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (present.length === 0) return { ok: true, present: false };
  if (present.length !== PROVENANCE_KEYS.length) {
    return { ok: false, message: 'Provenance muss vollstaendig uebergeben werden (sourceKind, trustLevel, sourceRef, sourceVersion, observedAt, validUntil).' };
  }
  return {
    ok: true,
    present: true,
    value: {
      sourceKind: record.sourceKind,
      trustLevel: record.trustLevel,
      sourceRef: record.sourceRef,
      sourceVersion: record.sourceVersion,
      observedAt: record.observedAt,
      validUntil: record.validUntil,
    },
  };
}

botAdminKnowledgeRouter.get('/', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  try {
    const [items, profile, gameservers] = await Promise.all([
      listKnowledgeAdmin(guildId),
      prisma.guildProfile.findUnique({
        where: { guildId },
        select: { aiPersonaOverride: true, aiBrief: true, aiBriefAt: true },
      }),
      listKnowledgeGameservers(guildId),
    ]);
    res.json({
      items,
      gameservers,
      sourceKinds: KNOWLEDGE_SOURCE_KINDS,
      trustLevels: KNOWLEDGE_TRUST_LEVELS,
      persona: profile?.aiPersonaOverride ?? null,
      brief: profile?.aiBrief ?? null,
      briefAt: profile?.aiBriefAt ?? null,
      activeCount: items.filter((i) => i.isActive).length,
      maxSnippets: 50,
    });
  } catch (e) {
    logger.error('botAdmin scoped knowledge list', { guildId, err: (e as Error).message });
    res.status(500).json({ error: 'Wissensbank konnte nicht geladen werden.' });
  }
});

botAdminKnowledgeRouter.post('/', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const label = typeof req.body?.label === 'string' ? req.body.label : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const parsedScope = parseNitradoConnId(req.body?.nitradoConnId);
  if (!parsedScope.ok) { res.status(400).json({ error: parsedScope.message }); return; }
  const parsedProvenance = parseProvenance(req.body);
  if (!parsedProvenance.ok) { res.status(400).json({ error: parsedProvenance.message }); return; }
  const provenance = parsedProvenance.present ? parsedProvenance.value : null;
  const r = await addKnowledge(guildId, label, content, actor(req), parsedScope.value, provenance);
  if (!r.ok) { res.status(400).json({ error: r.message }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_ADD', guildId, {
    id: r.id,
    label: label.trim().slice(0, 60),
    scope: parsedScope.value ? 'GAMESERVER' : 'GLOBAL',
    nitradoConnId: parsedScope.value,
    sourceKind: provenance?.sourceKind ?? 'OWNER_CURATED',
    trustLevel: provenance?.trustLevel ?? 'CURATED',
  });
  res.status(201).json({ id: r.id, message: r.message });
});

botAdminKnowledgeRouter.patch('/:id', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const patch: {
    label?: string;
    content?: string;
    nitradoConnId?: string | null;
    provenance?: KnowledgeProvenanceInput;
  } = {};
  if (typeof req.body?.label === 'string') patch.label = req.body.label;
  if (typeof req.body?.content === 'string') patch.content = req.body.content;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'nitradoConnId')) {
    const parsedScope = parseNitradoConnId(req.body?.nitradoConnId);
    if (!parsedScope.ok) { res.status(400).json({ error: parsedScope.message }); return; }
    patch.nitradoConnId = parsedScope.value;
  }
  const parsedProvenance = parseProvenance(req.body);
  if (!parsedProvenance.ok) { res.status(400).json({ error: parsedProvenance.message }); return; }
  if (parsedProvenance.present) patch.provenance = parsedProvenance.value;
  const r = await updateKnowledge(guildId, String(req.params.id), patch);
  if (!r.ok) { res.status(400).json({ error: r.message }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_UPDATE', guildId, {
    id: String(req.params.id),
    fields: Object.keys(patch),
    nitradoConnId: patch.nitradoConnId,
    sourceKind: parsedProvenance.present ? parsedProvenance.value.sourceKind : undefined,
    trustLevel: parsedProvenance.present ? parsedProvenance.value.trustLevel : undefined,
  });
  res.json({ message: r.message });
});

botAdminKnowledgeRouter.post('/:id/toggle', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  if (!req.body || typeof req.body !== 'object' || typeof req.body.active !== 'boolean') {
    res.status(400).json({ error: 'active muss true oder false sein.' });
    return;
  }
  const active = req.body.active;
  const r = await setKnowledgeActive(guildId, String(req.params.id), active);
  if (!r.ok) { res.status(400).json({ error: r.message }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_TOGGLE', guildId, { id: String(req.params.id), active });
  res.json({ message: r.message });
});

botAdminKnowledgeRouter.post('/:id/reembed', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const r = await reembedKnowledge(guildId, String(req.params.id));
  if (!r.ok) { res.status(r.message.includes('nicht gefunden') ? 404 : 409).json({ error: r.message }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_REEMBED', guildId, { id: String(req.params.id) });
  res.json({ message: r.message });
});

botAdminKnowledgeRouter.delete('/:id', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const r = await removeKnowledge(guildId, String(req.params.id));
  if (!r.ok) { res.status(404).json({ error: r.message }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_DELETE', guildId, { id: String(req.params.id) });
  res.json({ message: r.message });
});

botAdminKnowledgeRouter.get('/export', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const items = await exportKnowledge(guildId);
  audit(req, 'BOTADMIN_KNOWLEDGE_EXPORT', guildId, { count: items.length });
  res.json({ guildId, exportedAt: new Date().toISOString(), items });
});

botAdminKnowledgeRouter.post('/import', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const raw = (req.body as { items?: unknown })?.items;
  if (!Array.isArray(raw)) { res.status(400).json({ error: 'items muss ein Array sein.' }); return; }
  if (raw.length > 200) { res.status(400).json({ error: 'Maximal 200 Eintraege pro Import.' }); return; }
  const r = await importKnowledge(
    guildId,
    raw as Array<{
      label?: unknown; content?: unknown; scopeType?: unknown; scopeSlot?: unknown;
      sourceKind?: unknown; trustLevel?: unknown; sourceRef?: unknown; sourceVersion?: unknown;
      observedAt?: unknown; validUntil?: unknown;
    }>,
    actor(req),
  );
  audit(req, 'BOTADMIN_KNOWLEDGE_IMPORT', guildId, { added: r.added, skipped: r.skipped });
  res.json(r);
});

botAdminKnowledgeRouter.put('/persona', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const raw = req.body?.persona;
  const text = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const r = await setPersonaOverride(guildId, text);
  if (!r.ok) { res.status(400).json({ error: r.message }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_PERSONA', guildId, { set: text !== null });
  res.json({ message: r.message });
});

botAdminKnowledgeRouter.post('/brief/regenerate', async (req, res) => {
  const guildId = reqGuildId(req, res); if (!guildId) return;
  const brief = await regenerateAiBrief(guildId);
  if (brief === null) { res.status(400).json({ error: 'Server-Profil noch nicht initialisiert.' }); return; }
  audit(req, 'BOTADMIN_KNOWLEDGE_BRIEF_REGEN', guildId, { length: brief.length });
  res.json({ brief });
});
