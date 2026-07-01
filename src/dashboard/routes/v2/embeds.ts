/**
 * Embed-Builder Routen — eigenständige eingebettete Nachrichten pro Guild.
 * Dashboard-only: es existieren KEINE Slash-/Prefix-Commands fuer dieses Feature.
 *
 *   GET    /                 Embeds/Vorlagen der Guild auflisten (?template=1 / ?draft=1)
 *   GET    /:id              Einzelnen Embed laden
 *   POST   /                 Embed anlegen (Entwurf/Vorlage)
 *   PUT    /:id              Embed aktualisieren
 *   DELETE /:id              Embed loeschen (+ ggf. gepostete Nachricht best-effort)
 *   POST   /:id/duplicate    Embed duplizieren (als Entwurf)
 *   POST   /:id/send         In Ziel-Channel posten (oder bestehende Nachricht editieren)
 *   POST   /:id/sync         Bereits gepostete Nachricht mit aktuellem Stand aktualisieren
 *   POST   /media            Bild hochladen (multipart, guild-scoped) -> absolute URL
 *
 * Strikte guildId-Scope-Pruefung in jeder Operation (jede Prisma-Query traegt guildId).
 */

import { Router } from 'express';
import multer from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { Prisma } from '@prisma/client';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { config } from '../../../config';
import {
  embedHasContent,
  parseFields,
  sendOrEditEmbed,
  validateChannelAnchors,
  validateEmbedContent,
  type EmbedField,
} from '../../../modules/embeds/embedBuilder';

export const embedsRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const MAX_NAME = 120;

// --- Medien-Upload (Embed-Bilder) -------------------------------------------
const EMBED_UPLOADS_BASE = path.join(config.upload.dir, 'media', 'embeds');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4, parts: 6 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Nur PNG, JPG, JPEG, WEBP oder GIF erlaubt.'));
  },
});

function imageExtFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '.bin';
  }
}

// ── Body-Parsing/Validierung ────────────────────────────────────────────────
interface EmbedBody {
  name?: unknown;
  channelId?: unknown;
  content?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  color?: unknown;
  authorName?: unknown;
  authorIconUrl?: unknown;
  authorUrl?: unknown;
  footerText?: unknown;
  footerIconUrl?: unknown;
  thumbnailUrl?: unknown;
  imageUrl?: unknown;
  showTimestamp?: unknown;
  fields?: unknown;
  isTemplate?: unknown;
  isDraft?: unknown;
}

interface NormalizedEmbed {
  name: string;
  channelId: string | null;
  content: string | null;
  title: string | null;
  description: string | null;
  url: string | null;
  color: string | null;
  authorName: string | null;
  authorIconUrl: string | null;
  authorUrl: string | null;
  footerText: string | null;
  footerIconUrl: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  showTimestamp: boolean;
  fields: EmbedField[];
  isTemplate: boolean;
  isDraft: boolean;
}

/** Leerstring/Whitespace -> null, sonst getrimmter String. */
function nullableStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** EmbedField[] -> Prisma-JSON-Input (EmbedField hat keine Index-Signatur). */
function fieldsJson(f: EmbedField[]): Prisma.InputJsonValue {
  return f as unknown as Prisma.InputJsonValue;
}

function validateEmbedBody(b: EmbedBody):
  | { ok: true; data: NormalizedEmbed }
  | { ok: false; error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length === 0) return { ok: false, error: 'Name darf nicht leer sein.' };
  if (name.length > MAX_NAME) return { ok: false, error: `Name darf max. ${MAX_NAME} Zeichen haben.` };

  let channelId: string | null = null;
  if (b.channelId != null && b.channelId !== '') {
    if (typeof b.channelId !== 'string' || !SNOWFLAKE_RE.test(b.channelId)) {
      return { ok: false, error: 'channelId muss eine Discord-Snowflake sein.' };
    }
    channelId = b.channelId;
  }

  // Felder defensiv parsen (nur name+value mit Inhalt zaehlen).
  const fields = parseFields(b.fields);

  const data: NormalizedEmbed = {
    name,
    channelId,
    content: nullableStr(b.content),
    title: nullableStr(b.title),
    description: nullableStr(b.description),
    url: nullableStr(b.url),
    color: nullableStr(b.color),
    authorName: nullableStr(b.authorName),
    authorIconUrl: nullableStr(b.authorIconUrl),
    authorUrl: nullableStr(b.authorUrl),
    footerText: nullableStr(b.footerText),
    footerIconUrl: nullableStr(b.footerIconUrl),
    thumbnailUrl: nullableStr(b.thumbnailUrl),
    imageUrl: nullableStr(b.imageUrl),
    showTimestamp: b.showTimestamp === true,
    fields,
    isTemplate: b.isTemplate === true,
    isDraft: b.isDraft !== false, // Default: Entwurf
  };

  const err = validateEmbedContent(data);
  if (err) return { ok: false, error: err };

  return { ok: true, data };
}

