/**
 * Factions: pro Guild eindeutige Liste (Discord-only, slot-unabhaengig).
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
import { randomUUID } from 'node:crypto';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { postFactionEmbed, unpostFactionEmbed, postFactionList, unpostFactionList, assignFactionRole, removeFactionRole, syncFactionRoleAll } from '../../../modules/factions/factionEmbed';
import { asGuildId } from '../../../types/scope';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { PermissionFlagsBits } from 'discord.js';

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
  if (LOCAL_PATH_RE.test(s)) return true;
  if (!URL_RE.test(s)) return false;
  // SSRF-Schutz: blockiere private IPs, localhost, link-local, javascript:/data:.
  // URLs werden zwar nicht serverseitig gefetcht, aber Discord-Embeds könnten sie laden
  // — zudem verhindert dies Stored-XSS via javascript:/data:-URIs.
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') return false;
  // IPv4-private/loopback/link-local Ranges:
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false; // AWS-Metadata
  // IPv6-loopback/link-local:
  if (host === '::1' || host === '[::1]') return false;
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return false;
  if (host.startsWith('fc00:') || host.startsWith('fd00:')) return false;
  return true;
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
  roleId?: string | null;
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

  for (const k of ['leaderDiscordId', 'deputyDiscordId', 'treasurerDiscordId', 'embedChannelId', 'roleId'] as const) {
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
  const v = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ]);
  return v.ok ? null : v.reason;
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

async function refreshList(guildId: string, actorUserId: string, action: string): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) return;
  await postFactionList(client, guildId).catch(err => {
    logAuditDb('FACTION_LIST_FAILED', 'FACTION', {
      actorUserId, guildId,
      details: { action, error: (err as Error).message },
    });
  });
}

/**
 * Holt die Faction-System-Konfiguration einer Guild.
 * Falls keine vorhanden, wird ein leerer Datensatz angelegt (lazy-init).
 */
async function getOrCreateConfig(guildId: string) {
   
  let cfg = await prisma.factionSystemConfig.findUnique({
    where: { guildId },
  });
  if (!cfg) {
     
    cfg = await prisma.factionSystemConfig.create({
      data: { guildId },
    });
  }
  return cfg;
}

/**
 * Effektiver Embed-Channel: faction.embedChannelId override SystemConfig.factionChannelId.
 */
async function effectiveEmbedChannel(faction: { embedChannelId: string | null; guildId: string }): Promise<string | null> {
  if (faction.embedChannelId) return faction.embedChannelId;
   
  const cfg = await prisma.factionSystemConfig.findUnique({
    where: { guildId: faction.guildId },
    select: { factionChannelId: true },
  });
  return cfg?.factionChannelId ?? null;
}

factionsRouter.get('/', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const rows = await prisma.faction.findMany({
    where: { guildId: scope.guildId },
    include: {
      _count: { select: { members: true } },
      members: { select: { userDiscordId: true, role: true, joinedAt: true }, orderBy: { joinedAt: 'asc' } },
    },
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
      roleId: f.roleId,
      joinPolicy: f.joinPolicy,
      status: f.status,
      isActive: f.isActive,
      memberCount: f._count.members,
      members: f.members.map(m => ({ userDiscordId: m.userDiscordId, role: m.role, joinedAt: m.joinedAt.toISOString() })),
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    })),
  });
});

