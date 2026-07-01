import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { translate } from '../ai/translator';
import axios from 'axios';

/**
 * Feed-Manager Modul (Sektion 7):
 * - Anbindung an externe Dienste (Twitch, Twitter, Steam, Wetter, News)
 * - Live-Feeds, Alerts und Community-Features
 * - RSS, Echtzeit-Feeds, Filter, Benachrichtigungen
 */

/**
 * Erstellt einen neuen Feed.
 */
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
    data: {
      name,
      feedType: feedType as any,
      url,
      channelId,
      guildId,
      interval,
      createdBy,
      filters: filters as any,
    },
  });

  logAudit('FEED_CREATED', 'FEED', {
    feedId: feed.id, name, feedType, channelId, createdBy,
  });

  return feed.id;
}

/**
 * RSS Feed abrufen und parsen.
 */
async function fetchRssFeed(url: string, lastItemId: string | null): Promise<{
  items: { title: string; link: string; description: string; pubDate: string; id: string }[];
  latestId: string | null;
}> {
  try {
    const response = await axios.get(url, { timeout: 10000, responseType: 'text' });
    const { XMLParser } = await import('fast-xml-parser');
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(response.data);

    const channel = parsed?.rss?.channel || parsed?.feed;
    if (!channel) return { items: [], latestId: null };

    const rawItems = channel.item || channel.entry || [];
    const itemsArray = Array.isArray(rawItems) ? rawItems : [rawItems];

    const items = itemsArray.map((item: any) => ({
      title: item.title || 'Ohne Titel',
      link: item.link?.['@_href'] || item.link || '',
      description: (item.description || item.summary || '').substring(0, 200),
      pubDate: item.pubDate || item.published || item.updated || '',
      id: item.guid || item.id || item.link || item.title,
    }));

    // Nur neue Items nach lastItemId
    if (lastItemId) {
      const lastIdx = items.findIndex((i: any) => i.id === lastItemId);
      if (lastIdx > 0) {
        return { items: items.slice(0, lastIdx), latestId: items[0]?.id || null };
      } else if (lastIdx === 0) {
        return { items: [], latestId: lastItemId };
      }
    }

    return { items: items.slice(0, 5), latestId: items[0]?.id || null };
  } catch (error) {
    logger.error(`RSS-Feed Fehler für ${url}:`, error);
    return { items: [], latestId: null };
  }
}

/**
 * Twitch Stream-Status prüfen.
 */
async function checkTwitchStream(channelName: string): Promise<{
  isLive: boolean;
  title?: string;
  gameName?: string;
  viewerCount?: number;
  thumbnailUrl?: string;
} | null> {
  if (!config.external.twitchClientId || !config.external.twitchClientSecret) {
    return null;
  }

  try {
    // Token holen
    const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: config.external.twitchClientId,
        client_secret: config.external.twitchClientSecret,
        grant_type: 'client_credentials',
      },
    });

    const accessToken = tokenRes.data.access_token;

    // Stream-Status prüfen
    const streamRes = await axios.get(`https://api.twitch.tv/helix/streams`, {
      params: { user_login: channelName },
      headers: {
        'Client-ID': config.external.twitchClientId,
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const stream = streamRes.data.data?.[0];
    if (!stream) {
      return { isLive: false };
    }

    return {
      isLive: true,
      title: stream.title,
      gameName: stream.game_name,
      viewerCount: stream.viewer_count,
      thumbnailUrl: stream.thumbnail_url?.replace('{width}', '320').replace('{height}', '180'),
    };
  } catch (error) {
    logger.error(`Twitch-API Fehler für ${channelName}:`, error);
    return null;
  }
}

/**
 * Steam News abrufen.
 */
async function fetchSteamNews(appId: string): Promise<{
  items: { title: string; url: string; contents: string; date: string }[];
}> {
  try {
    const response = await axios.get(
      `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/`,
      {
        params: { appid: appId, count: 5, maxlength: 300 },
        timeout: 10000,
      },
    );

    const newsItems = response.data?.appnews?.newsitems || [];
    return {
      items: newsItems.map((item: any) => ({
        title: item.title,
        url: item.url,
        contents: item.contents?.substring(0, 200) || '',
        date: new Date(item.date * 1000).toISOString(),
      })),
    };
  } catch (error) {
    logger.error(`Steam-API Fehler für App ${appId}:`, error);
    return { items: [] };
  }
}

/**
 * Loest eine YouTube-Kanal-ID auf. Akzeptiert:
 *  - rohe Kanal-ID (UC...)
 *  - Handle (@name oder name)
 *  - vollstaendige Kanal-URL (youtube.com/channel/UC..., /@handle, /c/name, /user/name)
 */
async function resolveYouTubeChannelId(input: string, apiKey: string): Promise<string | null> {
  const raw = input.trim();

  // Direkte Kanal-ID.
  if (/^UC[\w-]{20,}$/.test(raw)) return raw;

  // /channel/UC... aus URL extrahieren.
  const channelMatch = raw.match(/channel\/(UC[\w-]{20,})/);
  if (channelMatch) return channelMatch[1];

  // Handle bestimmen (@name, /@name, /c/name, /user/name oder blosser Name).
  let handle: string | null = null;
  const atMatch = raw.match(/(?:^|\/)@([\w.-]+)/);
  if (atMatch) handle = atMatch[1];
  else {
    const cMatch = raw.match(/\/(?:c|user)\/([\w.-]+)/);
    if (cMatch) handle = cMatch[1];
    else if (/^[\w.-]+$/.test(raw)) handle = raw;
  }
  if (!handle) return null;

  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'id', forHandle: `@${handle}`, key: apiKey },
      timeout: 10000,
    });
    return res.data?.items?.[0]?.id ?? null;
  } catch (error) {
    logger.error(`YouTube-Kanalaufloesung fehlgeschlagen für ${raw}:`, error);
    return null;
  }
}

