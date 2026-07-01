/**
 * Welcome-Routen — Begruessungssystem pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 *   GET    /config        Aktuelle Welcome-Konfiguration
 *   POST   /config        Konfiguration speichern (enabled/channel/mode/message/media)
 *   POST   /test          Testnachricht in den Channel senden (rendert wie der Live-Join)
 *   POST   /disable       Welcome deaktivieren (Config bleibt erhalten)
 *   POST   /media         Willkommensbild hochladen (multipart, guild-scoped)
 *   DELETE /media         Willkommensbild entfernen (Config + Datei)
 *   GET    /autoroles     Auto-Rollen der Guild auflisten
 *   POST   /autoroles     Auto-Rolle (Trigger JOIN) hinzufuegen — mit Rollen-Validierung
 *   PATCH  /autoroles/:id Auto-Rolle aktivieren/deaktivieren
 *   DELETE /autoroles/:id Auto-Rolle entfernen
 *
 * Datenhaltung ausschliesslich ueber welcomeManager + AutoRole-Model (kein Parallel-State).
 * Medien werden ueber das bestehende /uploads-System (express.static) abgelegt:
 *   /uploads/media/welcome/<guildId>/<filename>  — strikt guild-scoped.
 * Strikte guildId-Scope-Pruefung in jeder Operation.
 */

import { Router } from 'express';
import multer from 'multer';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import {
  getWelcomeConfig,
  setWelcomeConfig,
  disableWelcome,
  renderWelcomeMessage,
  sendWelcomeMessages,
  type WelcomeConfig,
} from '../../../modules/welcome/welcomeManager';
import { resolveCustomEmotes } from '../../../modules/ai/emoteResolver';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { config } from '../../../config';

export const welcomeRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const SUPPORTED_MEDIA = /^https?:\/\/.+\.(jpe?g|png|gif|webp|mp4|webm|mov)(\?.*)?$/i;
const MAX_MESSAGE = 1000;

