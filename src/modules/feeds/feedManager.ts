import { Client, EmbedBuilder, Guild, PermissionFlagsBits, TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { translate } from '../ai/translator';
import { extractTwitchLogin, extractSteamAppId } from './urlResolver';
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
  items: { title: string; link: string; description: string; pubDate: string; id: string; image: string | null }[];
  latestId: string | null;
}> {
  try {
    const response = await axios.get(url, { timeout: 10000, responseType: 'text', maxRedirects: 5 });
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
      image: extractItemImage(item),
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
 * Extrahiert automatisch das beste verfuegbare Bild aus einem RSS-/Atom-Item.
 * Geprueft werden (in dieser Reihenfolge): media:content, media:thumbnail,
 * enclosure (image/*), itunes:image, sowie ein <img src> in Content/Description.
 * Gibt eine http(s)-Bild-URL zurueck oder null (kein Bild -> Versand ohne Bild).
 */
function extractItemImage(item: any): string | null {
  const firstUrl = (v: any): string | null => {
    if (!v) return null;
    const node = Array.isArray(v) ? v[0] : v;
    const u = node?.['@_url'] || node?.['@_href'] || (typeof node === 'string' ? node : null);
    return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
  };

  // media:content — bevorzugt das mit groesster Breite (beste Qualitaet).
  const mc = item['media:content'];
  if (mc) {
    const arr = Array.isArray(mc) ? mc : [mc];
    const images = arr.filter((m: any) => !m?.['@_medium'] || m['@_medium'] === 'image');
    images.sort((a: any, b: any) => Number(b?.['@_width'] || 0) - Number(a?.['@_width'] || 0));
    const best = firstUrl(images[0]);
    if (best) return best;
  }
  const mediaThumb = firstUrl(item['media:thumbnail']);
  if (mediaThumb) return mediaThumb;

  const enc = item.enclosure;
  if (enc) {
    const arr = Array.isArray(enc) ? enc : [enc];
    const img = arr.find((e: any) => String(e?.['@_type'] || '').startsWith('image') || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(String(e?.['@_url'] || '')));
    const u = firstUrl(img);
    if (u) return u;
  }

  const itunes = firstUrl(item['itunes:image']);
  if (itunes) return itunes;

  // Fallback: erstes <img src> aus content:encoded / description.
  const html = String(item['content:encoded'] || item.description || item.summary || '');
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && /^https?:\/\//i.test(imgMatch[1])) return imgMatch[1];

  return null;
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

  // Playlist-Feed: neuestes hinzugefuegtes Video ueber playlistItems ermitteln.
  const playlistId = input.match(/^playlist:([\w-]+)$/i)?.[1] ?? input.match(/[?&]list=([\w-]+)/)?.[1] ?? null;
  if (playlistId) return checkYouTubePlaylist(playlistId, apiKey);

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
 * Neuestes (zuletzt hinzugefuegtes) Video einer YouTube-Playlist ueber
 * playlistItems ermitteln. Live-Status ist bei Playlists nicht verfuegbar.
 */
async function checkYouTubePlaylist(playlistId: string, apiKey: string): Promise<{
  channelTitle: string;
  videoId: string;
  title: string;
  isLive: boolean;
  publishedAt: string;
  url: string;
} | null> {
  interface PlItem {
    snippet?: {
      publishedAt?: string;
      title?: string;
      channelTitle?: string;
      videoOwnerChannelTitle?: string;
      resourceId?: { videoId?: string };
    };
  }
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: { part: 'snippet', playlistId, maxResults: 50, key: apiKey },
      timeout: 10000,
    });
    const items = (res.data?.items ?? []) as PlItem[];
    if (items.length === 0) return null;
    // Zuletzt zur Playlist hinzugefuegtes Video (max publishedAt).
    let newest = items[0];
    for (const it of items) {
      if (new Date(it.snippet?.publishedAt ?? 0) > new Date(newest.snippet?.publishedAt ?? 0)) newest = it;
    }
    const sn = newest.snippet ?? {};
    const videoId = sn.resourceId?.videoId;
    if (!videoId) return null;
    return {
      channelTitle: sn.channelTitle ?? sn.videoOwnerChannelTitle ?? 'YouTube',
      videoId,
      title: sn.title ?? 'Neues Video',
      isLive: false,
      publishedAt: sn.publishedAt ?? new Date().toISOString(),
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  } catch (error) {
    logger.error(`YouTube-Playlist-API Fehler für ${playlistId}:`, error);
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

/**
 * Prueft die konfigurierten Ping-Rollen unmittelbar vor dem Versand und gibt
 * nur die tatsaechlich erwaehnbaren Rollen-IDs zurueck. Kriterien:
 *  - Rolle existiert noch auf dem Server,
 *  - ist nicht @everyone,
 *  - ist erwaehnbar ODER der Bot besitzt „Alle erwaehnen".
 * Ungueltige Rollen werden uebersprungen und protokolliert (der Feed wird
 * trotzdem gesendet). Gespeichert werden ausschliesslich Rollen-IDs.
 */
async function resolveMentionableRoles(guild: Guild, roleIds: string[], feedId: string): Promise<string[]> {
  const ids = (roleIds ?? []).filter((id) => /^\d{17,20}$/.test(id));
  if (ids.length === 0) return [];
  const me = guild.members.me;
  const canMentionAny = me?.permissions.has(PermissionFlagsBits.MentionEveryone) ?? false;
  const out: string[] = [];
  for (const id of ids) {
    if (id === guild.id) continue; // @everyone ist kein Rollen-Ping
    const role = guild.roles.cache.get(id) ?? await guild.roles.fetch(id).catch(() => null);
    if (!role) {
      logger.warn(`Feed ${feedId}: Ping-Rolle ${id} existiert nicht mehr — uebersprungen.`);
      continue;
    }
    if (role.mentionable || canMentionAny) out.push(id);
    else logger.warn(`Feed ${feedId}: Rolle „${role.name}" ist nicht erwaehnbar und dem Bot fehlt „Alle erwaehnen" — Ping uebersprungen.`);
  }
  return out;
}

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

  // Role-Pings vorbereiten (optional). Jede Rolle wird vor dem Versand geprueft:
  // existiert sie noch + darf der Bot sie erwaehnen? Ungueltige Rollen entfallen
  // (Feed wird trotzdem gesendet), der Vorfall wird protokolliert.
  const roleIds = await resolveMentionableRoles(channel.guild, feed.mentionRoles ?? [], feed.id);
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
        // Erstlauf: nur Marker setzen, keine Altbeitraege posten (kein Spam) —
        // konsistent zu Twitch/YouTube. Nur echte neue Beitraege loesen Pings aus.
        if (!feed.lastItemId) {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: latestId ?? undefined, lastChecked: new Date() },
          });
          break;
        }
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

          // Automatische Bilduebernahme (falls die Quelle ein Bild liefert).
          if (item.image) embed.setImage(item.image);

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
        // Technische Quelle ist die URL -> Login daraus extrahieren.
        const login = extractTwitchLogin(feed.url);
        if (!login) { logger.warn(`TWITCH-Feed ${feed.id}: keine gueltige Twitch-URL (${feed.url}).`); break; }
        const streamInfo = await checkTwitchStream(login);
        if (!streamInfo) break;

        const lastState = feed.lastItemId === 'LIVE';
        if (streamInfo.isLive && !lastState) {
          const embed = new EmbedBuilder()
            .setTitle(`🔴 ${feed.name} ist LIVE!`)
            .setDescription(streamInfo.title || 'Keine Beschreibung')
            .setURL(`https://twitch.tv/${login}`)
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
        // Technische Quelle ist die URL -> AppID daraus extrahieren.
        const appId = extractSteamAppId(feed.url);
        if (!appId) { logger.warn(`STEAM-Feed ${feed.id}: keine gueltige Steam-URL (${feed.url}).`); break; }
        const headerImage = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
        const { items } = await fetchSteamNews(appId);
        // Erstlauf: nur Marker setzen, keine Altbeitraege posten (kein Spam).
        if (!feed.lastItemId) {
          await prisma.feed.update({
            where: { id: feedId },
            data: { lastItemId: items[0]?.url ?? undefined, lastChecked: new Date() },
          });
          break;
        }
        const newItems = items.filter(i => new Date(i.date) > (feed.lastChecked || new Date(0)));

        for (const item of newItems) {
          const embed = new EmbedBuilder()
            .setTitle(`🎮 ${item.title}`)
            .setURL(item.url)
            .setDescription(item.contents)
            .setColor(0x1b2838)
            .setImage(headerImage)
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
            .setImage(`https://i.ytimg.com/vi/${yt.videoId}/hqdefault.jpg`)
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
