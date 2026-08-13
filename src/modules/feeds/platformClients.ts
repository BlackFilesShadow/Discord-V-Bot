import axios from 'axios';
import { config } from '../../config';
import type { TwitchCreds } from './feedCredentials';
import type { FeedEntry } from './feedDocument';

type TwitchToken = { token: string; expiresAt: number };
const twitchTokens = new Map<string, TwitchToken>();

async function getToken(creds?: TwitchCreds, force = false): Promise<{ clientId: string; token: string }> {
  const clientId = creds?.twitchClientId || config.external.twitchClientId;
  const secret = creds?.twitchClientSecret || config.external.twitchClientSecret;
  if (!clientId || !secret) throw new Error('Twitch-Credentials fehlen.');
  const cached = twitchTokens.get(clientId);
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return { clientId, token: cached.token };
  const response = await axios.post('https://id.twitch.tv/oauth2/token', null, { params: { client_id: clientId, client_secret: secret, grant_type: 'client_credentials' }, timeout: 10_000 });
  const token = String(response.data?.access_token ?? '');
  const expiresIn = Number(response.data?.expires_in ?? 0);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Twitch hat keinen gültigen App-Token geliefert.');
  twitchTokens.set(clientId, { token, expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000 });
  return { clientId, token };
}

export interface TwitchStreamState { isLive: boolean; streamId: string | null; title?: string; gameName?: string; viewerCount?: number; thumbnailUrl?: string; startedAt?: string }
export async function getTwitchStream(login: string, creds?: TwitchCreds): Promise<TwitchStreamState> {
  const request = async (retry: boolean): Promise<TwitchStreamState> => {
    const auth = await getToken(creds, retry);
    try {
      const response = await axios.get('https://api.twitch.tv/helix/streams', { params: { user_login: login }, headers: { 'Client-ID': auth.clientId, Authorization: `Bearer ${auth.token}` }, timeout: 10_000 });
      const stream = response.data?.data?.[0];
      if (!stream) return { isLive: false, streamId: null };
      return { isLive: true, streamId: String(stream.id ?? '') || null, title: String(stream.title ?? ''), gameName: String(stream.game_name ?? ''), viewerCount: Number(stream.viewer_count ?? 0), thumbnailUrl: typeof stream.thumbnail_url === 'string' ? stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360') : undefined, startedAt: typeof stream.started_at === 'string' ? stream.started_at : undefined };
    } catch (error: any) {
      if (!retry && error?.response?.status === 401) { twitchTokens.delete(auth.clientId); return request(true); }
      throw error;
    }
  };
  return request(false);
}

export type YouTubeSource = { kind: 'playlist'; id: string } | { kind: 'channel'; ref: string };
export function parseYouTubeSource(input: string): YouTubeSource | null {
  const raw = input.trim();
  const playlist = raw.match(/^playlist:([A-Za-z0-9_-]+)$/i); if (playlist) return { kind: 'playlist', id: playlist[1] };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(raw)) return { kind: 'channel', ref: raw };
  if (/^@?[A-Za-z0-9_.-]{1,100}$/.test(raw)) return { kind: 'channel', ref: raw.startsWith('@') ? raw : `@${raw}` };
  let u: URL; try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;
  const list = u.searchParams.get('list'); if (list && /^[A-Za-z0-9_-]+$/.test(list)) return { kind: 'playlist', id: list };
  if (host === 'youtu.be' || u.pathname === '/watch' || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) return null;
  const channel = u.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,})/i); if (channel) return { kind: 'channel', ref: channel[1] };
  const handle = u.pathname.match(/^\/@([A-Za-z0-9_.-]+)/); if (handle) return { kind: 'channel', ref: `@${handle[1]}` };
  const user = u.pathname.match(/^\/user\/([A-Za-z0-9_.-]+)/i); if (user) return { kind: 'channel', ref: `user:${user[1]}` };
  const custom = u.pathname.match(/^\/c\/([A-Za-z0-9_.-]+)/i); if (custom) return { kind: 'channel', ref: `custom:${custom[1]}` };
  return null;
}