/** Prisma-Row -> API-JSON (fields sauber typisiert). */
function toApi(row: {
  id: string; guildId: string; name: string; channelId: string | null; messageId: string | null;
  content: string | null; title: string | null; description: string | null; url: string | null;
  color: string | null; authorName: string | null; authorIconUrl: string | null; authorUrl: string | null;
  footerText: string | null; footerIconUrl: string | null; thumbnailUrl: string | null; imageUrl: string | null;
  showTimestamp: boolean; fields: unknown; isTemplate: boolean; isDraft: boolean;
  createdBy: string; createdAt: Date; updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channelId,
    messageId: row.messageId,
    content: row.content,
    title: row.title,
    description: row.description,
    url: row.url,
    color: row.color,
    authorName: row.authorName,
    authorIconUrl: row.authorIconUrl,
    authorUrl: row.authorUrl,
    footerText: row.footerText,
    footerIconUrl: row.footerIconUrl,
    thumbnailUrl: row.thumbnailUrl,
    imageUrl: row.imageUrl,
    showTimestamp: row.showTimestamp,
    fields: parseFields(row.fields),
    isTemplate: row.isTemplate,
    isDraft: row.isDraft,
    isPosted: row.messageId != null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ===========================================================================
//  CRUD
// ===========================================================================

embedsRouter.get('/', requireGuildPermission('embeds.view'), async (req, res) => {
  const scope = req.guildScope!;
  const where: { guildId: string; isTemplate?: boolean; isDraft?: boolean } = { guildId: scope.guildId };
  if (req.query.template === '1') where.isTemplate = true;
  if (req.query.draft === '1') where.isDraft = true;

  const rows = await prisma.dashboardEmbed.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ embeds: rows.map(toApi) });
});

embedsRouter.get('/:id', requireGuildPermission('embeds.view'), async (req, res) => {
  const scope = req.guildScope!;
  const row = await prisma.dashboardEmbed.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
  });
  if (!row) { res.status(404).json({ error: 'Embed nicht gefunden.' }); return; }
  res.json(toApi(row));
});

embedsRouter.post('/', requireGuildPermission('embeds.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const v = validateEmbedBody(req.body as EmbedBody);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const d = v.data;

  const created = await prisma.dashboardEmbed.create({
    data: {
      guildId: scope.guildId,
      name: d.name,
      channelId: d.channelId,
      content: d.content,
      title: d.title,
      description: d.description,
      url: d.url,
      color: d.color,
      authorName: d.authorName,
      authorIconUrl: d.authorIconUrl,
      authorUrl: d.authorUrl,
      footerText: d.footerText,
      footerIconUrl: d.footerIconUrl,
      thumbnailUrl: d.thumbnailUrl,
      imageUrl: d.imageUrl,
      showTimestamp: d.showTimestamp,
      fields: fieldsJson(d.fields),
      isTemplate: d.isTemplate,
      isDraft: d.isDraft,
      createdBy: scope.actorDiscordId,
    },
  });

  logAuditDb('EMBED_CREATED', 'EMBED', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { embedId: created.id, name: created.name, isTemplate: created.isTemplate },
  });
  emitGuildEvent(scope.guildId, { type: 'embed.changed', payload: { guildId: scope.guildId, embedId: created.id } });
  res.status(201).json(toApi(created));
});

