/**
 * Feeds-Routen — Live-Feeds (RSS, News, Twitch, Steam, YouTube, Webhook) pro Guild.
 * Dashboard-only: der frühere Slash-Command /feed wurde hierher migriert.
 *
 *   GET    /                    Feeds der Guild auflisten
 *   GET    /:id                 Einzelner Feed
 *   POST   /                    Feed anlegen
 *   PUT    /:id                 Feed aktualisieren
 *   DELETE /:id                 Feed löschen
 *   POST   /:id/toggle          Feed aktivieren/deaktivieren
 *   POST   /:id/test            Feed jetzt sofort prüfen
 *   POST   /:id/roles           Ping-Rolle hinzufügen
 *   DELETE /:id/roles/:roleId   Ping-Rolle entfernen
 *   GET    /:id/webhook         Webhook-URL + Secret (nur WEBHOOK-Typ)
 *   POST   /:id/webhook/rotate  Neues Webhook-Secret erzeugen
 *
 * Strikte guildId-Scope-Prüfung: jede Prisma-Query trägt guildId (+ Legacy null wird
 * NICHT vermischt — nur eigene Guild). SSRF-Schutz für RSS/NEWS/YOUTUBE-URLs.
 */

import { Router } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { isBlockedHost } from '../../../utils/ssrf';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { tryGetDashboardClient } from '../../clientRegistry';
import { createFeed, runFeedNow } from '../../../modules/feeds/feedManager';
import { generateWebhookSecret } from '../../../modules/feeds/webhookReceiver';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const feedsRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const FEED_TYPES = new Set(['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK']);

interface FeedRow {
  id: string;
  guildId: string | null;
  name: string;
  feedType: string;
  url: string;
  channelId: string;
  interval: number;
  lastChecked: Date | null;
  lastItemId: string | null;
  isActive: boolean;
  mentionRoles: string[];
  webhookSecret: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function feedToApi(f: FeedRow) {
  return {
    id: f.id,
    name: f.name,
    feedType: f.feedType,
    url: f.url,
    channelId: f.channelId,
    interval: f.interval,
    lastChecked: f.lastChecked,
    isActive: f.isActive,
    mentionRoles: f.mentionRoles ?? [],
    hasWebhookSecret: f.webhookSecret != null,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

// ── Validierung ───────────────────────────────────────────────────────────────
function validateFeedSource(typ: string, source: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, reason: 'URL/Quelle darf nicht leer sein.' };
  if (trimmed.length > 2048) return { ok: false, reason: 'URL/Quelle überschreitet 2048 Zeichen.' };

  switch (typ) {
    case 'RSS':
    case 'NEWS': {
      try {
        const u = new URL(trimmed);
        if (!['http:', 'https:'].includes(u.protocol)) {
          return { ok: false, reason: 'Nur http:// oder https:// URLs erlaubt.' };
        }
        if (isBlockedHost(u.hostname)) {
          return { ok: false, reason: 'Lokale/private Hosts sind nicht erlaubt (SSRF-Schutz).' };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'Ungültige URL.' };
      }
    }
    case 'YOUTUBE': {
      // Kanal-ID (UC…), Handle (@name) oder vollständige URL.
      if (/youtube\.com|youtu\.be/i.test(trimmed)) {
        try {
          const u = new URL(trimmed);
          if (!['http:', 'https:'].includes(u.protocol)) {
            return { ok: false, reason: 'Nur http:// oder https:// URLs erlaubt.' };
          }
          if (isBlockedHost(u.hostname)) {
            return { ok: false, reason: 'Lokale/private Hosts sind nicht erlaubt (SSRF-Schutz).' };
          }
          return { ok: true };
        } catch {
          return { ok: false, reason: 'Ungültige YouTube-URL.' };
        }
      }
      if (/^UC[\w-]{20,}$/.test(trimmed) || /^@?[\w.-]{1,100}$/.test(trimmed)) return { ok: true };
      return { ok: false, reason: 'YouTube: Kanal-ID (UC…), @Handle oder Kanal-URL angeben.' };
    }
    case 'WEBHOOK': {
      if (trimmed.length > 200) return { ok: false, reason: 'Label/Quelle max. 200 Zeichen.' };
      return { ok: true };
    }
    case 'TWITCH': {
      if (!/^[A-Za-z0-9_]{4,25}$/.test(trimmed)) {
        return { ok: false, reason: 'Twitch-Channelname muss 4-25 Zeichen aus [A-Za-z0-9_] sein.' };
      }
      return { ok: true };
    }
    case 'STEAM': {
      if (!/^\d{1,10}$/.test(trimmed)) {
        return { ok: false, reason: 'Steam-App-ID muss numerisch sein (z.B. 730).' };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'Unbekannter Feed-Typ.' };
  }
}

function parseInterval(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return 300;
  return Math.min(86400, Math.max(60, Math.trunc(n)));
}

function normalizeRoleIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && SNOWFLAKE_RE.test(x)))].slice(0, 20);
}