async function uploadsPlaylist(ref: string, apiKey: string): Promise<{ playlistId: string; channelTitle: string }> {
  const params: Record<string, string> = { part: 'contentDetails,snippet', key: apiKey };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(ref)) params.id = ref;
  else if (ref.startsWith('@')) params.forHandle = ref;
  else if (ref.startsWith('user:')) params.forUsername = ref.slice(5);
  else if (ref.startsWith('custom:')) params.forHandle = `@${ref.slice(7)}`;
  else throw new Error('YouTube-Kanalreferenz ist ungültig.');
  const response = await axios.get('https://www.googleapis.com/youtube/v3/channels', { params, timeout: 10_000 });
  const item = response.data?.items?.[0];
  if (!item) {
    if (ref.startsWith('custom:')) throw new Error('Die alte YouTube-/c/-URL konnte nicht eindeutig aufgelöst werden. Bitte die aktuelle @Handle- oder /channel/URL verwenden.');
    throw new Error('YouTube-Kanal wurde nicht gefunden.');
  }
  const playlistId = String(item.contentDetails?.relatedPlaylists?.uploads ?? '');
  if (!playlistId) throw new Error('YouTube-Uploads-Playlist fehlt.');
  return { playlistId, channelTitle: String(item.snippet?.title ?? 'YouTube') };
}

function thumbnail(snippet: any): string | null { return snippet?.thumbnails?.maxres?.url ?? snippet?.thumbnails?.standard?.url ?? snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.default?.url ?? null; }
export async function getYouTubeEntries(input: string, keyOverride?: string): Promise<{ channelTitle: string; entries: FeedEntry[] }> {
  const apiKey = keyOverride || config.external.youtubeApiKey; if (!apiKey) throw new Error('YouTube-API-Key fehlt.');
  const source = parseYouTubeSource(input); if (!source) throw new Error('Bitte eine YouTube-Kanal-, @Handle-, /user/- oder Playlist-URL angeben; einzelne Video-URLs sind keine Feed-Quelle.');
  let playlistId: string; let channelTitle = 'YouTube';
  if (source.kind === 'playlist') playlistId = source.id; else { const r = await uploadsPlaylist(source.ref, apiKey); playlistId = r.playlistId; channelTitle = r.channelTitle; }
  const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', { params: { part: 'snippet,contentDetails', playlistId, maxResults: 25, key: apiKey }, timeout: 10_000 });
  const raw = Array.isArray(response.data?.items) ? response.data.items : [];
  const entries: FeedEntry[] = raw.map((item: any) => { const id = String(item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? ''); const sn = item.snippet ?? {}; if (channelTitle === 'YouTube' && sn.videoOwnerChannelTitle) channelTitle = String(sn.videoOwnerChannelTitle); return { id, title: String(sn.title ?? 'Neues Video').slice(0, 500), link: id ? `https://www.youtube.com/watch?v=${id}` : '', description: String(sn.description ?? '').slice(0, 4096), publishedAt: typeof sn.publishedAt === 'string' && !Number.isNaN(new Date(sn.publishedAt).getTime()) ? new Date(sn.publishedAt).toISOString() : null, image: thumbnail(sn) }; }).filter((e: FeedEntry) => Boolean(e.id));
  return { channelTitle, entries };
}

export async function getSteamNews(appId: string): Promise<FeedEntry[]> {
  const response = await axios.get('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/', { params: { appid: appId, count: 20, maxlength: 600 }, timeout: 10_000 });
  const raw = Array.isArray(response.data?.appnews?.newsitems) ? response.data.appnews.newsitems : [];
  return raw.map((item: any, i: number) => { const link = String(item.url ?? ''); const id = String(item.gid ?? '') || link || `steam:${appId}:${item.date ?? i}`; const date = Number(item.date); return { id, title: String(item.title ?? 'Steam News').slice(0, 500), link, description: String(item.contents ?? '').replace(/\[\/?[^\]]+\]/g, '').slice(0, 4096), publishedAt: Number.isFinite(date) && date > 0 ? new Date(date * 1000).toISOString() : null, image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg` }; });
}
