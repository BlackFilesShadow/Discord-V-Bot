/**
 * Factions: pro Guild + Slot eigene Liste (composite-unique [guildId, nitradoConnId, name]).
 *
 * GET    /                     Liste mit Member-Counts
 * POST   /                     body: voll (siehe validateBody)
 * PATCH  /:id                  body: Subset (Partial-Update)
 * DELETE /:id                  cascadiert FactionMember + Embed wird entfernt
 * POST   /:id/republish        Embed neu posten/aktualisieren
 * POST   /:id/members          body: { userDiscordId, role? }
 * DELETE /:id/members/:userDiscordId
 *
 * High-End Embed-Integration:
 *  - Beim Create wird sofort ein Embed im konfigurierten Kanal gepostet.
 *  - Bei jeder Aenderung (Felder ODER Mitglieder) wird das Embed aktualisiert.
 *  - Bei Channel-Wechsel oder Delete wird das alte Embed entfernt.
 *  - Embed-Channel-Existenz wird vorab geprueft -> klare Fehlermeldung.
 *  - Keine serveruebergreifende Sichtbarkeit: alle Queries scopen via guildId.
 */
import { Router } from 'express';
import multer from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { postFactionEmbed, unpostFactionEmbed } from '../../../modules/factions/factionEmbed';

export const factionsRouter = Router({ mergeParams: true });

const URL_RE = /^https?:\/\/[^\s<>"]{4,2000}$/i;
const LOCAL_PATH_RE = /^\/uploads\/factions\/\d{17,20}\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const VALID_POLICY = new Set(['OPEN', 'REQUEST', 'CLOSED']);
const VALID_STATUS = new Set(['ACTIVE', 'RECRUITING', 'INACTIVE', 'ARCHIVED']);
const VALID_ROLES = new Set(['LEADER', 'TREASURER', 'MEMBER', 'PENDING']);

const DESCRIPTION_MAX = 1000;

const UPLOADS_BASE = path.resolve(process.cwd(), 'uploads', 'factions');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);
const ALLOWED_KIND = new Set(['flag', 'banner', 'media']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Nur JPG/PNG/WEBP/GIF/MP4/WEBM/MOV erlaubt.'));
  },
});

function extFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png':  return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif':  return '.gif';
    case 'video/mp4':  return '.mp4';
    case 'video/webm': return '.webm';
    case 'video/quicktime': return '.mov';
    default: return '.bin';
  }
}

function isAcceptableAssetRef(s: string): boolean {
  return URL_RE.test(s) || LOCAL_PATH_RE.test(s);
}

interface FactionBody {
  name?: string;
  flagUrl?: string;
  bannerUrl?: string | null;
  mediaUrl?: string | null;
  description?: string | null;
  color?: string | null;
  leaderDiscordId?: string | null;
  deputyDiscordId?: string | null;
  treasurerDiscordId?: string | null;
  embedChannelId?: string | null;
  joinPolicy?: string;
  status?: string;
  isActive?: boolean;
}