// --- Medien-Upload (Willkommensbild) ----------------------------------------
// Wiederverwendung des bestehenden /uploads-Systems (kein zweites Upload-System).
const WELCOME_UPLOADS_BASE = path.join(config.upload.dir, 'media', 'welcome');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB — Willkommensbilder sind Bilder, kein Video
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const imageUpload = multer({
  // memoryStorage ist bewusst gewählt: das Bild wird nach Magic-/MIME-Prüfung
  // direkt auf Platte geschrieben. RAM-Obergrenze pro Request = fileSize (8 MB).
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 12 },
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

/** Strikte Erlaubt-Pruefung fuer lokal hochgeladene Willkommensbilder (guild-scoped). */
function localWelcomeMediaRe(guildId: string): RegExp {
  return new RegExp(`^/uploads/media/welcome/${guildId}/[A-Za-z0-9_-]+\\.(jpe?g|png|webp|gif)$`, 'i');
}

interface WelcomeBody {
  enabled?: boolean;
  channelId?: string;
  message?: string;
  mode?: string;
  mediaUrl?: string | null;
  mediaLayout?: string;
}

function validateBody(b: WelcomeBody, guildId: string):
  | { ok: true; data: WelcomeConfig }
  | { ok: false; error: string } {
  if (typeof b.channelId !== 'string' || !SNOWFLAKE_RE.test(b.channelId)) {
    return { ok: false, error: 'channelId muss eine Discord-Snowflake sein.' };
  }
  if (typeof b.message !== 'string' || b.message.trim().length === 0) {
    return { ok: false, error: 'message darf nicht leer sein.' };
  }
  if (b.message.length > MAX_MESSAGE) {
    return { ok: false, error: `message darf maximal ${MAX_MESSAGE} Zeichen lang sein.` };
  }
  // KI-Modus entfernt: Willkommen nutzt ausschliesslich statischen Text.
  let mediaUrl: string | undefined;
  if (b.mediaUrl != null && b.mediaUrl !== '') {
    if (typeof b.mediaUrl !== 'string') {
      return { ok: false, error: 'mediaUrl ist ungueltig.' };
    }
    // Erlaubt: lokal hochgeladenes guild-scoped Bild ODER externe http(s)-Medien-URL.
    const isLocal = localWelcomeMediaRe(guildId).test(b.mediaUrl);
    if (!isLocal && !SUPPORTED_MEDIA.test(b.mediaUrl)) {
      return { ok: false, error: 'mediaUrl muss ein hochgeladenes Bild oder ein http(s)-Link auf jpg/png/gif/webp/mp4/webm/mov sein.' };
    }
    mediaUrl = b.mediaUrl;
  }
  // Reihenfolge bei gesetztem Bild — Default image_first (Bild zuerst, Text darunter).
  const mediaLayout: 'image_first' | 'text_first' = b.mediaLayout === 'text_first' ? 'text_first' : 'image_first';
  return {
    ok: true,
    data: {
      enabled: b.enabled !== false,
      channelId: b.channelId,
      message: b.message,
      mode: 'text',
      mediaUrl,
      mediaLayout,
    },
  };
}

async function ensureChannel(channelId: string, guildId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return null;
  const v = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return v.ok ? null : v.reason;
}

function serialize(cfg: WelcomeConfig | null) {
  if (!cfg) {
    return { configured: false, enabled: false, channelId: '', message: '', mode: 'text' as const, mediaUrl: null, mediaLayout: 'image_first' as const };
  }
  return {
    configured: true,
    enabled: cfg.enabled,
    channelId: cfg.channelId,
    message: cfg.message,
    mode: 'text' as const,
    mediaUrl: cfg.mediaUrl ?? null,
    mediaLayout: cfg.mediaLayout ?? 'image_first',
  };
}

welcomeRouter.get('/config', requireGuildPermission('welcome.view'), async (req, res) => {
  const scope = req.guildScope!;
  const cfg = await getWelcomeConfig(scope.guildId);
  res.json(serialize(cfg));
});

/**
 * Read-only Auto-Rollen-Liste (Onboarding-Kontext). Verwaltung bleibt im
 * Discord-Command `/autorole`. Strikte guildId-Scope-Pruefung.
 */
welcomeRouter.get('/autoroles', requireGuildPermission('welcome.view'), async (req, res) => {
  const scope = req.guildScope!;
  const rows = await prisma.autoRole.findMany({
    where: { guildId: scope.guildId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    autoroles: rows.map(r => ({
      id: r.id,
      roleId: r.roleId,
      roleName: r.roleName,
      triggerType: r.triggerType,
      triggerValue: r.triggerValue,
      isActive: r.isActive,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

welcomeRouter.post('/config', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const v = validateBody(req.body as WelcomeBody, scope.guildId);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const channelErr = await ensureChannel(v.data.channelId, scope.guildId);
  if (channelErr) { res.status(400).json({ error: channelErr }); return; }

  await setWelcomeConfig(scope.guildId, v.data, scope.actorDiscordId);
  logAuditDb('WELCOME_CONFIG_SAVED', 'WELCOME', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { channelId: v.data.channelId, mode: v.data.mode, enabled: v.data.enabled },
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json(serialize(v.data));
});

welcomeRouter.post('/disable', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await getWelcomeConfig(scope.guildId);
  if (!existing) { res.status(404).json({ error: 'Keine Welcome-Konfiguration vorhanden.' }); return; }
  await disableWelcome(scope.guildId, scope.actorDiscordId);
  logAuditDb('WELCOME_DISABLED', 'WELCOME', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json(serialize({ ...existing, enabled: false }));
});

welcomeRouter.post('/test', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) { res.status(404).json({ error: 'Bot ist nicht in dieser Guild.' }); return; }

  // Body darf eine noch nicht gespeicherte Config zum Testen mitliefern.
  const body = req.body as WelcomeBody;
  let cfg: WelcomeConfig | null;
  if (body && typeof body.channelId === 'string' && body.message !== undefined) {
    const v = validateBody(body, scope.guildId);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    cfg = v.data;
  } else {
    cfg = await getWelcomeConfig(scope.guildId);
  }
  if (!cfg) { res.status(400).json({ error: 'Keine Welcome-Konfiguration zum Testen.' }); return; }

  const channelErr = await ensureChannel(cfg.channelId, scope.guildId);
  if (channelErr) { res.status(400).json({ error: channelErr }); return; }

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    res.status(400).json({ error: 'Channel ist kein sendbarer Text-Channel.' }); return; }

  const userMention = `<@${scope.actorDiscordId}>`;
  const memberCount = guild.memberCount;

  const messageText = renderWelcomeMessage(cfg.message, { user: userMention, guild: guild.name, memberCount });

  const finalText = resolveCustomEmotes(messageText, guild);
  // Begruessung als Embed (Text als Beschreibung, optionales Bild im Embed).
  await sendWelcomeMessages(channel, {
    text: `🧪 **Testnachricht** — ${finalText}`,
    mediaUrl: cfg.mediaUrl,
    mediaLayout: cfg.mediaLayout,
    mentionUserId: scope.actorDiscordId,
  });
  logAuditDb('WELCOME_TEST_SENT', 'WELCOME', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { channelId: cfg.channelId, mode: 'text' },
  });
  res.json({ ok: true, channelId: cfg.channelId });
});

// ===========================================================================
//  Medien-Upload (Willkommensbild) — guild-scoped, bestehendes /uploads-System
// ===========================================================================

/**
 * Bild hochladen. Multipart-Field `file`. Nur Bilder (PNG/JPG/JPEG/WEBP/GIF).
 * Ablage strikt guild-scoped unter /uploads/media/welcome/<guildId>/<uuid>.<ext>.
 * Der Client uebernimmt die zurueckgegebene URL ins Medien-Feld und speichert
 * sie ueber POST /config in die Welcome-Config. Der Upload-Pfad ist NICHT vom
 * Client bestimmbar (Dateiname serverseitig generiert, guildId aus dem Scope).
 */
welcomeRouter.post(
  '/media',
  requireGuildPermission('welcome.manage'),
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

    const dir = path.join(WELCOME_UPLOADS_BASE, scope.guildId);
    await fs.mkdir(dir, { recursive: true });

    // Nur EIN Willkommensbild pro Guild: alte Dateien im Guild-Ordner entfernen,
    // damit kein Disk-Leak durch ueberschriebene Uploads entsteht. Best-Effort.
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        await fs.unlink(path.join(dir, entry)).catch(() => {});
      }
    } catch { /* Ordner ggf. neu — ignorieren */ }

    const filename = `welcome-${randomUUID()}${imageExtFor(file.mimetype)}`;
    await fs.writeFile(path.join(dir, filename), file.buffer);
    const publicUrl = `/uploads/media/welcome/${scope.guildId}/${filename}`;

    logAuditDb('WELCOME_MEDIA_UPLOADED', 'WELCOME', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { mime: file.mimetype, size: file.size },
    });
    res.json({ url: publicUrl });
  },
);

/**
 * Willkommensbild entfernen. Leert mediaUrl in der Config (falls vorhanden) und
 * loescht die lokale Datei, sofern es sich um ein guild-scoped Upload-Bild
 * handelt. Externe http(s)-URLs werden NICHT geloescht (liegen nicht bei uns) —
 * dann wird ausschliesslich das Config-Feld geleert.
 */
welcomeRouter.delete('/media', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const existing = await getWelcomeConfig(scope.guildId);
  const prevUrl = existing?.mediaUrl;

  // Datei nur loeschen, wenn sie strikt zu DIESER Guild gehoert (kein Pfad-Traversal).
  let fileDeleted = false;
  if (prevUrl && localWelcomeMediaRe(scope.guildId).test(prevUrl)) {
    const abs = path.join(process.cwd(), prevUrl.replace(/^\/+/, ''));
    // Defense-in-Depth: sicherstellen, dass der aufgeloeste Pfad im Guild-Ordner liegt.
    const guildDir = path.join(WELCOME_UPLOADS_BASE, scope.guildId);
    if (abs.startsWith(guildDir + path.sep)) {
      await fs.unlink(abs).then(() => { fileDeleted = true; }).catch(() => {
        // Datei evtl. bereits weg — Config-Feld wird trotzdem geleert.
      });
    }
  }

  // Config-Feld leeren (nur wenn eine Config existiert; sonst nichts zu tun).
  if (existing) {
    await setWelcomeConfig(scope.guildId, { ...existing, mediaUrl: undefined }, scope.actorDiscordId);
    emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  }

  logAuditDb('WELCOME_MEDIA_REMOVED', 'WELCOME', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { fileDeleted, hadConfig: !!existing },
  });
  res.json({ ok: true, fileDeleted });
});

