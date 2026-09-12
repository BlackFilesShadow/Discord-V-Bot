import type { Feed, Prisma } from '@prisma/client';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../../config';
import prisma from '../../database/prisma';
import { resolveCredentialUpdate } from '../../modules/feeds/feedCredentials';
import { createFeed, runFeedNow } from '../../modules/feeds/feedManager';
import { resolveFeedSource, type FeedPlatform } from '../../modules/feeds/urlResolver';
import { generateWebhookSecret } from '../../modules/feeds/webhookReceiver';
import { validateBotChannelAccess } from '../../utils/discordChannel';
import { tryGetDashboardClient } from '../clientRegistry';

export const FEED_TYPES = new Set<FeedPlatform>(['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK']);
export const FEED_SNOWFLAKE_RE = /^\d{17,20}$/;
export const STABLE_FEED_CREATED_DESC = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

export function isSupportedFeedType(value: string): value is FeedPlatform {
  return FEED_TYPES.has(value as FeedPlatform);
}

export function parseFeedInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 300;
  return Math.min(86400, Math.max(60, Math.trunc(parsed)));
}

export function normalizeFeedRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && FEED_SNOWFLAKE_RE.test(item)))].slice(0, 20);
}

export async function ensureFeedChannel(guildId: string, channelId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = tryGetDashboardClient();
  if (!client) return { ok: true };
  return validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
}

export function feedToApi(feed: Feed) {
  return {
    id: feed.id,
    name: feed.name,
    feedType: feed.feedType,
    url: feed.url,
    channelId: feed.channelId,
    interval: feed.interval,
    lastChecked: feed.lastChecked,
    isActive: feed.isActive,
    mentionRoles: feed.mentionRoles ?? [],
    hasWebhookSecret: feed.webhookSecret != null,
    hasCredentials: feed.credentialsEnc != null,
    createdBy: feed.createdBy,
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt,
  };
}

export async function listCanonicalFeeds(guildId: string): Promise<Feed[]> {
  return prisma.feed.findMany({ where: { guildId }, orderBy: STABLE_FEED_CREATED_DESC });
}

export async function findCanonicalFeed(guildId: string, id: string): Promise<Feed | null> {
  return prisma.feed.findFirst({ where: { id, guildId } });
}

type FeedControlFailureCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'UNAVAILABLE' | 'UPSTREAM';
export type FeedControlFailure = { ok: false; code: FeedControlFailureCode; error: string };

export function feedControlHttpStatus(code: FeedControlFailureCode): number {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT') return 409;
  if (code === 'UNAVAILABLE') return 503;
  if (code === 'UPSTREAM') return 502;
  return 400;
}

export type CanonicalFeedCreateResult =
  | {
      ok: true;
      feedId: string;
      name: string;
      feedType: FeedPlatform;
      sourceId: string;
      url: string;
      channelId: string;
      interval: number;
      mentionRoles: string[];
      credentialsSet: boolean;
      hasWebhookSecret: boolean;
    }
  | { ok: false; error: string };

export async function createCanonicalFeed(input: {
  guildId: string;
  createdBy: string;
  body: Record<string, unknown>;
}): Promise<CanonicalFeedCreateResult> {
  const { guildId, createdBy, body } = input;
  let name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const rawType = typeof body.feedType === 'string' ? body.feedType.trim().toUpperCase() : '';
  if (!isSupportedFeedType(rawType)) return { ok: false, error: 'Ungültiger Feed-Typ.' };
  const feedType = rawType;

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  if (!FEED_SNOWFLAKE_RE.test(channelId)) return { ok: false, error: 'Ungültige channelId.' };

  const resolved = resolveFeedSource(feedType, url);
  if (!resolved.ok) return { ok: false, error: resolved.reason };
  if (!name) name = resolved.resolved.display.slice(0, 100);
  if (!name) return { ok: false, error: 'Name ist erforderlich.' };

  const channel = await ensureFeedChannel(guildId, channelId);
  if (!channel.ok) return { ok: false, error: channel.reason || 'Ziel-Channel ungültig.' };

  const credentials = resolveCredentialUpdate(feedType, body);
  if (!credentials.ok) return { ok: false, error: credentials.error };
  const credentialsEnc = credentials.change ? credentials.value : null;
  const mentionRoles = normalizeFeedRoleIds(body.mentionRoles);
  const webhookSecret = feedType === 'WEBHOOK' ? generateWebhookSecret() : null;
  const interval = parseFeedInterval(body.interval);

  const feedId = await createFeed(
    name,
    feedType,
    resolved.resolved.url,
    channelId,
    interval,
    createdBy,
    guildId,
    undefined,
    { mentionRoles, webhookSecret, credentialsEnc },
  );

  return {
    ok: true,
    feedId,
    name,
    feedType,
    sourceId: resolved.resolved.sourceId,
    url: resolved.resolved.url,
    channelId,
    interval,
    mentionRoles,
    credentialsSet: credentialsEnc != null,
    hasWebhookSecret: webhookSecret != null,
  };
}