function validateBody(b: FactionBody, partial: boolean): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};

  if (b.name !== undefined) {
    if (typeof b.name !== 'string') return { ok: false, error: 'name muss String sein.' };
    const n = b.name.trim();
    if (n.length < 2 || n.length > 60) return { ok: false, error: 'name 2..60 Zeichen.' };
    data.name = n;
  } else if (!partial) return { ok: false, error: 'name fehlt.' };

  if (b.flagUrl !== undefined) {
    if (b.flagUrl === null || b.flagUrl === '') data.flagUrl = null;
    else if (typeof b.flagUrl === 'string' && isAcceptableAssetRef(b.flagUrl)) data.flagUrl = b.flagUrl;
    else return { ok: false, error: 'flagUrl muss URL oder Upload-Pfad sein.' };
  }

  for (const k of ['bannerUrl', 'mediaUrl'] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === '') data[k] = null;
      else if (typeof b[k] === 'string' && isAcceptableAssetRef(b[k] as string)) data[k] = b[k];
      else return { ok: false, error: `${k} muss URL oder Upload-Pfad sein.` };
    }
  }

  if (b.description !== undefined) {
    if (b.description === null || b.description === '') data.description = null;
    else if (typeof b.description === 'string') {
      const d = b.description.trim();
      if (d.length > DESCRIPTION_MAX) return { ok: false, error: `description max. ${DESCRIPTION_MAX} Zeichen.` };
      data.description = d;
    } else return { ok: false, error: 'description ungueltig.' };
  }

  if (b.color !== undefined) {
    if (b.color === null || b.color === '') data.color = null;
    else if (typeof b.color === 'string' && HEX_RE.test(b.color)) {
      data.color = b.color.startsWith('#') ? b.color : `#${b.color}`;
    } else return { ok: false, error: 'color muss Hex sein (z.B. #dc2626).' };
  }

  for (const k of ['leaderDiscordId', 'deputyDiscordId', 'treasurerDiscordId', 'embedChannelId'] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null || b[k] === '') data[k] = null;
      else if (typeof b[k] === 'string' && SNOWFLAKE_RE.test(b[k] as string)) data[k] = b[k];
      else return { ok: false, error: `${k} ungueltig (Discord-Snowflake erwartet).` };
    }
  }

  if (b.joinPolicy !== undefined) {
    if (typeof b.joinPolicy !== 'string' || !VALID_POLICY.has(b.joinPolicy)) return { ok: false, error: 'joinPolicy ungueltig.' };
    data.joinPolicy = b.joinPolicy;
  }

  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !VALID_STATUS.has(b.status)) return { ok: false, error: 'status ungueltig.' };
    data.status = b.status;
  }

  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') return { ok: false, error: 'isActive muss bool sein.' };
    data.isActive = b.isActive;
  }

  if (partial && Object.keys(data).length === 0) return { ok: false, error: 'Keine gueltigen Felder.' };
  return { ok: true, data };
}

async function activeSlotId(guildId: string, slotParam: unknown): Promise<string | null> {
  if (typeof slotParam === 'string' && /^[1-5]$/.test(slotParam)) {
    const c = await prisma.nitradoConnection.findUnique({
      where: { guildId_slot: { guildId, slot: Number(slotParam) } }, select: { id: true },
    });
    return c?.id ?? null;
  }
  const c = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' }, orderBy: { slot: 'asc' }, select: { id: true },
  });
  return c?.id ?? null;
}

async function ensureChannelInGuild(channelId: string, guildId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return null; // kein Bot-Client (z.B. Tests) -> ueberspringen
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || ch.isDMBased()) {
    return 'Embed-Channel existiert nicht oder ist kein Text-Channel.';
  }
  const guildCh = ch as { guildId?: string };
  if (guildCh.guildId !== guildId) {
    return 'Embed-Channel gehoert nicht zu dieser Guild.';
  }
  return null;
}

async function refreshEmbed(factionId: string, guildId: string, actorUserId: string, action: string): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) return;
  await postFactionEmbed(client, factionId).catch(err => {
    logAuditDb('FACTION_EMBED_FAILED', 'FACTION', {
      actorUserId, guildId,
      details: { factionId, action, error: (err as Error).message },
    });
  });
}