/**
 * Neuestes YouTube-Video (inkl. Live-Erkennung) eines Kanals abrufen.
 * Nutzt die YouTube Data API v3 (YOUTUBE_API_KEY).
 */
async function checkYouTube(input: string): Promise<{
  channelTitle: string;
  videoId: string;
  title: string;
  isLive: boolean;
  publishedAt: string;
  url: string;
} | null> {
  const apiKey = config.external.youtubeApiKey;
  if (!apiKey) return null;

  const channelId = await resolveYouTubeChannelId(input, apiKey);
  if (!channelId) return null;

  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId,
        order: 'date',
        maxResults: 1,
        type: 'video',
        key: apiKey,
      },
      timeout: 10000,
    });

    const item = res.data?.items?.[0];
    const videoId = item?.id?.videoId;
    if (!item || !videoId) return null;

    return {
      channelTitle: item.snippet?.channelTitle ?? 'YouTube',
      videoId,
      title: item.snippet?.title ?? 'Neues Video',
      isLive: item.snippet?.liveBroadcastContent === 'live',
      publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  } catch (error) {
    logger.error(`YouTube-API Fehler für ${input}:`, error);
    return null;
  }
}

/**
 * Feed aktualisieren und neue Einträge posten.
 */
// Phase 2.3: Backoff-Map. Ein Feed mit n Fehlern in Folge wird fuer
// min(2^(n-1) * 60s, 30 min) ausgesetzt. Sobald processFeed wieder
// erfolgreich ist, wird der Eintrag entfernt.
const feedBackoff = new Map<string, { count: number; until: number }>();

// Ueberlappungsschutz: ein Feed, dessen Poll noch laeuft (z. B. langsame
// Uebersetzung bei NEWS), wird nicht parallel erneut verarbeitet. Das
// verhindert Doppel-Posts, wenn ein Poll laenger als das Intervall dauert.
const processingFeeds = new Set<string>();

async function processFeed(client: Client, feedId: string): Promise<void> {
  // Phase 2.3: Backoff-Check. Wenn der Feed in der Sperrzone ist, ueberspringen.
  const bo = feedBackoff.get(feedId);
  if (bo && bo.until > Date.now()) return;

  // Bereits laufende Verarbeitung dieses Feeds nicht erneut starten.
  if (processingFeeds.has(feedId)) return;
  processingFeeds.add(feedId);
  try {
    await processFeedInner(client, feedId);
  } finally {
    processingFeeds.delete(feedId);
  }
}

