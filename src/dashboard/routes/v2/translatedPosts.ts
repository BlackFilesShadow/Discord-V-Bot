/**
 * Übersetzungen-Routen — geplante / wiederkehrende Auto-Übersetzungs-Posts pro Guild.
 * Dashboard-only: der frühere Slash-Command /translate-post wurde hierher migriert.
 *
 * Das eigentliche Senden übernimmt der bestehende translatedPostScheduler
 * (Polling alle 30s, `nextRunAt <= now`). Diese Routen verwalten nur die
 * Datensätze — `mode='now'` setzt `nextRunAt=now`, der Scheduler sendet zeitnah.
 *
 *   GET    /                Posts der Guild auflisten
 *   GET    /:id             Einzelner Post
 *   POST   /                Post anlegen (now | once | recurring)
 *   PUT    /:id             Post aktualisieren
 *   DELETE /:id             Post löschen
 *   POST   /:id/toggle      Post aktivieren/deaktivieren
 *   GET    /meta/languages  Unterstützte Sprachen (für die UI)
 *
 * Strikte guildId-Scope-Prüfung: jede Prisma-Query trägt guildId.
 */

import { Router } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { isBlockedHost } from '../../../utils/ssrf';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { tryGetDashboardClient } from '../../clientRegistry';
import { SUPPORTED_LANGUAGES, LANGUAGE_CODES } from '../../../modules/ai/translator';
import { parseRecurrence, nextRunFromRecurrence } from '../../../modules/ai/translatedPostScheduler';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const translatedPostsRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const MODES = new Set(['now', 'once', 'recurring']);

interface PostRow {
  id: string;
  guildId: string;
  channelId: string;
  createdBy: string;
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  translatedText: string | null;
  customTitle: string | null;
  imageUrl: string | null;
  rolePings: string | null;
  mode: string;
  scheduledFor: Date | null;
  recurrenceCron: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function postToApi(p: PostRow) {
  return {
    id: p.id,
    channelId: p.channelId,
    createdBy: p.createdBy,
    sourceText: p.sourceText,
    sourceLang: p.sourceLang,
    targetLang: p.targetLang,
    customTitle: p.customTitle,
    imageUrl: p.imageUrl,
    rolePings: (p.rolePings ?? '').split(',').filter(Boolean),
    mode: p.mode,
    scheduledFor: p.scheduledFor,
    recurrenceCron: p.recurrenceCron,
    nextRunAt: p.nextRunAt,
    lastRunAt: p.lastRunAt,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ── Body-Parsing / Validierung ─────────────────────────────────────────────────
function normalizeRolePings(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && SNOWFLAKE_RE.test(x)))].slice(0, 3);
  return ids.length ? ids.join(',') : null;
}

function validImageUrl(v: unknown): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, reason: 'Bild-URL ungültig.' };
  try {
    const u = new URL(v.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: 'Bild-URL muss http(s) sein.' };
    if (isBlockedHost(u.hostname)) return { ok: false, reason: 'Bild-URL: lokale/private Hosts nicht erlaubt.' };
    return { ok: true, value: u.toString() };
  } catch {
    return { ok: false, reason: 'Bild-URL ungültig.' };
  }
}

interface ScheduleResult {
  ok: true;
  scheduledFor: Date | null;
  recurrenceCron: string | null;
  nextRunAt: Date;
}
function computeSchedule(mode: string, body: Record<string, unknown>): ScheduleResult | { ok: false; reason: string } {
  if (mode === 'now') {
    return { ok: true, scheduledFor: null, recurrenceCron: null, nextRunAt: new Date() };
  }
  if (mode === 'once') {
    const raw = typeof body.scheduledAt === 'string' ? body.scheduledAt : '';
    const date = raw ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) return { ok: false, reason: 'Ungültiger Zeitpunkt (scheduledAt).' };
    if (date.getTime() < Date.now() - 60_000) return { ok: false, reason: 'Zeitpunkt liegt in der Vergangenheit.' };
    return { ok: true, scheduledFor: date, recurrenceCron: null, nextRunAt: date };
  }
  // recurring
  const cron = typeof body.recurrence === 'string' ? body.recurrence.trim().toUpperCase() : '';
  if (!parseRecurrence(cron)) {
    return { ok: false, reason: 'Ungültige Wiederholung. Format: HOURLY:MM | DAILY:HH:MM | WEEKLY:DAY:HH:MM | MONTHLY:DD:HH:MM.' };
  }
  const next = nextRunFromRecurrence(cron);
  if (!next) return { ok: false, reason: 'Nächster Ausführungszeitpunkt nicht berechenbar.' };
  return { ok: true, scheduledFor: null, recurrenceCron: cron, nextRunAt: next };
}

