/**
 * Übersetzungen-Routen — geplante / wiederkehrende Auto-Übersetzungs-Posts pro Guild.
 * Bilder werden als persistente lokale Uploads gespeichert und beim Versand
 * als Discord-Attachment verwendet. Bereits persistierte Legacy-http(s)-URLs
 * bleiben lesbar; neue oder geänderte Remote-Bilder werden sicher eingelesen
 * und als lokales, validiertes Attachment materialisiert.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { PermissionFlagsBits } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { validatePublicHttpUrl } from '../../../utils/ssrf';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { tryGetDashboardClient } from '../../clientRegistry';
import { SUPPORTED_LANGUAGES, LANGUAGE_CODES } from '../../../modules/ai/translator';
import { parseRecurrence, nextRunFromRecurrence } from '../../../modules/ai/translatedPostScheduler';
import {
  MAX_TRANSLATED_POST_IMAGE_BYTES,
  removeTranslatedPostImage,
  saveTranslatedPostImage,
  saveTranslatedPostImageFromUrl,
  validateTranslatedPostImage,
} from '../../../modules/ai/translatedPostImage';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const translatedPostsRouter = Router({ mergeParams: true });
const SNOWFLAKE_RE = /^\d{17,20}$/;
const MODES = new Set(['now', 'once', 'recurring']);
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TRANSLATED_POST_IMAGE_BYTES, files: 1, fields: 30, parts: 32 } });

function receiveImage(req: Request, res: Response, next: NextFunction): void {
  imageUpload.single('image')(req, res, (err: unknown) => {
    if (err) {
      const maxMiB = MAX_TRANSLATED_POST_IMAGE_BYTES / 1024 / 1024;
      res.status(400).json({ error: err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? `Bild ist größer als ${maxMiB} MiB.` : 'Bild-Upload konnte nicht verarbeitet werden.' });
      return;
    }
    next();
  });
}

interface PostRow {
  id: string; guildId: string; channelId: string; createdBy: string; sourceText: string; sourceLang: string; targetLang: string;
  translatedText: string | null; customTitle: string | null; imageUrl: string | null; rolePings: string | null; mode: string;
  scheduledFor: Date | null; recurrenceCron: string | null; nextRunAt: Date | null; lastRunAt: Date | null; isActive: boolean;
  createdAt: Date; updatedAt: Date;
}

function postToApi(p: PostRow) {
  return { id: p.id, channelId: p.channelId, createdBy: p.createdBy, sourceText: p.sourceText, sourceLang: p.sourceLang, targetLang: p.targetLang,
    customTitle: p.customTitle, imageUrl: p.imageUrl, hasImage: Boolean(p.imageUrl), rolePings: (p.rolePings ?? '').split(',').filter(Boolean),
    mode: p.mode, scheduledFor: p.scheduledFor, recurrenceCron: p.recurrenceCron, nextRunAt: p.nextRunAt, lastRunAt: p.lastRunAt,
    isActive: p.isActive, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

function normalizeRolePings(v: unknown): string | null {
  let parsed = v;
  if (typeof v === 'string') { try { parsed = JSON.parse(v); } catch { parsed = v; } }
  if (!Array.isArray(parsed)) return null;
  const ids = [...new Set(parsed.filter((x): x is string => typeof x === 'string' && SNOWFLAKE_RE.test(x)))].slice(0, 3);
  return ids.length ? ids.join(',') : null;
}
function parseBoolean(v: unknown): boolean { return v === true || v === 'true' || v === '1' || v === 1; }

type ImageInput =
  | { ok: true; kind: 'none'; value: null }
  | { ok: true; kind: 'managed'; value: string }
  | { ok: true; kind: 'remote'; value: string }
  | { ok: false; reason: string };

function parseImageInput(v: unknown): ImageInput {
  if (v === undefined || v === null) return { ok: true, kind: 'none', value: null };
  if (typeof v !== 'string') return { ok: false, reason: 'Bild-URL ungültig.' };
  const raw = v.trim();
  if (!raw) return { ok: true, kind: 'none', value: null };
  if (raw.startsWith('upload:translated-posts/')) return { ok: true, kind: 'managed', value: raw };
  const validated = validatePublicHttpUrl(raw);
  if (!validated.ok) return { ok: false, reason: `Bild-URL: ${validated.reason}` };
  return { ok: true, kind: 'remote', value: validated.url.toString() };
}

interface ScheduleResult { ok: true; scheduledFor: Date | null; recurrenceCron: string | null; nextRunAt: Date; }
function computeSchedule(mode: string, body: Record<string, unknown>): ScheduleResult | { ok: false; reason: string } {
  if (mode === 'now') return { ok: true, scheduledFor: null, recurrenceCron: null, nextRunAt: new Date() };
  if (mode === 'once') {
    const raw = typeof body.scheduledAt === 'string' ? body.scheduledAt : '';
    const date = raw ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) return { ok: false, reason: 'Ungültiger Zeitpunkt (scheduledAt).' };
    if (date.getTime() < Date.now() - 60_000) return { ok: false, reason: 'Zeitpunkt liegt in der Vergangenheit.' };
    return { ok: true, scheduledFor: date, recurrenceCron: null, nextRunAt: date };
  }
  const cron = typeof body.recurrence === 'string' ? body.recurrence.trim().toUpperCase() : '';
  if (!parseRecurrence(cron)) return { ok: false, reason: 'Ungültige Wiederholung. Format: HOURLY:MM | DAILY:HH:MM | WEEKLY:DAY:HH:MM | MONTHLY:DD:HH:MM.' };
  const next = nextRunFromRecurrence(cron);
  if (!next) return { ok: false, reason: 'Nächster Ausführungszeitpunkt nicht berechenbar.' };
  return { ok: true, scheduledFor: null, recurrenceCron: cron, nextRunAt: next };
}
async function findGuildPost(guildId: string, id: string): Promise<PostRow | null> { return await prisma.translatedPost.findFirst({ where: { id, guildId } }) as PostRow | null; }
async function ensureChannel(guildId: string, channelId: string): Promise<{ ok: boolean; reason?: string }> {
  const client = tryGetDashboardClient(); if (!client) return { ok: true };
  const r = await validateBotChannelAccess(client, guildId, channelId, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}
function validateIncomingImage(file: Express.Multer.File | undefined): string | null { if (!file) return null; const r = validateTranslatedPostImage(file); return r.ok ? null : r.error; }

translatedPostsRouter.get('/meta/languages', requireGuildPermission('translate.view'), (_req, res) => res.json({ languages: SUPPORTED_LANGUAGES }));
translatedPostsRouter.get('/', requireGuildPermission('translate.view'), async (req, res) => { const { guildId } = req.guildScope!; const posts = await prisma.translatedPost.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } }); res.json({ posts: (posts as PostRow[]).map(postToApi) }); });
translatedPostsRouter.get('/:id', requireGuildPermission('translate.view'), async (req, res) => { const { guildId } = req.guildScope!; const post = await findGuildPost(guildId, req.params.id); if (!post) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; } res.json(postToApi(post)); });

translatedPostsRouter.post('/', requireGuildPermission('translate.manage'), receiveImage, async (req, res) => {
  const { guildId, actorDiscordId } = req.guildScope!; const body = (req.body ?? {}) as Record<string, unknown>;
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : ''; const sourceText = typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
  const targetLang = typeof body.targetLang === 'string' ? body.targetLang.trim() : ''; const sourceLang = typeof body.sourceLang === 'string' && body.sourceLang.trim() ? body.sourceLang.trim() : 'auto';
  const customTitle = typeof body.customTitle === 'string' ? body.customTitle.trim().slice(0, 200) : ''; const mode = typeof body.mode === 'string' ? body.mode.trim() : '';
  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  if (!sourceText || sourceText.length > 4000) { res.status(400).json({ error: !sourceText ? 'Text ist erforderlich.' : 'Text max. 4000 Zeichen.' }); return; }
  if (!LANGUAGE_CODES.includes(targetLang) || (sourceLang !== 'auto' && !LANGUAGE_CODES.includes(sourceLang))) { res.status(400).json({ error: 'Ungültige Sprache.' }); return; }
  if (!customTitle) { res.status(400).json({ error: 'Titel ist erforderlich.' }); return; } if (!MODES.has(mode)) { res.status(400).json({ error: 'Ungültiger Modus.' }); return; }
  const fileError = validateIncomingImage(req.file); if (fileError) { res.status(400).json({ error: fileError }); return; }
  const imageInput = parseImageInput(body.imageUrl); if (!imageInput.ok) { res.status(400).json({ error: imageInput.reason }); return; }
  if (!req.file && imageInput.kind === 'managed') { res.status(400).json({ error: 'Bestehende Upload-Referenzen dürfen nicht für neue Posts wiederverwendet werden. Bitte das Bild neu hochladen.' }); return; }
  const sched = computeSchedule(mode, body); if (!sched.ok) { res.status(400).json({ error: sched.reason }); return; }
  const channel = await ensureChannel(guildId, channelId); if (!channel.ok) { res.status(400).json({ error: channel.reason ?? 'Ziel-Channel ungültig.' }); return; }

  let imageRef: string | null = null;
  let createdImageRef: string | null = null;
  if (req.file) {
    imageRef = await saveTranslatedPostImage(guildId, req.file);
    createdImageRef = imageRef;
  } else if (imageInput.kind === 'remote') {
    try {
      imageRef = await saveTranslatedPostImageFromUrl(guildId, imageInput.value);
      createdImageRef = imageRef;
    } catch {
      res.status(400).json({ error: 'Remote-Bild konnte nicht sicher geladen und validiert werden.' });
      return;
    }
  }

  try {
    const post = await prisma.translatedPost.create({ data: { guildId, channelId, createdBy: actorDiscordId, sourceText, sourceLang, targetLang, customTitle, imageUrl: imageRef,
      rolePings: normalizeRolePings(body.rolePings), mode, scheduledFor: sched.scheduledFor, recurrenceCron: sched.recurrenceCron, nextRunAt: sched.nextRunAt, isActive: true } });
    logAuditDb('TRANSLATED_POST_CREATED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: post.id, mode, targetLang, hasImage: Boolean(imageRef) } });
    emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: post.id } }); res.status(201).json(postToApi(post as PostRow));
  } catch (error) { if (createdImageRef) await removeTranslatedPostImage(createdImageRef); throw error; }
});

translatedPostsRouter.put('/:id', requireGuildPermission('translate.manage'), receiveImage, async (req, res) => {
  const { guildId } = req.guildScope!; const existing = await findGuildPost(guildId, req.params.id); if (!existing) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>; const data: Record<string, unknown> = {};
  if (typeof body.channelId === 'string') { if (!SNOWFLAKE_RE.test(body.channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; } const chk = await ensureChannel(guildId, body.channelId); if (!chk.ok) { res.status(400).json({ error: chk.reason ?? 'Ziel-Channel ungültig.' }); return; } data.channelId = body.channelId; }
  if (typeof body.sourceText === 'string') { const t = body.sourceText.trim(); if (!t || t.length > 4000) { res.status(400).json({ error: !t ? 'Text darf nicht leer sein.' : 'Text max. 4000 Zeichen.' }); return; } data.sourceText = t; data.translatedText = null; }
  if (typeof body.targetLang === 'string') { if (!LANGUAGE_CODES.includes(body.targetLang)) { res.status(400).json({ error: 'Ungültige Zielsprache.' }); return; } data.targetLang = body.targetLang; data.translatedText = null; }
  if (typeof body.sourceLang === 'string') { const sl = body.sourceLang.trim() || 'auto'; if (sl !== 'auto' && !LANGUAGE_CODES.includes(sl)) { res.status(400).json({ error: 'Ungültige Quellsprache.' }); return; } data.sourceLang = sl; data.translatedText = null; }
  if (typeof body.customTitle === 'string') { const t = body.customTitle.trim().slice(0, 200); if (!t) { res.status(400).json({ error: 'Titel darf nicht leer sein.' }); return; } data.customTitle = t; }
  if (body.rolePings !== undefined) data.rolePings = normalizeRolePings(body.rolePings);
  if (body.mode !== undefined || body.scheduledAt !== undefined || body.recurrence !== undefined) { const mode = typeof body.mode === 'string' && MODES.has(body.mode) ? body.mode : existing.mode; const sched = computeSchedule(mode, body); if (!sched.ok) { res.status(400).json({ error: sched.reason }); return; } data.mode = mode; data.scheduledFor = sched.scheduledFor; data.recurrenceCron = sched.recurrenceCron; data.nextRunAt = sched.nextRunAt; }
  const fileError = validateIncomingImage(req.file); if (fileError) { res.status(400).json({ error: fileError }); return; }
  const removeImage = parseBoolean(body.removeImage);
  const imageInput = !req.file && body.imageUrl !== undefined ? parseImageInput(body.imageUrl) : null;
  if (imageInput && !imageInput.ok) { res.status(400).json({ error: imageInput.reason }); return; }
  if (imageInput?.ok && imageInput.kind === 'managed' && imageInput.value !== existing.imageUrl) {
    res.status(400).json({ error: 'Eine andere Upload-Referenz darf nicht übernommen werden. Bitte das Bild neu hochladen.' });
    return;
  }

  let replacementRef: string | null = null;
  let replacingImage = false;
  if (!req.file && !removeImage && imageInput?.ok && imageInput.kind === 'remote' && imageInput.value !== existing.imageUrl) {
    try {
      replacementRef = await saveTranslatedPostImageFromUrl(guildId, imageInput.value);
      data.imageUrl = replacementRef;
      replacingImage = true;
    } catch {
      res.status(400).json({ error: 'Remote-Bild konnte nicht sicher geladen und validiert werden.' });
      return;
    }
  }

  try {
    if (req.file) { replacementRef = await saveTranslatedPostImage(guildId, req.file); data.imageUrl = replacementRef; replacingImage = true; }
    else if (removeImage) { data.imageUrl = null; replacingImage = Boolean(existing.imageUrl); }
    else if (imageInput?.ok && imageInput.kind === 'none' && existing.imageUrl) { data.imageUrl = null; replacingImage = true; }
    await prisma.translatedPost.update({ where: { id: existing.id }, data });
    if (replacingImage && existing.imageUrl && existing.imageUrl !== data.imageUrl) await removeTranslatedPostImage(existing.imageUrl);
    const post = await findGuildPost(guildId, existing.id); logAuditDb('TRANSLATED_POST_UPDATED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: existing.id, imageChanged: replacingImage } });
    emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: existing.id } }); res.json(postToApi(post!));
  } catch (error) { if (replacementRef) await removeTranslatedPostImage(replacementRef); throw error; }
});

translatedPostsRouter.delete('/:id', requireGuildPermission('translate.manage'), async (req, res) => { const { guildId } = req.guildScope!; const existing = await findGuildPost(guildId, req.params.id); if (!existing) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; } await prisma.translatedPost.delete({ where: { id: existing.id } }); if (existing.imageUrl) await removeTranslatedPostImage(existing.imageUrl); logAuditDb('TRANSLATED_POST_DELETED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: existing.id } }); emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: existing.id } }); res.json({ ok: true }); });
translatedPostsRouter.post('/:id/toggle', requireGuildPermission('translate.manage'), async (req, res) => { const { guildId } = req.guildScope!; const existing = await findGuildPost(guildId, req.params.id); if (!existing) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; } const next = typeof req.body?.isActive === 'boolean' ? req.body.isActive : !existing.isActive; const data: Record<string, unknown> = { isActive: next }; if (next && existing.mode === 'recurring' && existing.recurrenceCron) data.nextRunAt = nextRunFromRecurrence(existing.recurrenceCron) ?? new Date(); await prisma.translatedPost.update({ where: { id: existing.id }, data }); logAuditDb('TRANSLATED_POST_TOGGLED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: existing.id, isActive: next } }); emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: existing.id } }); res.json({ ok: true, isActive: next }); });