factionsRouter.post('/', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot); // optional, nur Legacy/Tagging

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
        roleId: (v.data.roleId as string | null | undefined) ?? null,
        joinPolicy: (v.data.joinPolicy as string | undefined) ?? 'REQUEST',
        status: (v.data.status as string | undefined) ?? 'ACTIVE',
        isActive: (v.data.isActive as boolean | undefined) ?? true,
      },
    });
    logAuditDb('FACTION_CREATED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { slotId: connId, factionId: f.id, name: f.name },
    });
    // Embed posten — Faction-spezifischer Channel ODER System-Sammelkanal (Fallback im Modul).
    const effectiveCh = await effectiveEmbedChannel({ embedChannelId: f.embedChannelId, guildId: scope.guildId });
    if (effectiveCh) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'create');
    // Faction-Rolle an Leitung/Stellv./Schatzmeister vergeben (falls gesetzt).
    if (f.roleId) {
      const cli = tryGetDashboardClient();
      if (cli) {
        for (const uid of [f.leaderDiscordId, f.deputyDiscordId, f.treasurerDiscordId]) {
          if (uid) await assignFactionRole(cli, scope.guildId, uid, f.roleId);
        }
      }
    }
    // Uebersichts-Liste auto-refresh.
    await refreshList(scope.guildId, req.auth!.userId, 'faction-created');
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
    res.status(201).json({ id: f.id, name: f.name });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon.' }); return;
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
    // Rolle-Wechsel: alte Rolle von allen entfernen, neue zuweisen.
    if (v.data.roleId !== undefined && existing.roleId !== updated.roleId) {
      const cli = tryGetDashboardClient();
      if (cli) {
        if (existing.roleId) {
          // alte Rolle abnehmen
          // eslint-disable-next-line local/no-unscoped-prisma-query -- updated.id intern verifiziert.
          const mems = await prisma.factionMember.findMany({ where: { factionId: updated.id }, select: { userDiscordId: true } });
          const all = new Set<string>(mems.map(m => m.userDiscordId));
          for (const uid of [existing.leaderDiscordId, existing.deputyDiscordId, existing.treasurerDiscordId]) if (uid) all.add(uid);
          for (const uid of all) await removeFactionRole(cli, scope.guildId, uid, existing.roleId);
        }
        if (updated.roleId) await syncFactionRoleAll(cli, updated.id);
      }
    } else if (updated.roleId) {
      // Leadership-Wechsel: ggf. neue Leader-Rolle zuweisen.
      const cli = tryGetDashboardClient();
      if (cli) {
        for (const uid of [updated.leaderDiscordId, updated.deputyDiscordId, updated.treasurerDiscordId]) {
          if (uid) await assignFactionRole(cli, scope.guildId, uid, updated.roleId);
        }
      }
    }
    const effectiveCh = await effectiveEmbedChannel({ embedChannelId: updated.embedChannelId, guildId: scope.guildId });
    if (effectiveCh) {
      await refreshEmbed(updated.id, scope.guildId, req.auth!.userId, 'update');
    }
    await refreshList(scope.guildId, req.auth!.userId, 'faction-updated');
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: id } });
    res.json({ ok: true });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon.' }); return;
    }
    throw e;
  }
});

factionsRouter.post('/:id/republish', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const existing = await prisma.faction.findFirst({ where: { id, guildId: scope.guildId } });
  if (!existing) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  const effChR = await effectiveEmbedChannel({ embedChannelId: existing.embedChannelId, guildId: scope.guildId });
  if (!effChR) { res.status(400).json({ error: 'Kein Embed-Channel konfiguriert (weder Faction- noch System-Channel).' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  try {
    const r = await postFactionEmbed(client, id);
    await refreshList(scope.guildId, req.auth!.userId, 'republish');
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

  // Faction-Rolle von allen Mitgliedern entfernen (best-effort).
  if (existing.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id intern verifiziert.
      const mems = await prisma.factionMember.findMany({ where: { factionId: existing.id }, select: { userDiscordId: true } });
      const all = new Set<string>(mems.map(m => m.userDiscordId));
      for (const uid of [existing.leaderDiscordId, existing.deputyDiscordId, existing.treasurerDiscordId]) if (uid) all.add(uid);
      for (const uid of all) await removeFactionRole(cli, scope.guildId, uid, existing.roleId);
    }
  }

  // Hochgeladene Dateien dieser Fraktion entfernen.
  const factionDir = path.join(UPLOADS_BASE, scope.guildId, existing.id);
  await fs.rm(factionDir, { recursive: true, force: true }).catch(() => {});

  // eslint-disable-next-line local/no-unscoped-prisma-query -- existing.id wurde via guildId-Scope verifiziert.
  await prisma.faction.delete({ where: { id: existing.id } });
  logAuditDb('FACTION_DELETED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: id, name: existing.name },
  });
  // Liste auto-refresh (zeigt Loeschung in Discord-Sammelkanal).
  await refreshList(scope.guildId, req.auth!.userId, 'faction-deleted');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: id } });
  res.json({ ok: true });
});
/**
 * Draft-Upload (ohne Faction-ID): wird beim Anlegen einer neuen Fraktion verwendet,
 * solange noch keine ID existiert. Datei wird unter `_drafts/<uuid>.<ext>` abgelegt
 * und die zurueckgegebene URL spaeter in `flagUrl|bannerUrl|mediaUrl` persistiert.
 */