// ===========================================================================
//  Auto-Rollen — guild-scoped Verwaltung (gleiche Datenhaltung wie /autorole)
// ===========================================================================

welcomeRouter.post('/autoroles', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const body = req.body as { roleId?: string };
  if (typeof body.roleId !== 'string' || !SNOWFLAKE_RE.test(body.roleId)) {
    res.status(400).json({ error: 'roleId muss eine Discord-Snowflake sein.' }); return;
  }

  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  const guild = client.guilds.cache.get(scope.guildId);
  if (!guild) { res.status(404).json({ error: 'Bot ist nicht in dieser Guild.' }); return; }

  // Rolle MUSS zur aktuellen Guild gehoeren (keine fremden Guild-Rollen).
  const role = guild.roles.cache.get(body.roleId);
  if (!role) { res.status(400).json({ error: 'Rolle gehoert nicht zu diesem Server.' }); return; }
  if (role.id === guild.id) { res.status(400).json({ error: '@everyone kann nicht als Auto-Rolle gesetzt werden.' }); return; }
  if (role.managed) { res.status(400).json({ error: 'Integrations-/Bot-Rollen koennen nicht vergeben werden.' }); return; }

  const me = guild.members.me;
  if (!me) { res.status(503).json({ error: 'Bot-Mitglied nicht im Cache.' }); return; }
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    res.status(400).json({ error: 'Bot hat keine "Rollen verwalten"-Berechtigung.' }); return;
  }
  if (role.position >= me.roles.highest.position) {
    res.status(400).json({ error: 'Bot-Rolle steht nicht ueber der Zielrolle — Vergabe nicht moeglich.' }); return;
  }

  // Duplikat-Schutz: gleiche Rolle als JOIN-Trigger nicht doppelt anlegen.
  const dup = await prisma.autoRole.findFirst({
    where: { guildId: scope.guildId, roleId: role.id, triggerType: 'JOIN' },
  });
  if (dup) { res.status(409).json({ error: 'Diese Rolle ist bereits als Auto-Rolle gesetzt.' }); return; }

  const created = await prisma.autoRole.create({
    data: {
      guildId: scope.guildId,
      roleId: role.id,
      roleName: role.name,
      triggerType: 'JOIN',
      isActive: true,
    },
  });
  logAuditDb('AUTOROLE_CREATED', 'AUTOROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { roleId: role.id, roleName: role.name, source: 'dashboard' },
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json({
    autorole: {
      id: created.id, roleId: created.roleId, roleName: created.roleName,
      triggerType: created.triggerType, triggerValue: created.triggerValue,
      isActive: created.isActive, expiresAt: created.expiresAt?.toISOString() ?? null,
      createdAt: created.createdAt.toISOString(),
    },
  });
});