export type CanonicalFeedUpdateResult =
  | { ok: true; feed: Feed; credentialsChanged: boolean }
  | FeedControlFailure;

export async function updateCanonicalFeed(input: {
  guildId: string;
  id: string;
  body: Record<string, unknown>;
}): Promise<CanonicalFeedUpdateResult> {
  const { guildId, id, body } = input;
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };

  const data: Prisma.FeedUpdateManyMutationInput = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 100);
  if (body.interval !== undefined) data.interval = parseFeedInterval(body.interval);
  if (body.mentionRoles !== undefined) data.mentionRoles = normalizeFeedRoleIds(body.mentionRoles);

  const requestedType = typeof body.feedType === 'string' ? body.feedType.trim().toUpperCase() : existing.feedType;
  if (body.feedType !== undefined && !isSupportedFeedType(requestedType)) {
    return { ok: false, code: 'VALIDATION', error: 'Ungültiger Feed-Typ.' };
  }

  if (body.url !== undefined || body.feedType !== undefined) {
    if (!isSupportedFeedType(requestedType)) {
      return { ok: false, code: 'VALIDATION', error: `Legacy-Feed-Typ ${requestedType} kann nicht bearbeitet werden. Bitte neu als unterstützten Feed anlegen.` };
    }
    const url = typeof body.url === 'string' ? body.url.trim() : existing.url;
    const resolved = resolveFeedSource(requestedType, url);
    if (!resolved.ok) return { ok: false, code: 'VALIDATION', error: resolved.reason };
    data.feedType = requestedType;
    data.url = resolved.resolved.url;
    data.lastItemId = null;
    if (requestedType !== existing.feedType) data.credentialsEnc = null;
  }

  const credentials = resolveCredentialUpdate(requestedType, body);
  if (!credentials.ok) return { ok: false, code: 'VALIDATION', error: credentials.error };
  if (credentials.change) data.credentialsEnc = credentials.value;

  if (typeof body.channelId === 'string') {
    const channelId = body.channelId.trim();
    if (!FEED_SNOWFLAKE_RE.test(channelId)) return { ok: false, code: 'VALIDATION', error: 'Ungültige channelId.' };
    const channel = await ensureFeedChannel(guildId, channelId);
    if (!channel.ok) return { ok: false, code: 'VALIDATION', error: channel.reason || 'Ziel-Channel ungültig.' };
    data.channelId = channelId;
  }

  const updated = await prisma.feed.updateMany({ where: { id: existing.id, guildId }, data });
  if (updated.count !== 1) {
    return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich geändert oder ist nicht mehr verfügbar.' };
  }
  const feed = await findCanonicalFeed(guildId, existing.id);
  if (!feed) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich entfernt.' };
  return { ok: true, feed, credentialsChanged: credentials.change };
}

export type CanonicalFeedToggleResult =
  | { ok: true; feed: Feed; isActive: boolean }
  | FeedControlFailure;