factionsRouter.post(
  '/upload',
  requireGuildPermission('factions.manage'),
  upload.single('file'),
  async (req, res) => {
    const scope = req.guildScope!;
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
    const ext = extFor(file.mimetype);
    const dir = path.join(UPLOADS_BASE, scope.guildId, '_drafts');
    await fs.mkdir(dir, { recursive: true });

    // Cleanup verwaister Draft-Uploads (>24h alt) — verhindert Disk-Leak
    // wenn User Datei hochlaedt aber Faction nie erstellt. Best-Effort.
    try {
      const entries = await fs.readdir(dir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        const stat = await fs.stat(path.join(dir, entry)).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.unlink(path.join(dir, entry)).catch(() => {});
        }
      }
    } catch { /* best-effort cleanup */ }

    const filename = `${kind}-${randomUUID()}${ext}`;
    await fs.writeFile(path.join(dir, filename), file.buffer);
    const publicUrl = `/uploads/factions/${scope.guildId}/_drafts/${filename}`;
    logAuditDb('FACTION_ASSET_UPLOADED', 'FACTION', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { kind, draft: true, mime: file.mimetype, size: file.size },
    });
    res.json({ url: publicUrl });
  },
);


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
    const effCh3 = await effectiveEmbedChannel({ embedChannelId: existing.embedChannelId, guildId: scope.guildId });
    if (effCh3) await refreshEmbed(existing.id, scope.guildId, req.auth!.userId, `upload-${kind}`);
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
  const effCh4 = await effectiveEmbedChannel({ embedChannelId: existing.embedChannelId, guildId: scope.guildId });
  if (effCh4) await refreshEmbed(existing.id, scope.guildId, req.auth!.userId, `remove-${kind}`);
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
  if (f.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) await assignFactionRole(cli, scope.guildId, target, f.roleId);
  }
  const effCh = await effectiveEmbedChannel({ embedChannelId: f.embedChannelId, guildId: scope.guildId });
  if (effCh) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'member-added');
  await refreshList(scope.guildId, req.auth!.userId, 'member-added');
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
  if (f.roleId) {
    const cli = tryGetDashboardClient();
    if (cli) await removeFactionRole(cli, scope.guildId, target, f.roleId);
  }
  const effCh2 = await effectiveEmbedChannel({ embedChannelId: f.embedChannelId, guildId: scope.guildId });
  if (effCh2) await refreshEmbed(f.id, scope.guildId, req.auth!.userId, 'member-removed');
  await refreshList(scope.guildId, req.auth!.userId, 'member-removed');
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.json({ ok: true });
});

// ============================================================================
// System-Config (pro Slot): zentraler Sammel-Channel + Liste
// ============================================================================

factionsRouter.get('/system-config', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const cfg = await getOrCreateConfig(scope.guildId);
  res.json({
    factionChannelId: cfg.factionChannelId,
    listMessageId: cfg.listMessageId,
    updatedAt: cfg.updatedAt.toISOString(),
  });
});

