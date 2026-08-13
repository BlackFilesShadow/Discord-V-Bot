import { Client, EmbedBuilder, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { translate } from '../ai/translator';
import { extractSteamAppId, extractTwitchLogin } from './urlResolver';
import { getTwitchCreds, getYouTubeKey } from './feedCredentials';
import { entriesAfterMarker, fetchFeedDocument, type FeedEntry } from './feedDocument';
import { getSteamNews, getTwitchStream, getYouTubeEntries } from './platformClients';

export async function createFeed(
  name: string,
  feedType: string,
  url: string,
  channelId: string,
  interval: number,
  createdBy: string,
  guildId: string,
  filters?: Record<string, unknown>,
): Promise<string> {
  const feed = await prisma.feed.create({
    data: { name, feedType: feedType as any, url, channelId, guildId, interval, createdBy, filters: filters as any },
  });
  logAudit('FEED_CREATED', 'FEED', { feedId: feed.id, name, feedType, channelId, createdBy });
  return feed.id;
}

const feedBackoff = new Map<string, { count: number; until: number }>();
const processingFeeds = new Set<string>();

async function resolveMentionableRoles(guild: Guild, roleIds: string[], feedId: string): Promise<string[]> {
  const ids = (roleIds ?? []).filter((id) => /^\d{17,20}$/.test(id) && id !== guild.id);
  if (!ids.length) return [];
  const canMentionAny = guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone) ?? false;
  const out: string[] = [];
  for (const id of ids) {
    const role = guild.roles.cache.get(id) ?? await guild.roles.fetch(id).catch(() => null);
    if (!role) {
      logger.warn(`Feed ${feedId}: Ping-Rolle ${id} existiert nicht mehr.`);
      continue;
    }
    if (role.mentionable || canMentionAny) out.push(id);
    else logger.warn(`Feed ${feedId}: Rolle ${role.name} ist nicht erwaehnbar.`);
  }
  return out;
}