async function findGuildPost(guildId: string, id: string): Promise<PostRow | null> {
  const post = await prisma.translatedPost.findFirst({ where: { id, guildId } });
  return post as PostRow | null;
}

async function ensureChannel(guildId: string, channelId: string): Promise<{ ok: boolean; reason?: string }> {
  const client = tryGetDashboardClient();
  if (!client) return { ok: true };
  const res = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}

// ── Routen ────────────────────────────────────────────────────────────────────
translatedPostsRouter.get('/meta/languages', requireGuildPermission('translate.view'), (_req, res) => {
  res.json({ languages: SUPPORTED_LANGUAGES });
});

translatedPostsRouter.get('/', requireGuildPermission('translate.view'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const posts = await prisma.translatedPost.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } });
  res.json({ posts: (posts as PostRow[]).map(postToApi) });
});

translatedPostsRouter.get('/:id', requireGuildPermission('translate.view'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const post = await findGuildPost(guildId, req.params.id);
  if (!post) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; }
  res.json(postToApi(post));
});

translatedPostsRouter.post('/', requireGuildPermission('translate.manage'), async (req, res) => {
  const { guildId, actorDiscordId } = req.guildScope!;
  const body = req.body ?? {};

  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  const sourceText = typeof body.sourceText === 'string' ? body.sourceText.trim() : '';
  const targetLang = typeof body.targetLang === 'string' ? body.targetLang.trim() : '';
  const sourceLang = typeof body.sourceLang === 'string' && body.sourceLang.trim() ? body.sourceLang.trim() : 'auto';
  const customTitle = typeof body.customTitle === 'string' ? body.customTitle.trim().slice(0, 200) : '';
  const mode = typeof body.mode === 'string' ? body.mode.trim() : '';

  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  if (!sourceText) { res.status(400).json({ error: 'Text ist erforderlich.' }); return; }
  if (sourceText.length > 4000) { res.status(400).json({ error: 'Text max. 4000 Zeichen.' }); return; }
  if (!LANGUAGE_CODES.includes(targetLang)) { res.status(400).json({ error: 'Ungültige Zielsprache.' }); return; }
  if (sourceLang !== 'auto' && !LANGUAGE_CODES.includes(sourceLang)) { res.status(400).json({ error: 'Ungültige Quellsprache.' }); return; }
  if (!customTitle) { res.status(400).json({ error: 'Titel ist erforderlich.' }); return; }
  if (!MODES.has(mode)) { res.status(400).json({ error: 'Ungültiger Modus.' }); return; }

  const img = validImageUrl(body.imageUrl);
  if (!img.ok) { res.status(400).json({ error: img.reason }); return; }
  const sched = computeSchedule(mode, body);
  if (!sched.ok) { res.status(400).json({ error: sched.reason }); return; }
  const chk = await ensureChannel(guildId, channelId);
  if (!chk.ok) { res.status(400).json({ error: chk.reason ?? 'Ziel-Channel ungültig.' }); return; }

  const post = await prisma.translatedPost.create({
    data: {
      guildId,
      channelId,
      createdBy: actorDiscordId,
      sourceText,
      sourceLang,
      targetLang,
      customTitle,
      imageUrl: img.value,
      rolePings: normalizeRolePings(body.rolePings),
      mode,
      scheduledFor: sched.scheduledFor,
      recurrenceCron: sched.recurrenceCron,
      nextRunAt: sched.nextRunAt,
      isActive: true,
    },
  });

  await logAuditDb('TRANSLATED_POST_CREATED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: post.id, mode, targetLang } });
  emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: post.id } });
  res.status(201).json(postToApi(post as PostRow));
});