factionsRouter.get('/', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.faction.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    include: { _count: { select: { members: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({
    factions: rows.map(f => ({
      id: f.id,
      name: f.name,
      flagUrl: f.flagUrl,
      bannerUrl: f.bannerUrl,
      mediaUrl: f.mediaUrl,
      description: f.description,
      color: f.color,
      leaderDiscordId: f.leaderDiscordId,
      deputyDiscordId: f.deputyDiscordId,
      treasurerDiscordId: f.treasurerDiscordId,
      embedChannelId: f.embedChannelId,
      embedMessageId: f.embedMessageId,
      joinPolicy: f.joinPolicy,
      status: f.status,
      isActive: f.isActive,
      memberCount: f._count.members,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    })),
  });
});

factionsRouter.post('/', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }

  const v = validateBody(req.body ?? {}, false);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const embedChannelId = v.data.embedChannelId as string | null | undefined;
  if (embedChannelId) {
    const err = await ensureChannelInGuild(embedChannelId, scope.guildId);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  try {
    const f = await prisma.faction.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: connId,
        name: v.data.name as string,
        flagUrl: (v.data.flagUrl as string | null | undefined) ?? null,
        bannerUrl: (v.data.bannerUrl as string | null | undefined) ?? null,
        mediaUrl: (v.data.mediaUrl as string | null | undefined) ?? null,
        description: (v.data.description as string | null | undefined) ?? null,
        color: (v.data.color as string | null | undefined) ?? null,
        leaderDiscordId: (v.data.leaderDiscordId as string | null | undefined) ?? null,
        deputyDiscordId: (v.data.deputyDiscordId as string | null | undefined) ?? null,
        treasurerDiscordId: (v.data.treasurerDiscordId as string | null | undefined) ?? null,
        embedChannelId: (v.data.embedChannelId as string | null | undefined) ?? null,
        joinPolicy: (v.data.joinPolicy as string | undefined) ?? 'REQUEST',
        status: (v.data.status as string | undefined) ?? 'ACTIVE',
        isActive: (v.data.isActive as boolean | undefined) ?? true,
      },
    });
    logAuditDb('FACTION_CREATED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { slotId: connId, factionId: f.id, name: f.name },
    });
    if (f.embedChannelId) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'create');
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
    res.status(201).json({ id: f.id, name: f.name });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon im Slot.' }); return;
    }
    throw e;
  }
});

factionsRouter.patch('/:id', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  const v = validateBody(req.body ?? {}, true);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const newEmbedCh = v.data.embedChannelId as string | null | undefined;
  const willChangeChannel = v.data.embedChannelId !== undefined && newEmbedCh !== existing.embedChannelId;

  if (willChangeChannel && newEmbedCh) {
    const err = await ensureChannelInGuild(newEmbedCh, scope.guildId);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  if (willChangeChannel && existing.embedMessageId) {
    const client = tryGetDashboardClient();
    if (client) await unpostFactionEmbed(client, existing.id).catch(() => {});
  }

  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
    const updated = await prisma.faction.update({ where: { id: existing.id }, data: v.data });
    logAuditDb('FACTION_UPDATED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { factionId: id, fields: Object.keys(v.data) },
    });
    if (updated.embedChannelId) {
      await refreshEmbed(updated.id, scope.guildId, req.auth!.userId, 'update');
    }
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: id } });
    res.json({ ok: true });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon im Slot.' }); return;
    }
    throw e;
  }
});

factionsRouter.post('/:id/republish', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  if (!existing.embedChannelId) { res.status(400).json({ error: 'Kein Embed-Channel konfiguriert.' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  try {
    const r = await postFactionEmbed(client, id);
    logAuditDb('FACTION_EMBED_REPUBLISHED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: id, messageId: r.messageId },
    });
    res.json({ messageId: r.messageId });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

factionsRouter.delete('/:id', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  if (existing.embedMessageId) {
    const client = tryGetDashboardClient();
    if (client) await unpostFactionEmbed(client, existing.id).catch(() => {});
  }

  // Hochgeladene Dateien dieser Fraktion entfernen.
  const factionDir = path.join(UPLOADS_BASE, scope.guildId, existing.id);
  await fs.rm(factionDir, { recursive: true, force: true }).catch(() => {});

  // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
  await prisma.faction.delete({ where: { id: existing.id } });
  logAuditDb('FACTION_DELETED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: id, name: existing.name },
  });
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: id } });
  res.json({ ok: true });
});