/** Lädt einen Feed strikt guild-scoped. */
async function findGuildFeed(guildId: string, id: string): Promise<FeedRow | null> {
  const feed = await prisma.feed.findFirst({ where: { id, guildId } });
  return feed as FeedRow | null;
}

async function ensureChannel(guildId: string, channelId: string): Promise<{ ok: boolean; reason?: string }> {
  const client = tryGetDashboardClient();
  if (!client) return { ok: true }; // Ohne Client: Persistenz erlauben, Prüfung beim Senden.
  const res = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return res.ok ? { ok: true } : { ok: false, reason: res.reason };
}

// ── Routen ────────────────────────────────────────────────────────────────────
feedsRouter.get('/', requireGuildPermission('feeds.view'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const feeds = await prisma.feed.findMany({
    where: { guildId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ feeds: (feeds as FeedRow[]).map(feedToApi) });
});

feedsRouter.get('/:id', requireGuildPermission('feeds.view'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const feed = await findGuildFeed(guildId, req.params.id);
  if (!feed) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }
  res.json(feedToApi(feed));
});

feedsRouter.post('/', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId, actorDiscordId } = req.guildScope!;
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const feedType = typeof body.feedType === 'string' ? body.feedType.trim().toUpperCase() : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  const interval = parseInterval(body.interval);

  if (!name) { res.status(400).json({ error: 'Name ist erforderlich.' }); return; }
  if (!FEED_TYPES.has(feedType)) { res.status(400).json({ error: 'Ungültiger Feed-Typ.' }); return; }
  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  const v = validateFeedSource(feedType, url);
  if (!v.ok) { res.status(400).json({ error: v.reason }); return; }
  const chk = await ensureChannel(guildId, channelId);
  if (!chk.ok) { res.status(400).json({ error: chk.reason ?? 'Ziel-Channel ungültig.' }); return; }

  const feedId = await createFeed(name, feedType, url, channelId, interval, actorDiscordId, guildId);

  const mentionRoles = normalizeRoleIds(body.mentionRoles);
  let webhookSecret: string | null = null;
  if (feedType === 'WEBHOOK') webhookSecret = generateWebhookSecret();
  if (mentionRoles.length || webhookSecret) {
    await prisma.feed.update({ where: { id: feedId }, data: { mentionRoles, webhookSecret: webhookSecret ?? undefined } });
  }

  const feed = await findGuildFeed(guildId, feedId);
  await logAuditDb('FEED_CREATED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId, name, feedType } });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId } });
  res.status(201).json(feedToApi(feed!));
});