async function processFeedInner(client: Client, feedId: string): Promise<void> {

  const feed = await prisma.feed.findUnique({ where: { id: feedId } });
  if (!feed || !feed.isActive) return;

  const channel = await client.channels.fetch(feed.channelId).catch(() => null) as TextChannel | null;
  if (!channel) return;

  // Role-Pings vorbereiten (gemeinsam fuer alle Feed-Typen).
  const roleIds = (feed.mentionRoles ?? []).filter((id) => /^\d+$/.test(id));
  const pingPrefix = roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(' ') : '';
  const sendOpts = (embed: EmbedBuilder) => ({
    ...(pingPrefix ? { content: pingPrefix } : {}),
    embeds: [embed],
    allowedMentions: { roles: roleIds, parse: [] as ('everyone' | 'roles' | 'users')[] },
  });

  try {
    switch (feed.feedType) {
      case 'RSS':
      case 'NEWS': {
        const { items, latestId } = await fetchRssFeed(feed.url, feed.lastItemId);
        // NEWS-Feeds werden immer ins Deutsche uebersetzt (Fallback: Original).
        const isNews = feed.feedType === 'NEWS';
        for (const item of items.reverse()) {
          let title = item.title;
          let description = item.description || 'Keine Beschreibung';
          if (isNews) {
            const tTitle = await translate(item.title, 'de').catch(() => null);
            if (tTitle) title = tTitle;
            if (item.description) {
              const tDesc = await translate(item.description, 'de').catch(() => null);
              if (tDesc) description = tDesc;
            }
          }
          const embed = new EmbedBuilder()
            .setTitle(title.slice(0, 256))
            .setURL(item.link)
            .setDescription(description.slice(0, 4096))
            .setColor(0xe67e22)
            .setFooter({ text: `📡 ${feed.name}` })
            .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date());

          await channel.send(sendOpts(embed));
        }

        if (latestId) {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: latestId, lastChecked: new Date() },
          });
        }
        break;
      }

      case 'TWITCH': {
        const streamInfo = await checkTwitchStream(feed.url);
        if (!streamInfo) break;

        const lastState = feed.lastItemId === 'LIVE';
        if (streamInfo.isLive && !lastState) {
          const embed = new EmbedBuilder()
            .setTitle(`🔴 ${feed.url} ist LIVE!`)
            .setDescription(streamInfo.title || 'Keine Beschreibung')
            .setURL(`https://twitch.tv/${feed.url}`)
            .setColor(0x9146ff)
            .addFields(
              { name: '🎮 Spiel', value: streamInfo.gameName || 'Unbekannt', inline: true },
              { name: '👁️ Zuschauer', value: `${streamInfo.viewerCount || 0}`, inline: true },
            )
            .setFooter({ text: `📡 ${feed.name}` })
            .setTimestamp();

          if (streamInfo.thumbnailUrl) {
            embed.setImage(streamInfo.thumbnailUrl);
          }

          await channel.send(sendOpts(embed));
        }

        await prisma.feed.update({
          where: { id: feedId },
          data: {
            lastItemId: streamInfo.isLive ? 'LIVE' : 'OFFLINE',
            lastChecked: new Date(),
          },
        });
        break;
      }

      case 'STEAM': {
        const { items } = await fetchSteamNews(feed.url);
        const newItems = feed.lastItemId
          ? items.filter(i => new Date(i.date) > (feed.lastChecked || new Date(0)))
          : items.slice(0, 3);

        for (const item of newItems) {
          const embed = new EmbedBuilder()
            .setTitle(`🎮 ${item.title}`)
            .setURL(item.url)
            .setDescription(item.contents)
            .setColor(0x1b2838)
            .setFooter({ text: `📡 ${feed.name}` })
            .setTimestamp(new Date(item.date));

          await channel.send(sendOpts(embed));
        }

        if (items.length > 0) {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: items[0].url, lastChecked: new Date() },
          });
        }
        break;
      }

      case 'YOUTUBE': {
        const yt = await checkYouTube(feed.url);
        if (!yt) break;

        // Erstlauf: nur Marker setzen, keine alten Videos posten.
        if (!feed.lastItemId) {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: yt.videoId, lastChecked: new Date() },
          });
          break;
        }

        if (yt.videoId !== feed.lastItemId) {
          const embed = new EmbedBuilder()
            .setTitle(`${yt.isLive ? '🔴 LIVE: ' : '▶️ Neues Video: '}${yt.title}`.slice(0, 256))
            .setURL(yt.url)
            .setColor(0xff0000)
            .setAuthor({ name: yt.channelTitle })
            .setFooter({ text: `📡 ${feed.name}` })
            .setTimestamp(yt.publishedAt ? new Date(yt.publishedAt) : new Date());

          await channel.send(sendOpts(embed));

          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: yt.videoId, lastChecked: new Date() },
          });
        } else {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastChecked: new Date() },
          });
        }
        break;
      }

      case 'WEBHOOK':
      case 'CUSTOM': {
        // Custom Webhooks werden separat verarbeitet
        await prisma.feed.update({
          where: { id: feedId },
          data: { lastChecked: new Date() },
        });
        break;
      }
    }
  } catch (error) {
    logger.error(`Feed-Verarbeitung fehlgeschlagen für ${feed.name}:`, error);
    // Phase 2.3: in-memory Backoff-Marker setzen. Bei wiederholten Fehlern
    // verlaengert sich die Sperrzeit exponentiell (max. 30 min).
    const prev = feedBackoff.get(feedId)?.count ?? 0;
    const count = prev + 1;
    const delayMs = Math.min(60_000 * 2 ** Math.min(count - 1, 5), 30 * 60_000);
    feedBackoff.set(feedId, { count, until: Date.now() + delayMs });
    return;
  }
  // Erfolgreiche Verarbeitung -> Backoff loeschen.
  if (feedBackoff.has(feedId)) feedBackoff.delete(feedId);
}

