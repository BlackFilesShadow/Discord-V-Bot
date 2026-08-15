import { Router, type Request } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelType, type Guild } from 'discord.js';
import { requireBotAdmin } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logger, logAudit, logAuditDb } from '../../../utils/logger';
import {
  addTrigger,
  clearTriggers,
  GLOBAL_AI_TRIGGERS,
  listTriggers,
  MAX_TRIGGERS_PER_GUILD,
  removeTrigger,
  type AiTrigger,
} from '../../../modules/ai/triggers';
import {
  deleteMediaIfLocal,
  MAX_MEDIA_BYTES,
  MEDIA_BASE_DIR,
  saveRemoteMedia,
} from '../../../modules/ai/mediaStorage';
import { resolveCustomEmotes } from '../../../modules/ai/emoteResolver';

const SNOWFLAKE = /^\d{17,20}$/;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov)$/i;
const MEDIA_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime))$/i;
const ALLOWED_TRIGGER_CHANNEL_TYPES = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 20, parts: 24 },
});

export const botAdminTriggersRouter = Router();
botAdminTriggersRouter.use(requireBotAdmin);

function actor(req: Request): string {
  return String(req.auth?.discordId ?? req.auth?.userId ?? 'dashboard');
}

function audit(req: Request, action: string, details: Record<string, unknown>): void {
  logAudit(action, 'AI', { ...details, by: actor(req) });
  logAuditDb(action, 'AI', {
    actorUserId: req.auth?.userId ?? null,
    details,
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
}

function guildIdFrom(req: Request): string | null {
  const raw = typeof req.query.guildId === 'string'
    ? req.query.guildId
    : String(req.body?.guildId ?? '');
  return SNOWFLAKE.test(raw) ? raw : null;
}

async function resolveGuild(guildId: string): Promise<Guild | null> {
  const client = tryGetDashboardClient();
  if (!client) return null;
  return client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
}

async function validateTriggerChannel(guildId: string, channelId?: string): Promise<string | null> {
  if (!channelId) return null;
  if (!SNOWFLAKE.test(channelId)) return 'Ungültige channelId.';
  const client = tryGetDashboardClient();
  if (!client) return 'Discord-Client nicht verfügbar.';
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !('guildId' in channel) || channel.guildId !== guildId) {
    return 'Trigger-Channel gehört nicht zum ausgewählten Server.';
  }
  if (!ALLOWED_TRIGGER_CHANNEL_TYPES.has(channel.type as ChannelType)) {
    return 'Trigger-Channel muss Text-, Ankündigungs- oder Thread-Channel sein.';
  }
  return null;
}

type MediaKind = 'jpg' | 'png' | 'gif' | 'webp' | 'mp4' | 'webm';

function mediaKind(buffer: Buffer): MediaKind | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  const sig = buffer.length >= 6 ? buffer.subarray(0, 6).toString('ascii') : '';
  if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  if (buffer.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(buffer.subarray(4, 8).toString('ascii'))) return 'mp4';
  return null;
}

function extMatchesKind(filename: string, kind: MediaKind): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (kind === 'jpg') return ext === '.jpg' || ext === '.jpeg';
  if (kind === 'mp4') return ext === '.mp4' || ext === '.mov';
  return ext === `.${kind}`;
}

function mimeMatchesKind(mime: string, kind: MediaKind): boolean {
  const normalized = mime.split(';', 1)[0].toLowerCase();
  if (kind === 'jpg') return normalized === 'image/jpeg' || normalized === 'image/jpg';
  if (kind === 'mp4') return normalized === 'video/mp4' || normalized === 'video/quicktime';
  return normalized === (kind === 'webm' ? 'video/webm' : `image/${kind}`);
}