feedsRouter.put('/:id', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }

  const body = req.body ?? {};
  const data: Record<string, unknown> = {};

  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 100);
  if (body.interval !== undefined) data.interval = parseInterval(body.interval);
  if (body.mentionRoles !== undefined) data.mentionRoles = normalizeRoleIds(body.mentionRoles);

  // Typ/URL dürfen geändert werden — dann erneut validieren.
  const newType = typeof body.feedType === 'string' ? body.feedType.trim().toUpperCase() : existing.feedType;
  if (body.feedType !== undefined && !FEED_TYPES.has(newType)) {
    res.status(400).json({ error: 'Ungültiger Feed-Typ.' }); return;
  }
  if (body.url !== undefined || body.feedType !== undefined) {
    const url = typeof body.url === 'string' ? body.url.trim() : existing.url;
    const v = validateFeedSource(newType, url);
    if (!v.ok) { res.status(400).json({ error: v.reason }); return; }
    data.feedType = newType;
    data.url = url;
    // Bei Typ-/Quellwechsel Duplikat-Marker zurücksetzen.
    data.lastItemId = null;
  }

  if (typeof body.channelId === 'string') {
    if (!SNOWFLAKE_RE.test(body.channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
    const chk = await ensureChannel(guildId, body.channelId);
    if (!chk.ok) { res.status(400).json({ error: chk.reason ?? 'Ziel-Channel ungültig.' }); return; }
    data.channelId = body.channelId;
  }

  await prisma.feed.update({ where: { id: existing.id }, data });
  const feed = await findGuildFeed(guildId, existing.id);
  await logAuditDb('FEED_UPDATED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id } });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: existing.id } });
  res.json(feedToApi(feed!));
});

feedsRouter.delete('/:id', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }

  await prisma.feed.delete({ where: { id: existing.id } });
  await logAuditDb('FEED_DELETED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id, name: existing.name } });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: existing.id } });
  res.json({ ok: true });
});

feedsRouter.post('/:id/toggle', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }

  const next = typeof req.body?.isActive === 'boolean' ? req.body.isActive : !existing.isActive;
  await prisma.feed.update({ where: { id: existing.id }, data: { isActive: next } });
  await logAuditDb('FEED_TOGGLED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id, isActive: next } });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: existing.id } });
  res.json({ ok: true, isActive: next });
});

feedsRouter.post('/:id/test', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }

  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot-Client nicht verfügbar.' }); return; }

  try {
    await runFeedNow(client, existing.id);
  } catch (e) {
    res.status(502).json({ error: `Feed-Prüfung fehlgeschlagen: ${String((e as Error)?.message ?? e).slice(0, 300)}` });
    return;
  }
  await logAuditDb('FEED_TESTED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id } });
  res.json({ ok: true });
});

feedsRouter.post('/:id/roles', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }

  const roleId = typeof req.body?.roleId === 'string' ? req.body.roleId.trim() : '';
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'Ungültige roleId.' }); return; }

  const roles = [...new Set([...(existing.mentionRoles ?? []), roleId])].slice(0, 20);
  await prisma.feed.update({ where: { id: existing.id }, data: { mentionRoles: roles } });
  await logAuditDb('FEED_ROLE_ADDED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id, roleId } });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: existing.id } });
  res.json({ ok: true, mentionRoles: roles });
});

feedsRouter.delete('/:id/roles/:roleId', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }

  const roles = (existing.mentionRoles ?? []).filter((r) => r !== req.params.roleId);
  await prisma.feed.update({ where: { id: existing.id }, data: { mentionRoles: roles } });
  await logAuditDb('FEED_ROLE_REMOVED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id, roleId: req.params.roleId } });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: existing.id } });
  res.json({ ok: true, mentionRoles: roles });
});

feedsRouter.get('/:id/webhook', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }
  if (existing.feedType !== 'WEBHOOK') { res.status(400).json({ error: 'Nur WEBHOOK-Feeds haben ein Secret.' }); return; }

  const base = (config.dashboard?.url || '').replace(/\/$/, '');
  const webhookUrl = base ? `${base}/webhooks/feed/${existing.id}` : `/webhooks/feed/${existing.id}`;
  res.json({ webhookUrl, secret: existing.webhookSecret, hmacHeader: 'X-Signature (HMAC-SHA256 über Roh-Body)' });
});

feedsRouter.post('/:id/webhook/rotate', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const existing = await findGuildFeed(guildId, req.params.id);
  if (!existing) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }
  if (existing.feedType !== 'WEBHOOK') { res.status(400).json({ error: 'Nur WEBHOOK-Feeds haben ein Secret.' }); return; }

  const secret = generateWebhookSecret();
  await prisma.feed.update({ where: { id: existing.id }, data: { webhookSecret: secret } });
  await logAuditDb('FEED_WEBHOOK_SECRET_ROTATED', 'FEED', { actorUserId: req.auth!.userId, guildId, details: { feedId: existing.id } });
  res.json({ ok: true, secret });
});