welcomeRouter.patch('/autoroles/:id', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const body = req.body as { isActive?: boolean };
  if (typeof body.isActive !== 'boolean') {
    res.status(400).json({ error: 'isActive muss ein Boolean sein.' }); return;
  }
  // Scope-Pruefung: nur Auto-Rollen DIESER Guild aenderbar.
  const row = await prisma.autoRole.findFirst({ where: { id, guildId: scope.guildId } });
  if (!row) { res.status(404).json({ error: 'Auto-Rolle nicht gefunden.' }); return; }

  const updated = await prisma.autoRole.update({ where: { id: row.id }, data: { isActive: body.isActive } });
  logAuditDb('AUTOROLE_TOGGLED', 'AUTOROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { roleId: row.roleId, isActive: body.isActive, source: 'dashboard' },
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json({ ok: true, isActive: updated.isActive });
});

welcomeRouter.delete('/autoroles/:id', requireGuildPermission('welcome.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  // Scope-Pruefung: nur Auto-Rollen DIESER Guild loeschbar.
  const row = await prisma.autoRole.findFirst({ where: { id, guildId: scope.guildId } });
  if (!row) { res.status(404).json({ error: 'Auto-Rolle nicht gefunden.' }); return; }

  await prisma.autoRole.delete({ where: { id: row.id } });
  logAuditDb('AUTOROLE_DELETED', 'AUTOROLE', {
    actorUserId: req.auth!.userId, guildId: scope.guildId,
    details: { roleId: row.roleId, roleName: row.roleName, source: 'dashboard' },
  });
  emitGuildEvent(scope.guildId, { type: 'welcome.changed', payload: { guildId: scope.guildId } });
  res.json({ ok: true });
});