factionsRouter.post(
  '/:id/upload',
  requireGuildPermission('factions.manage'),
  upload.single('file'),
  async (req, res) => {
    const scope = req.guildScope!;
    const id = String(req.params.id);
    const kind = String(req.query.kind ?? '').toLowerCase();
    if (!ALLOWED_KIND.has(kind)) {
      res.status(400).json({ error: 'kind muss flag|banner|media sein.' });
      return;
    }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Keine Datei.' }); return; }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      res.status(400).json({ error: 'Unerlaubter MIME-Type.' });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: `Datei zu gross (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` });
      return;
    }

    const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
    if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

    const ext = extFor(file.mimetype);
    const dir = path.join(UPLOADS_BASE, scope.guildId, existing.id);
    await fs.mkdir(dir, { recursive: true });

    // Alte Datei dieses kind loeschen (jede Endung).
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith(`${kind}.`)) {
          await fs.unlink(path.join(dir, entry)).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    const filename = `${kind}${ext}`;
    const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, file.buffer);

    const publicUrl = `/uploads/factions/${scope.guildId}/${existing.id}/${filename}`;
    const field = kind === 'flag' ? 'flagUrl' : kind === 'banner' ? 'bannerUrl' : 'mediaUrl';

    // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
    await prisma.faction.update({
      where: { id: existing.id },
      data: { [field]: publicUrl },
    });
    logAuditDb('FACTION_ASSET_UPLOADED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { factionId: existing.id, kind, mime: file.mimetype, size: file.size },
    });
    if (existing.embedChannelId) await refreshEmbed(existing.id, scope.guildId, req.auth!.userId, `upload-${kind}`);
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: existing.id } });
    res.json({ url: publicUrl });
  },
);

factionsRouter.delete('/:id/asset', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const kind = String(req.query.kind ?? '').toLowerCase();
  if (!ALLOWED_KIND.has(kind)) { res.status(400).json({ error: 'kind muss flag|banner|media sein.' }); return; }
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  const field = kind === 'flag' ? 'flagUrl' : kind === 'banner' ? 'bannerUrl' : 'mediaUrl';
  const current = (existing as unknown as Record<string, string | null>)[field];

  // Nur lokale Uploads physisch loeschen; externe URLs bleiben unberuehrt.
  if (current && LOCAL_PATH_RE.test(current)) {
    const rel = current.replace(/^\//, ''); // 'uploads/factions/.../...'
    const full = path.resolve(process.cwd(), rel);
    if (full.startsWith(UPLOADS_BASE)) {
      await fs.unlink(full).catch(() => {});
    }
  }

  // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
  await prisma.faction.update({ where: { id: existing.id }, data: { [field]: null } });
  logAuditDb('FACTION_ASSET_REMOVED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: existing.id, kind },
  });
  if (existing.embedChannelId) await refreshEmbed(existing.id, scope.guildId, req.auth!.userId, `remove-${kind}`);
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: existing.id } });
  res.json({ ok: true });
});

factionsRouter.post('/:id/members', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const { userDiscordId, role } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const r = typeof role === 'string' && VALID_ROLES.has(role) ? role : 'MEMBER';

  const f = await prisma.faction.findFirst({ where: { id: String(req.params.id), guildId: scope.guildId } });
  if (!f) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde oben mit guildId-Scope verifiziert; FactionMember erbt Scope via FK
  await prisma.factionMember.upsert({
    where: { factionId_userDiscordId: { factionId: f.id, userDiscordId: target } },
    create: { factionId: f.id, userDiscordId: target, role: r },
    update: { role: r },
  });
  logAuditDb('FACTION_MEMBER_ADDED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: f.id, target, role: r } });
  if (f.embedChannelId) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'member-added');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.status(201).json({ ok: true });
});

factionsRouter.delete('/:id/members/:userDiscordId', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const f = await prisma.faction.findFirst({ where: { id: String(req.params.id), guildId: scope.guildId } });
  if (!f) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde oben mit guildId-Scope verifiziert; FactionMember erbt Scope via FK
  const out = await prisma.factionMember.deleteMany({
    where: { factionId: f.id, userDiscordId: target },
  });
  if (out.count === 0) { res.status(404).json({ error: 'Member nicht gefunden.' }); return; }
  logAuditDb('FACTION_MEMBER_REMOVED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: f.id, target } });
  if (f.embedChannelId) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'member-removed');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.json({ ok: true });
});