embedsRouter.put('/:id', requireGuildPermission('embeds.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await prisma.dashboardEmbed.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
  });
  if (!existing) { res.status(404).json({ error: 'Embed nicht gefunden.' }); return; }

  const v = validateEmbedBody(req.body as EmbedBody);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const d = v.data;

  await prisma.dashboardEmbed.updateMany({
    where: { id: existing.id, guildId: scope.guildId },
    data: {
      name: d.name,
      channelId: d.channelId,
      content: d.content,
      title: d.title,
      description: d.description,
      url: d.url,
      color: d.color,
      authorName: d.authorName,
      authorIconUrl: d.authorIconUrl,
      authorUrl: d.authorUrl,
      footerText: d.footerText,
      footerIconUrl: d.footerIconUrl,
      thumbnailUrl: d.thumbnailUrl,
      imageUrl: d.imageUrl,
      showTimestamp: d.showTimestamp,
      fields: fieldsJson(d.fields),
      isTemplate: d.isTemplate,
      isDraft: d.isDraft,
    },
  });

  const updated = await prisma.dashboardEmbed.findFirst({
    where: { id: existing.id, guildId: scope.guildId },
  });
  logAuditDb('EMBED_UPDATED', 'EMBED', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { embedId: existing.id, name: d.name },
  });
  emitGuildEvent(scope.guildId, { type: 'embed.changed', payload: { guildId: scope.guildId, embedId: existing.id } });
  res.json(toApi(updated!));
});

embedsRouter.delete('/:id', requireGuildPermission('embeds.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await prisma.dashboardEmbed.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
  });
  if (!existing) { res.status(404).json({ error: 'Embed nicht gefunden.' }); return; }

  // Best-effort: bereits gepostete Nachricht entfernen (kein Orphan im Channel).
  let messageDeleted = false;
  if (existing.messageId && existing.channelId) {
    const client = tryGetDashboardClient();
    if (client) {
      const channel = await client.channels.fetch(existing.channelId).catch(() => null);
      if (channel && channel.isTextBased() && !channel.isDMBased()) {
        await channel.messages.delete(existing.messageId).then(() => { messageDeleted = true; }).catch(() => {});
      }
    }
  }

  await prisma.dashboardEmbed.deleteMany({ where: { id: existing.id, guildId: scope.guildId } });

  logAuditDb('EMBED_DELETED', 'EMBED', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { embedId: existing.id, name: existing.name, messageDeleted },
  });
  emitGuildEvent(scope.guildId, { type: 'embed.changed', payload: { guildId: scope.guildId, embedId: existing.id } });
  res.json({ ok: true, messageDeleted });
});

embedsRouter.post('/:id/duplicate', requireGuildPermission('embeds.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const src = await prisma.dashboardEmbed.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
  });
  if (!src) { res.status(404).json({ error: 'Embed nicht gefunden.' }); return; }

  const copyName = `${src.name} (Kopie)`.slice(0, MAX_NAME);
  const created = await prisma.dashboardEmbed.create({
    data: {
      guildId: scope.guildId,
      name: copyName,
      channelId: src.channelId,
      content: src.content,
      title: src.title,
      description: src.description,
      url: src.url,
      color: src.color,
      authorName: src.authorName,
      authorIconUrl: src.authorIconUrl,
      authorUrl: src.authorUrl,
      footerText: src.footerText,
      footerIconUrl: src.footerIconUrl,
      thumbnailUrl: src.thumbnailUrl,
      imageUrl: src.imageUrl,
      showTimestamp: src.showTimestamp,
      fields: fieldsJson(parseFields(src.fields)),
      isTemplate: src.isTemplate,
      isDraft: true,       // Kopie ist immer ein frischer Entwurf
      messageId: null,     // nicht an die Quell-Nachricht gekoppelt
      createdBy: scope.actorDiscordId,
    },
  });

  logAuditDb('EMBED_DUPLICATED', 'EMBED', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { sourceId: src.id, embedId: created.id },
  });
  emitGuildEvent(scope.guildId, { type: 'embed.changed', payload: { guildId: scope.guildId, embedId: created.id } });
  res.status(201).json(toApi(created));
});

// ===========================================================================
//  Senden / Synchronisieren
// ===========================================================================

