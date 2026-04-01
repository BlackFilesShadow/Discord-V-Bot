import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
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
  filters?: Record<string, unknown>,
): Promise<string> {
  const feed = await prisma.feed.create({
    data: {
      name,
      feedType: feedType as any,
      url,
      channelId,
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
 * Feed aktualisieren und neue Einträge posten.
 */
async function processFeed(client: Client, feedId: string): Promise<void> {
  const feed = await prisma.feed.findUnique({ where: { id: feedId } });
  if (!feed || !feed.isActive) return;

  const channel = await client.channels.fetch(feed.channelId).catch(() => null) as TextChannel | null;
  if (!channel) return;

  try {
    switch (feed.feedType) {
      case 'RSS':
      case 'NEWS': {
        const { items, latestId } = await fetchRssFeed(feed.url, feed.lastItemId);
        for (const item of items.reverse()) {
          const embed = new EmbedBuilder()
            .setTitle(item.title)
            .setURL(item.link)
            .setDescription(item.description || 'Keine Beschreibung')
            .setColor(0xe67e22)
            .setFooter({ text: `📡 ${feed.name}` })
            .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date());

          await channel.send({ embeds: [embed] });
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

          await channel.send({ embeds: [embed] });
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

          await channel.send({ embeds: [embed] });
        }

        if (items.length > 0) {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: items[0].url, lastChecked: new Date() },
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
  }
}

/**
 * Feed-Scheduler: Prüft regelmäßig alle aktiven Feeds.
 */
export function startFeedScheduler(client: Client): void {
  const feedTimers = new Map<string, NodeJS.Timeout>();

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
      logger.info(`Feed-Timer gestartet: ${feed.name} (alle ${feed.interval}s)`);
    }
  }

  // Feeds neu laden alle 5 Minuten (für neue/geänderte Feeds)
  setInterval(async () => {
    try {
      // Deaktivierte Feeds stoppen
      for (const [feedId, timer] of feedTimers) {
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed || !feed.isActive) {
          clearInterval(timer);
          feedTimers.delete(feedId);
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