factionsRouter.put('/system-config', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const body = (req.body ?? {}) as { factionChannelId?: string | null };
  let newChId: string | null;
  if (body.factionChannelId === null || body.factionChannelId === '') newChId = null;
  else if (typeof body.factionChannelId === 'string' && SNOWFLAKE_RE.test(body.factionChannelId)) newChId = body.factionChannelId;
  else { res.status(400).json({ error: 'factionChannelId muss Snowflake oder null sein.' }); return; }

  if (newChId) {
    const err = await ensureChannelInGuild(newChId, scope.guildId);
    if (err) { res.status(400).json({ error: err }); return; }
  }

  const cfg = await getOrCreateConfig(scope.guildId);
  const channelChanged = cfg.factionChannelId !== newChId;

  // Bei Channel-Wechsel: alte Uebersicht + alle Faction-Embeds entfernen, die den
  // System-Channel als Fallback nutzten (faction.embedChannelId IS NULL).
  if (channelChanged && cfg.factionChannelId) {
    const client = tryGetDashboardClient();
    if (client) {
      await unpostFactionList(client, scope.guildId).catch(() => {});
      const orphanFactions = await prisma.faction.findMany({
        where: { guildId: scope.guildId, embedChannelId: null, embedMessageId: { not: null } },
        select: { id: true },
      });
      for (const of of orphanFactions) {
        await unpostFactionEmbed(client, of.id).catch(() => {});
      }
    }
  }

   
  const updated = await prisma.factionSystemConfig.update({
    where: { id: cfg.id },
    data: { factionChannelId: newChId, ...(channelChanged ? { listMessageId: null } : {}) },
  });
  logAuditDb('FACTION_SYSTEM_CONFIG_UPDATED', 'FACTION', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { factionChannelId: newChId, channelChanged },
  });

  // Wenn neuer Channel gesetzt: Faction-Embeds (ohne eigenen Channel) + Liste neu posten.
  if (newChId) {
    const client = tryGetDashboardClient();
    if (client) {
      const fallbackFactions = await prisma.faction.findMany({
        where: { guildId: scope.guildId, embedChannelId: null },
        select: { id: true },
      });
      for (const ff of fallbackFactions) {
        await postFactionEmbed(client, ff.id).catch(err => {
          logAuditDb('FACTION_EMBED_FAILED', 'FACTION', {
            actorUserId: req.auth!.userId, guildId: scope.guildId,
            details: { factionId: ff.id, action: 'system-config-rebroadcast', error: (err as Error).message },
          });
        });
      }
      await refreshList(scope.guildId, req.auth!.userId, 'system-config-changed');
    }
  }

  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: 'system-config' } });
  res.json({
    factionChannelId: updated.factionChannelId,
    listMessageId: updated.listMessageId,
    updatedAt: updated.updatedAt.toISOString(),
  });
});

// ============================================================================
// Lookups: Channels + Members (factions.manage scope, NICHT Owner-only)
// ============================================================================

factionsRouter.get('/lookups/channels', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.json({ channels: [] }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }
  // Nur Text-/Announcement-/Forum-Channel.
  const TEXT_TYPES = new Set([0, 5, 15]);
  const channels = guild.channels.cache
    .filter(ch => TEXT_TYPES.has(ch.type as number))
    .map(ch => ({ id: ch.id, name: ch.name ?? '', type: ch.type as number, parentId: (ch as { parentId?: string | null }).parentId ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ channels });
});

factionsRouter.get('/lookups/members', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const client = tryGetDashboardClient();
  if (!client) { res.json({ members: [] }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }

  // Wenn Suche < 2 Zeichen: Top-25 (cache) zurueck.
  let members;
  if (q.length >= 2) {
    members = await guild.members.fetch({ query: q, limit: 25 }).catch(() => null);
  } else {
    members = guild.members.cache;
  }
  if (!members) { res.json({ members: [] }); return; }

  const list = Array.from(members.values())
    .slice(0, 25)
    .map(m => ({
      id: m.id,
      username: m.user.username,
      globalName: m.user.globalName ?? null,
      displayName: m.displayName,
      avatarUrl: m.user.displayAvatarURL({ size: 64 }),
      bot: m.user.bot,
    }));
  res.json({ members: list });
});

// Lookup einzelner User (zum Auflösen einer gespeicherten Discord-ID -> Anzeige).
factionsRouter.get('/lookups/members/:userId', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const userId = String(req.params.userId);
  if (!SNOWFLAKE_RE.test(userId)) { res.status(400).json({ error: 'userId ungueltig.' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.json({ id: userId, username: null, displayName: null, avatarUrl: null }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }
  const m = await guild.members.fetch(userId).catch(() => null);
  if (!m) { res.json({ id: userId, username: null, displayName: null, avatarUrl: null }); return; }
  res.json({
    id: m.id,
    username: m.user.username,
    globalName: m.user.globalName ?? null,
    displayName: m.displayName,
    avatarUrl: m.user.displayAvatarURL({ size: 64 }),
    bot: m.user.bot,
  });
});

factionsRouter.get('/lookups/roles', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.json({ roles: [] }); return; }
  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) { res.status(404).json({ error: 'Guild nicht erreichbar.' }); return; }
  const me = guild.members.me;
  const myTop = me?.roles.highest.position ?? 0;
  const roles = guild.roles.cache
    .filter(r => !r.managed && r.id !== guild.id) // @everyone + integration-roles ausblenden
    .map(r => ({
      id: r.id,
      name: r.name,
      color: r.hexColor,
      position: r.position,
      assignable: r.position < myTop,
    }))
    .sort((a, b) => b.position - a.position);
  res.json({ roles });
});
