import { PermissionFlagsBits } from 'discord.js';
import { tryGetDashboardClient } from '../clientRegistry';
import { resolveCredentialUpdate } from '../../modules/feeds/feedCredentials';
import { createFeed } from '../../modules/feeds/feedManager';
import { resolveFeedSource, type FeedPlatform } from '../../modules/feeds/urlResolver';
import { generateWebhookSecret } from '../../modules/feeds/webhookReceiver';
import { validateBotChannelAccess } from '../../utils/discordChannel';

export const FEED_TYPES = new Set<FeedPlatform>(['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK']);
export const FEED_SNOWFLAKE_RE = /^\d{17,20}$/;

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