async function saveBrowserMedia(
  file: Express.Multer.File,
  guildId: string,
  key: string,
): Promise<{ ok: true; localPath: string } | { ok: false; error: string }> {
  if (!MEDIA_EXT.test(file.originalname) || !MEDIA_MIME.test(file.mimetype)) {
    return { ok: false, error: 'Nur JPG/PNG/GIF/WEBP/MP4/WEBM/MOV erlaubt.' };
  }
  if (file.buffer.length > MAX_MEDIA_BYTES) {
    return { ok: false, error: `Datei zu groß (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
  }
  const kind = mediaKind(file.buffer);
  if (!kind) return { ok: false, error: 'Dateiinhalt ist kein unterstütztes Bild/Video.' };
  if (!extMatchesKind(file.originalname, kind) || !mimeMatchesKind(file.mimetype, kind)) {
    return { ok: false, error: 'Dateiendung/MIME-Type und Dateiinhalt stimmen nicht überein.' };
  }

  const safeGuild = guildId.replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  const safeKey = key.replace(/[^a-z0-9_-]/gi, '').slice(0, 20);
  if (!safeGuild || !safeKey) return { ok: false, error: 'Ungültiger Media-Speicherschlüssel.' };
  const dir = path.join(MEDIA_BASE_DIR, 'triggers', safeGuild);
  const localPath = path.join(dir, `${safeKey}_${randomUUID()}.${kind}`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o750 });
    await fs.writeFile(localPath, file.buffer, { mode: 0o640 });
  } catch (error) {
    logger.error('BotAdmin Trigger-Media Speichern fehlgeschlagen', {
      guildId,
      triggerId: key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: 'Media konnte nicht gespeichert werden.' };
  }
  return { ok: true, localPath };
}

async function parseTrigger(req: Request): Promise<
  | { ok: true; guildId: string; trigger: AiTrigger }
  | { ok: false; status: number; error: string }
> {
  const guildId = guildIdFrom(req);
  if (!guildId) return { ok: false, status: 400, error: 'Gültige guildId erforderlich.' };
  const guild = await resolveGuild(guildId);
  if (!guild) return { ok: false, status: 404, error: 'Bot ist auf dem ausgewählten Server nicht verfügbar.' };

  const id = String(req.body?.id ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!id) return { ok: false, status: 400, error: 'Ungültige Trigger-ID.' };
  const triggerType = String(req.body?.triggerType ?? 'keyword') as AiTrigger['triggerType'];
  if (!['keyword', 'regex', 'mention'].includes(triggerType)) return { ok: false, status: 400, error: 'Ungültiger Trigger-Typ.' };
  const pattern = String(req.body?.pattern ?? '').slice(0, 500);
  if (!pattern) return { ok: false, status: 400, error: 'Pattern fehlt.' };
  if (triggerType === 'regex') {
    try { new RegExp(pattern); } catch (error) {
      return { ok: false, status: 400, error: `Ungültiger Regex: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const responseMode = String(req.body?.responseMode ?? 'text') as AiTrigger['responseMode'];
  if (!['text', 'ai'].includes(responseMode)) return { ok: false, status: 400, error: 'Ungültiger Antwortmodus.' };
  const rawResponse = String(req.body?.response ?? '').slice(0, 2000);
  if (!rawResponse) return { ok: false, status: 400, error: 'Antwort/AI-Anweisung fehlt.' };
  const channelId = String(req.body?.channelId ?? '').trim() || undefined;
  const channelError = await validateTriggerChannel(guildId, channelId);
  if (channelError) return { ok: false, status: channelError.includes('nicht verfügbar') ? 503 : 400, error: channelError };

  const rawCooldown = req.body?.cooldownSeconds;
  const cooldownSeconds = rawCooldown === undefined || rawCooldown === '' ? 10 : Number(rawCooldown);
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 3600) {
    return { ok: false, status: 400, error: 'Cooldown muss eine ganze Zahl zwischen 0 und 3600 sein.' };
  }

  const response = resolveCustomEmotes(rawResponse, guild);
  return {
    ok: true,
    guildId,
    trigger: {
      id,
      trigger: pattern,
      triggerType,
      responseMode,
      responseText: responseMode === 'text' ? response : undefined,
      aiPrompt: responseMode === 'ai' ? response : undefined,
      channelId,
      cooldownSeconds,
      createdAt: new Date().toISOString(),
      createdBy: actor(req),
    },
  };
}

async function verifiedGuildId(req: Request): Promise<{ guildId: string; guild: Guild } | null> {
  const guildId = guildIdFrom(req);
  if (!guildId) return null;
  const guild = await resolveGuild(guildId);
  return guild ? { guildId, guild } : null;
}

botAdminTriggersRouter.get('/', async (req, res) => {
  const verified = await verifiedGuildId(req);
  if (!verified) {
    res.status(guildIdFrom(req) ? 404 : 400).json({
      error: guildIdFrom(req)
        ? 'Bot ist auf dem ausgewählten Server nicht verfügbar.'
        : 'Gültige guildId erforderlich.',
    });
    return;
  }
  const channelOptions = verified.guild.channels.cache
    .filter(channel => ALLOWED_TRIGGER_CHANNEL_TYPES.has(channel.type as ChannelType))
    .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  res.json({
    items: await listTriggers(verified.guildId),
    max: MAX_TRIGGERS_PER_GUILD,
    channelOptions,
  });
});

botAdminTriggersRouter.post('/', async (req, res) => {
  const parsed = await parseTrigger(req);
  if (!parsed.ok) { res.status(parsed.status).json({ error: parsed.error }); return; }

  let media: string | undefined;
  const remoteUrl = typeof req.body?.mediaUrl === 'string' ? req.body.mediaUrl.trim() : '';
  if (remoteUrl) {
    const saved = await saveRemoteMedia(remoteUrl, 'triggers', parsed.guildId, parsed.trigger.id);
    if (!saved.ok || !saved.localPath) { res.status(400).json({ error: saved.message }); return; }
    media = saved.localPath;
  }

  const trigger = media ? { ...parsed.trigger, mediaUrl: media } : parsed.trigger;
  const result = await addTrigger(parsed.guildId, trigger);
  if (!result.ok) {
    if (media) await deleteMediaIfLocal(media);
    res.status(400).json({ error: result.message });
    return;
  }
  audit(req, 'BOTADMIN_AI_TRIGGER_UPSERT', { guildId: parsed.guildId, triggerId: trigger.id, triggerType: trigger.triggerType, responseMode: trigger.responseMode });
  res.status(201).json({ ok: true, message: result.message });
});

botAdminTriggersRouter.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'Datei fehlt.' }); return; }
  if (typeof req.body?.mediaUrl === 'string' && req.body.mediaUrl.trim()) {
    res.status(400).json({ error: 'Bitte entweder Datei ODER mediaUrl angeben, nicht beides.' });
    return;
  }

  const parsed = await parseTrigger(req);
  if (!parsed.ok) { res.status(parsed.status).json({ error: parsed.error }); return; }
  const saved = await saveBrowserMedia(file, parsed.guildId, parsed.trigger.id);
  if (!saved.ok) { res.status(400).json({ error: saved.error }); return; }
  const trigger = { ...parsed.trigger, mediaUrl: saved.localPath };
  const result = await addTrigger(parsed.guildId, trigger);
  if (!result.ok) {
    await deleteMediaIfLocal(saved.localPath);
    res.status(400).json({ error: result.message });
    return;
  }
  audit(req, 'BOTADMIN_AI_TRIGGER_UPSERT', { guildId: parsed.guildId, triggerId: trigger.id, mediaUpload: true });
  res.status(201).json({ ok: true, message: result.message });
});