embedsRouter.post('/:id/send', requireGuildPermission('embeds.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const embed = await prisma.dashboardEmbed.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
  });
  if (!embed) { res.status(404).json({ error: 'Embed nicht gefunden.' }); return; }

  // Ziel-Channel: optional aus dem Body (dann persistiert), sonst gespeicherter.
  const body = req.body as { channelId?: unknown };
  let channelId = embed.channelId;
  if (body.channelId != null && body.channelId !== '') {
    if (typeof body.channelId !== 'string' || !SNOWFLAKE_RE.test(body.channelId)) {
      res.status(400).json({ error: 'channelId muss eine Discord-Snowflake sein.' }); return;
    }
    channelId = body.channelId;
  }
  if (!channelId) { res.status(400).json({ error: 'Kein Ziel-Channel gesetzt.' }); return; }

  if (!embedHasContent(embed)) {
    res.status(400).json({ error: 'Embed hat keinen sichtbaren Inhalt.' }); return;
  }
  const contentErr = validateEmbedContent(embed);
  if (contentErr) { res.status(400).json({ error: contentErr }); return; }

  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  const channelOk = await validateBotChannelAccess(client, scope.guildId, channelId, [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  ]);
  if (!channelOk.ok) { res.status(400).json({ error: channelOk.reason }); return; }

  const anchorOk = await validateChannelAnchors(client, scope.guildId, embed);
  if (!anchorOk.ok) { res.status(400).json({ error: anchorOk.reason }); return; }

  let result: { messageId: string };
  try {
    result = await sendOrEditEmbed(client, {
      ...embed,
      channelId,
      // Bei Channel-Wechsel die alte messageId nicht wiederverwenden.
      messageId: channelId === embed.channelId ? embed.messageId : null,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message }); return;
  }

  await prisma.dashboardEmbed.updateMany({
    where: { id: embed.id, guildId: scope.guildId },
    data: { channelId, messageId: result.messageId, isDraft: false },
  });

  logAuditDb('EMBED_SENT', 'EMBED', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, channelId,
    details: { embedId: embed.id, messageId: result.messageId },
  });
  emitGuildEvent(scope.guildId, { type: 'embed.changed', payload: { guildId: scope.guildId, embedId: embed.id } });
  res.json({ ok: true, messageId: result.messageId, channelId });
});

embedsRouter.post('/:id/sync', requireGuildPermission('embeds.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const embed = await prisma.dashboardEmbed.findFirst({
    where: { id: req.params.id, guildId: scope.guildId },
  });
  if (!embed) { res.status(404).json({ error: 'Embed nicht gefunden.' }); return; }
  if (!embed.messageId || !embed.channelId) {
    res.status(400).json({ error: 'Embed wurde noch nicht gesendet.' }); return;
  }

  const contentErr = validateEmbedContent(embed);
  if (contentErr) { res.status(400).json({ error: contentErr }); return; }

  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  const anchorOk = await validateChannelAnchors(client, scope.guildId, embed);
  if (!anchorOk.ok) { res.status(400).json({ error: anchorOk.reason }); return; }

  let result: { messageId: string };
  try {
    result = await sendOrEditEmbed(client, { ...embed });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message }); return;
  }

  // messageId kann sich aendern, falls die Original-Nachricht geloescht wurde.
  if (result.messageId !== embed.messageId) {
    await prisma.dashboardEmbed.updateMany({
      where: { id: embed.id, guildId: scope.guildId },
      data: { messageId: result.messageId },
    });
  }

  logAuditDb('EMBED_SYNCED', 'EMBED', {
    actorUserId: req.auth!.userId, guildId: scope.guildId, channelId: embed.channelId,
    details: { embedId: embed.id, messageId: result.messageId },
  });
  emitGuildEvent(scope.guildId, { type: 'embed.changed', payload: { guildId: scope.guildId, embedId: embed.id } });
  res.json({ ok: true, messageId: result.messageId });
});

// ===========================================================================
//  Medien-Upload — guild-scoped, absolute URL fuer Discord + Preview
// ===========================================================================

embedsRouter.post(
  '/media',
  requireGuildPermission('embeds.manage'),
  imageUpload.single('file'),
  async (req, res) => {
    const scope = req.guildScope!;
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Keine Datei hochgeladen.' }); return; }
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      res.status(400).json({ error: 'Nur PNG, JPG, JPEG, WEBP oder GIF erlaubt.' }); return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      res.status(400).json({ error: `Datei zu gross (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).` }); return;
    }

    const dir = path.join(EMBED_UPLOADS_BASE, scope.guildId);
    await fs.mkdir(dir, { recursive: true });

    const filename = `embed-${randomUUID()}${imageExtFor(file.mimetype)}`;
    await fs.writeFile(path.join(dir, filename), file.buffer);

    // Absolute URL: Discord laedt Embed-Bilder serverseitig (relative Pfade
    // funktionieren dort nicht). Basis = konfigurierte Dashboard-URL.
    const relPath = `/uploads/media/embeds/${scope.guildId}/${filename}`;
    const absoluteUrl = `${config.dashboard.url.replace(/\/+$/, '')}${relPath}`;

    logAuditDb('EMBED_MEDIA_UPLOADED', 'EMBED', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { mime: file.mimetype, size: file.size },
    });
    res.json({ url: absoluteUrl });
  },
);