/**
 * Manuell einen einzelnen Feed sofort verarbeiten (Dashboard "Jetzt pruefen").
 * Ignoriert den Backoff-Timer bewusst nicht — Fehler werden dort registriert.
 */
export async function runFeedNow(client: Client, feedId: string): Promise<void> {
  await processFeed(client, feedId);
}

/**
 * Feed-Scheduler: Prüft regelmäßig alle aktiven Feeds.
 */
export function startFeedScheduler(client: Client): void {
  const feedTimers = new Map<string, NodeJS.Timeout>();
  // Gemerktes Intervall je Feed -> erkennt Aenderungen und erneuert den Timer.
  const feedIntervals = new Map<string, number>();

  // Initial alle Feeds laden und Timer setzen
  async function initFeeds(): Promise<void> {
    const feeds = await prisma.feed.findMany({ where: { isActive: true } });

    for (const feed of feeds) {
      if (feedTimers.has(feed.id)) continue;

      const timer = setInterval(
        () => processFeed(client, feed.id),
        feed.interval * 1000,
      );
      feedTimers.set(feed.id, timer);
      feedIntervals.set(feed.id, feed.interval);
      logger.info(`Feed-Timer gestartet: ${feed.name} (alle ${feed.interval}s)`);
    }
  }

  // Feeds neu laden alle 5 Minuten (für neue/geänderte/deaktivierte Feeds)
  setInterval(async () => {
    try {
      // Deaktivierte Feeds stoppen
      for (const [feedId, timer] of feedTimers) {
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed || !feed.isActive) {
          clearInterval(timer);
          feedTimers.delete(feedId);
          feedIntervals.delete(feedId);
          continue;
        }
        // Intervall im Dashboard geaendert -> Timer mit neuem Takt neu setzen.
        if (feedIntervals.get(feedId) !== feed.interval) {
          clearInterval(timer);
          const next = setInterval(() => processFeed(client, feed.id), feed.interval * 1000);
          feedTimers.set(feedId, next);
          feedIntervals.set(feedId, feed.interval);
          logger.info(`Feed-Timer aktualisiert: ${feed.name} (alle ${feed.interval}s)`);
        }
      }

      // Neue Feeds starten
      await initFeeds();
    } catch (error) {
      logger.error('Feed-Scheduler Refresh fehlgeschlagen:', error);
    }
  }, 5 * 60 * 1000);

  initFeeds().catch(err => logger.error('Feed-Scheduler Init fehlgeschlagen:', err));
  logger.info('Feed-Scheduler gestartet.');
}