botAdminTriggersRouter.post('/clear', async (req, res) => {
  const verified = await verifiedGuildId(req);
  if (!verified) { res.status(guildIdFrom(req) ? 404 : 400).json({ error: guildIdFrom(req) ? 'Bot ist auf dem ausgewählten Server nicht verfügbar.' : 'Gültige guildId erforderlich.' }); return; }
  if (req.body?.confirm !== 'CLEAR') { res.status(400).json({ error: 'Bestätigung CLEAR erforderlich.' }); return; }
  const all = await listTriggers(verified.guildId);
  const globalIds = new Set(GLOBAL_AI_TRIGGERS.map(trigger => trigger.id));
  const guildOwned = all.filter(trigger => !globalIds.has(trigger.id));
  await clearTriggers(verified.guildId, actor(req));
  await Promise.all(guildOwned.map(trigger => deleteMediaIfLocal(trigger.mediaUrl)));
  audit(req, 'BOTADMIN_AI_TRIGGER_CLEAR', { guildId: verified.guildId, count: guildOwned.length });
  res.json({ ok: true, cleared: guildOwned.length });
});

botAdminTriggersRouter.delete('/:id', async (req, res) => {
  const verified = await verifiedGuildId(req);
  if (!verified) { res.status(guildIdFrom(req) ? 404 : 400).json({ error: guildIdFrom(req) ? 'Bot ist auf dem ausgewählten Server nicht verfügbar.' : 'Gültige guildId erforderlich.' }); return; }
  const id = String(req.params.id ?? '');
  const existing = (await listTriggers(verified.guildId)).find(trigger => trigger.id === id);
  const result = await removeTrigger(verified.guildId, id, actor(req));
  if (!result.ok) { res.status(404).json({ error: result.message }); return; }
  if (existing?.mediaUrl) await deleteMediaIfLocal(existing.mediaUrl);
  audit(req, 'BOTADMIN_AI_TRIGGER_DELETE', { guildId: verified.guildId, triggerId: id });
  res.json({ ok: true });
});