export async function toggleCanonicalFeed(input: {
  guildId: string;
  id: string;
  isActive?: boolean;
}): Promise<CanonicalFeedToggleResult> {
  const existing = await findCanonicalFeed(input.guildId, input.id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  const nextActive = typeof input.isActive === 'boolean' ? input.isActive : !existing.isActive;
  if (nextActive && !isSupportedFeedType(existing.feedType)) {
    return { ok: false, code: 'CONFLICT', error: `Legacy-Feed-Typ ${existing.feedType} wird nicht mehr unterstützt. Bitte neu als unterstützten Feed anlegen.` };
  }
  const updated = await prisma.feed.updateMany({ where: { id: existing.id, guildId: input.guildId }, data: { isActive: nextActive } });
  if (updated.count !== 1) {
    return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich geändert oder ist nicht mehr verfügbar.' };
  }
  const feed = await findCanonicalFeed(input.guildId, existing.id);
  if (!feed) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich entfernt.' };
  return { ok: true, feed, isActive: nextActive };
}

export type CanonicalFeedDeleteResult =
  | { ok: true; feed: Feed }
  | FeedControlFailure;

export async function deleteCanonicalFeed(guildId: string, id: string): Promise<CanonicalFeedDeleteResult> {
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  const deleted = await prisma.feed.deleteMany({ where: { id: existing.id, guildId } });
  if (deleted.count !== 1) {
    return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich geändert oder ist nicht mehr verfügbar.' };
  }
  return { ok: true, feed: existing };
}

export type CanonicalFeedTestResult =
  | { ok: true; feed: Feed }
  | FeedControlFailure;

export async function testCanonicalFeed(guildId: string, id: string): Promise<CanonicalFeedTestResult> {
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  const client = tryGetDashboardClient();
  if (!client) return { ok: false, code: 'UNAVAILABLE', error: 'Bot-Client nicht verfügbar.' };
  try {
    await runFeedNow(client, existing.id);
  } catch (error) {
    return { ok: false, code: 'UPSTREAM', error: `Feed-Prüfung fehlgeschlagen: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
  return { ok: true, feed: existing };
}

export type CanonicalFeedRolesResult =
  | { ok: true; feed: Feed; mentionRoles: string[] }
  | FeedControlFailure;

export async function addCanonicalFeedRole(guildId: string, id: string, roleId: string): Promise<CanonicalFeedRolesResult> {
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  if (!FEED_SNOWFLAKE_RE.test(roleId)) return { ok: false, code: 'VALIDATION', error: 'Ungültige roleId.' };
  const mentionRoles = [...new Set([...(existing.mentionRoles ?? []), roleId])].slice(0, 20);
  const updated = await prisma.feed.updateMany({ where: { id: existing.id, guildId }, data: { mentionRoles } });
  if (updated.count !== 1) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich geändert oder ist nicht mehr verfügbar.' };
  const feed = await findCanonicalFeed(guildId, existing.id);
  if (!feed) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich entfernt.' };
  return { ok: true, feed, mentionRoles };
}

export async function removeCanonicalFeedRole(guildId: string, id: string, roleId: string): Promise<CanonicalFeedRolesResult> {
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  const mentionRoles = (existing.mentionRoles ?? []).filter((item) => item !== roleId);
  const updated = await prisma.feed.updateMany({ where: { id: existing.id, guildId }, data: { mentionRoles } });
  if (updated.count !== 1) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich geändert oder ist nicht mehr verfügbar.' };
  const feed = await findCanonicalFeed(guildId, existing.id);
  if (!feed) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich entfernt.' };
  return { ok: true, feed, mentionRoles };
}

export type CanonicalFeedWebhookResult =
  | { ok: true; feed: Feed; webhookUrl: string; secret: string | null; hmacHeader: string }
  | FeedControlFailure;

export async function getCanonicalFeedWebhook(guildId: string, id: string): Promise<CanonicalFeedWebhookResult> {
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  if (existing.feedType !== 'WEBHOOK') return { ok: false, code: 'VALIDATION', error: 'Nur WEBHOOK-Feeds haben ein Secret.' };
  const base = (config.dashboard?.url || '').replace(/\/$/, '');
  const webhookUrl = base ? `${base}/webhooks/feed/${existing.id}` : `/webhooks/feed/${existing.id}`;
  return { ok: true, feed: existing, webhookUrl, secret: existing.webhookSecret, hmacHeader: 'X-Signature (HMAC-SHA256 über Roh-Body)' };
}

export type CanonicalFeedWebhookRotateResult =
  | { ok: true; feed: Feed; secret: string }
  | FeedControlFailure;

export async function rotateCanonicalFeedWebhook(guildId: string, id: string): Promise<CanonicalFeedWebhookRotateResult> {
  const existing = await findCanonicalFeed(guildId, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', error: 'Feed nicht gefunden.' };
  if (existing.feedType !== 'WEBHOOK') return { ok: false, code: 'VALIDATION', error: 'Nur WEBHOOK-Feeds haben ein Secret.' };
  const secret = generateWebhookSecret();
  const updated = await prisma.feed.updateMany({ where: { id: existing.id, guildId }, data: { webhookSecret: secret } });
  if (updated.count !== 1) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich geändert oder ist nicht mehr verfügbar.' };
  const feed = await findCanonicalFeed(guildId, existing.id);
  if (!feed) return { ok: false, code: 'CONFLICT', error: 'Feed wurde zwischenzeitlich entfernt.' };
  return { ok: true, feed, secret };
}