translatedPostsRouter.put('/:id', requireGuildPermission('translate.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildPost(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; }

  const body = req.body ?? {};
  const data: Record<string, unknown> = {};

  if (typeof body.channelId === 'string') {
    if (!SNOWFLAKE_RE.test(body.channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
    const chk = await ensureChannel(guildId, body.channelId);
    if (!chk.ok) { res.status(400).json({ error: chk.reason ?? 'Ziel-Channel ungültig.' }); return; }
    data.channelId = body.channelId;
  }
  if (typeof body.sourceText === 'string') {
    const t = body.sourceText.trim();
    if (!t) { res.status(400).json({ error: 'Text darf nicht leer sein.' }); return; }
    if (t.length > 4000) { res.status(400).json({ error: 'Text max. 4000 Zeichen.' }); return; }
    data.sourceText = t;
    data.translatedText = null; // Neu übersetzen beim nächsten Versand.
  }
  if (typeof body.targetLang === 'string') {
    if (!LANGUAGE_CODES.includes(body.targetLang)) { res.status(400).json({ error: 'Ungültige Zielsprache.' }); return; }
    data.targetLang = body.targetLang;
    data.translatedText = null;
  }
  if (typeof body.sourceLang === 'string') {
    const sl = body.sourceLang.trim() || 'auto';
    if (sl !== 'auto' && !LANGUAGE_CODES.includes(sl)) { res.status(400).json({ error: 'Ungültige Quellsprache.' }); return; }
    data.sourceLang = sl;
    data.translatedText = null;
  }
  if (typeof body.customTitle === 'string') {
    const ct = body.customTitle.trim().slice(0, 200);
    if (!ct) { res.status(400).json({ error: 'Titel darf nicht leer sein.' }); return; }
    data.customTitle = ct;
  }
  if (body.imageUrl !== undefined) {
    const img = validImageUrl(body.imageUrl);
    if (!img.ok) { res.status(400).json({ error: img.reason }); return; }
    data.imageUrl = img.value;
  }
  if (body.rolePings !== undefined) data.rolePings = normalizeRolePings(body.rolePings);

  // Zeitplan darf geändert werden (Modus beibehalten).
  if (body.mode !== undefined || body.scheduledAt !== undefined || body.recurrence !== undefined) {
    const mode = typeof body.mode === 'string' && MODES.has(body.mode) ? body.mode : existing.mode;
    const sched = computeSchedule(mode, body);
    if (!sched.ok) { res.status(400).json({ error: sched.reason }); return; }
    data.mode = mode;
    data.scheduledFor = sched.scheduledFor;
    data.recurrenceCron = sched.recurrenceCron;
    data.nextRunAt = sched.nextRunAt;
  }

  await prisma.translatedPost.update({ where: { id: existing.id }, data });
  const post = await findGuildPost(guildId, existing.id);
  await logAuditDb('TRANSLATED_POST_UPDATED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: existing.id } });
  emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: existing.id } });
  res.json(postToApi(post!));
});

translatedPostsRouter.delete('/:id', requireGuildPermission('translate.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildPost(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; }

  await prisma.translatedPost.delete({ where: { id: existing.id } });
  await logAuditDb('TRANSLATED_POST_DELETED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: existing.id } });
  emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: existing.id } });
  res.json({ ok: true });
});

translatedPostsRouter.post('/:id/toggle', requireGuildPermission('translate.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildPost(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Post nicht gefunden.' }); return; }

  const next = typeof req.body?.isActive === 'boolean' ? req.body.isActive : !existing.isActive;
  const data: Record<string, unknown> = { isActive: next };
  // Beim Reaktivieren eines wiederkehrenden Posts nächsten Lauf neu berechnen.
  if (next && existing.mode === 'recurring' && existing.recurrenceCron) {
    data.nextRunAt = nextRunFromRecurrence(existing.recurrenceCron) ?? new Date();
  }
  await prisma.translatedPost.update({ where: { id: existing.id }, data });
  await logAuditDb('TRANSLATED_POST_TOGGLED', 'TRANSLATE', { actorUserId: req.auth!.userId, guildId, details: { postId: existing.id, isActive: next } });
  emitGuildEvent(guildId, { type: 'translatedPost.changed', payload: { guildId, postId: existing.id } });
  res.json({ ok: true, isActive: next });
});