function validDate(value: string | null | undefined): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function setHttpUrl(embed: EmbedBuilder, value: string): void {
  if (/^https?:\/\//i.test(value)) embed.setURL(value);
}

async function translateNews(entry: FeedEntry): Promise<FeedEntry> {
  let title = entry.title;
  let description = entry.description;
  try {
    const translated = await translate(entry.title, 'de');
    if (translated) title = translated;
  } catch {
    // Originaltitel bleibt erhalten.
  }
  if (entry.description) {
    try {
      const translated = await translate(entry.description, 'de');
      if (translated) description = translated;
    } catch {
      // Originalbeschreibung bleibt erhalten.
    }
  }
  return { ...entry, title, description };
}

async function processFeedInner(client: Client, feedId: string): Promise<void> {
  const feed = await prisma.feed.findUnique({ where: { id: feedId } });
  if (!feed || !feed.isActive) return;

  const channel = await client.channels.fetch(feed.channelId).catch(() => null) as TextChannel | null;
  if (!channel || !channel.guild) throw new Error('Ziel-Channel ist nicht erreichbar.');

  const roleIds = await resolveMentionableRoles(channel.guild, feed.mentionRoles ?? [], feed.id);
  const pingPrefix = roleIds.map((id) => `<@&${id}>`).join(' ');
  const send = async (embed: EmbedBuilder): Promise<void> => {
    await channel.send({
      ...(pingPrefix ? { content: pingPrefix } : {}),
      embeds: [embed],
      allowedMentions: { roles: roleIds, parse: [] },
    });
  };

  if (feed.feedType === 'RSS' || feed.feedType === 'NEWS') {
    const document = await fetchFeedDocument(feed.url, feed.feedType === 'NEWS');
    const state = entriesAfterMarker(document.entries, feed.lastItemId, 'latest');
    const toPost = state.toPost.slice(-5);
    for (const raw of toPost) {
      const item = feed.feedType === 'NEWS' ? await translateNews(raw) : raw;
      const embed = new EmbedBuilder()
        .setTitle((item.title || 'Ohne Titel').slice(0, 256))
        .setDescription((item.description || 'Keine Beschreibung').slice(0, 4096))
        .setColor(feed.feedType === 'NEWS' ? 0xe67e22 : 0x3498db)
        .setFooter({ text: `📡 ${feed.name} · ${document.format}` })
        .setTimestamp(validDate(item.publishedAt));
      setHttpUrl(embed, item.link);
      if (item.image) embed.setImage(item.image);
      await send(embed);
    }
    await prisma.feed.update({ where: { id: feed.id }, data: { lastItemId: state.latestId, lastChecked: new Date() } });
    if (feed.lastItemId && !state.markerFound && toPost.length) {
      logger.warn(`Feed ${feed.id}: alter Marker lag nicht mehr im aktuellen Feed-Fenster; Backlog wurde begrenzt.`);
    }
    return;
  }

  if (feed.feedType === 'TWITCH') {
    const login = extractTwitchLogin(feed.url);
    if (!login) throw new Error('Gespeicherte Twitch-Quelle ist ungültig.');
    const stream = await getTwitchStream(login, getTwitchCreds(feed.credentialsEnc) ?? undefined);
    const marker = stream.isLive ? `stream:${stream.streamId || 'live'}` : 'OFFLINE';
    if (stream.isLive && feed.lastItemId !== marker) {
      const embed = new EmbedBuilder()
        .setTitle(`🔴 ${feed.name} ist LIVE!`)
        .setDescription((stream.title || 'Keine Beschreibung').slice(0, 4096))
        .setURL(`https://twitch.tv/${login}`)
        .setColor(0x9146ff)
        .addFields(
          { name: '🎮 Spiel', value: stream.gameName || 'Unbekannt', inline: true },
          { name: '👁️ Zuschauer', value: String(stream.viewerCount ?? 0), inline: true },
        )
        .setFooter({ text: `📡 ${feed.name}` })
        .setTimestamp(validDate(stream.startedAt));
      if (stream.thumbnailUrl) embed.setImage(stream.thumbnailUrl);
      await send(embed);
    }
    await prisma.feed.update({ where: { id: feed.id }, data: { lastItemId: marker, lastChecked: new Date() } });
    return;
  }

  if (feed.feedType === 'STEAM') {
    const appId = extractSteamAppId(feed.url);
    if (!appId) throw new Error('Gespeicherte Steam-Quelle ist ungültig.');
    const entries = await getSteamNews(appId);
    const state = entriesAfterMarker(entries, feed.lastItemId, 'latest');
    for (const item of state.toPost.slice(-5)) {
      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${item.title}`.slice(0, 256))
        .setDescription((item.description || 'Keine Beschreibung').slice(0, 4096))
        .setColor(0x1b2838)
        .setFooter({ text: `📡 ${feed.name}` })
        .setTimestamp(validDate(item.publishedAt));
      setHttpUrl(embed, item.link);
      if (item.image) embed.setImage(item.image);
      await send(embed);
    }
    await prisma.feed.update({ where: { id: feed.id }, data: { lastItemId: state.latestId, lastChecked: new Date() } });
    return;
  }

  if (feed.feedType === 'YOUTUBE') {
    const result = await getYouTubeEntries(feed.url, getYouTubeKey(feed.credentialsEnc) ?? undefined);
    const state = entriesAfterMarker(result.entries, feed.lastItemId, 'mark-only');
    for (const item of state.toPost.slice(-5)) {
      const embed = new EmbedBuilder()
        .setTitle(`▶️ Neues Video: ${item.title}`.slice(0, 256))
        .setColor(0xff0000)
        .setAuthor({ name: result.channelTitle })
        .setFooter({ text: `📡 ${feed.name}` })
        .setTimestamp(validDate(item.publishedAt));
      setHttpUrl(embed, item.link);
      if (item.image) embed.setImage(item.image);
      await send(embed);
    }
    await prisma.feed.update({ where: { id: feed.id }, data: { lastItemId: state.latestId, lastChecked: new Date() } });
    return;
  }

  if (feed.feedType === 'WEBHOOK' || feed.feedType === 'CUSTOM') {
    await prisma.feed.update({ where: { id: feed.id }, data: { lastChecked: new Date() } });
    return;
  }

  throw new Error(`Nicht unterstützter Feed-Typ: ${feed.feedType}`);
}

async function processFeed(client: Client, feedId: string, ignoreBackoff = false, propagateError = false): Promise<void> {
  const currentBackoff = feedBackoff.get(feedId);
  if (!ignoreBackoff && currentBackoff && currentBackoff.until > Date.now()) return;
  if (processingFeeds.has(feedId)) {
    if (propagateError) throw new Error('Feed wird bereits verarbeitet.');
    return;
  }
  processingFeeds.add(feedId);
  try {
    await processFeedInner(client, feedId);
    feedBackoff.delete(feedId);
  } catch (error) {
    const previous = feedBackoff.get(feedId)?.count ?? 0;
    const count = previous + 1;
    const delayMs = Math.min(60_000 * 2 ** Math.min(count - 1, 5), 30 * 60_000);
    feedBackoff.set(feedId, { count, until: Date.now() + delayMs });
    logger.error(`Feed-Verarbeitung fehlgeschlagen (${feedId}):`, error);
    if (propagateError) throw error;
  } finally {
    processingFeeds.delete(feedId);
  }
}

export async function runFeedNow(client: Client, feedId: string): Promise<void> {
  await processFeed(client, feedId, true, true);
}

export function startFeedScheduler(client: Client): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const intervals = new Map<string, number>();

  const start = (feed: { id: string; name: string; interval: number }): void => {
    const timer = setInterval(() => { void processFeed(client, feed.id); }, feed.interval * 1000);
    timers.set(feed.id, timer);
    intervals.set(feed.id, feed.interval);
    logger.info(`Feed-Timer gestartet: ${feed.name} (alle ${feed.interval}s)`);
  };

  const refresh = async (): Promise<void> => {
    const active = await prisma.feed.findMany({ where: { isActive: true }, select: { id: true, name: true, interval: true } });
    const activeIds = new Set(active.map((feed) => feed.id));
    for (const [id, timer] of timers) {
      if (!activeIds.has(id)) {
        clearInterval(timer);
        timers.delete(id);
        intervals.delete(id);
      }
    }
    for (const feed of active) {
      if (!timers.has(feed.id)) start(feed);
      else if (intervals.get(feed.id) !== feed.interval) {
        clearInterval(timers.get(feed.id)!);
        timers.delete(feed.id);
        start(feed);
      }
    }
  };

  void refresh().catch((error) => logger.error('Feed-Scheduler Init fehlgeschlagen:', error));
  setInterval(() => { void refresh().catch((error) => logger.error('Feed-Scheduler Refresh fehlgeschlagen:', error)); }, 60_000);
  logger.info('Feed-Scheduler gestartet.');
}
