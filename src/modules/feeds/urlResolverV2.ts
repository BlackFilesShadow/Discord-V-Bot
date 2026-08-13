import { isBlockedHost } from '../../utils/ssrf';

export type FeedPlatform = 'RSS' | 'NEWS' | 'TWITCH' | 'STEAM' | 'YOUTUBE' | 'WEBHOOK';
export interface ResolvedSource { platform: FeedPlatform; sourceId: string; url: string; display: string }

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|mkt_|igshid$|si$|ref$|ref_src$|ref_url$|source$|cmpid$|ns_|yclid$|_hsenc$|_hsmi$|vero_|spm$)/i;

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { return trimmed; }
  url.hostname = url.hostname.toLowerCase();
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) if (!TRACKING_PARAM.test(key)) kept.set(key, value);
  url.search = kept.toString();
  url.hash = '';
  return url.toString();
}

export function extractTwitchLogin(input: string): string | null {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
      if (host !== 'twitch.tv') return null;
      const segment = url.pathname.split('/').filter(Boolean)[0] ?? '';
      return /^[A-Za-z0-9_]{3,25}$/.test(segment) ? segment.toLowerCase() : null;
    } catch { return null; }
  }
  const noProtocol = raw.match(/^(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})/i);
  if (noProtocol) return noProtocol[1].toLowerCase();
  return /^[A-Za-z0-9_]{3,25}$/.test(raw) ? raw.toLowerCase() : null;
}

export function extractSteamAppId(input: string): string | null {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (host !== 'store.steampowered.com' && host !== 'steamcommunity.com') return null;
      return url.pathname.match(/\/app\/(\d{1,10})/i)?.[1] ?? null;
    } catch { return null; }
  }
  const noProtocol = raw.match(/^(?:store\.steampowered\.com|steamcommunity\.com)\/(?:news\/)?app\/(\d{1,10})/i);
  if (noProtocol) return noProtocol[1];
  return /^\d{1,10}$/.test(raw) ? raw : null;
}

export function extractYouTubeRef(input: string): string | null {
  const raw = input.trim();
  const playlist = raw.match(/^playlist:([A-Za-z0-9_-]+)$/i);
  if (playlist) return `playlist:${playlist[1]}`;
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;
  if (/^@?[A-Za-z0-9_.-]{1,100}$/.test(raw)) return raw.startsWith('@') ? raw : `@${raw}`;

  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;
  const list = url.searchParams.get('list');
  if (list && /^[A-Za-z0-9_-]+$/.test(list)) return `playlist:${list}`;
  if (host === 'youtu.be' || url.pathname === '/watch' || url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/live/')) return null;
  const channel = url.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,})/i);
  if (channel) return channel[1];
  const handle = url.pathname.match(/^\/@([A-Za-z0-9_.-]+)/);
  if (handle) return `@${handle[1]}`;
  const user = url.pathname.match(/^\/user\/([A-Za-z0-9_.-]+)/i);
  if (user) return `user:${user[1]}`;
  return null;
}

export function resolveFeedSource(type: string, rawUrl: string): { ok: true; resolved: ResolvedSource } | { ok: false; reason: string } {
  const input = (rawUrl ?? '').trim();
  if (!input) return { ok: false, reason: 'Feed-URL darf nicht leer sein.' };
  if (input.length > 2048) return { ok: false, reason: 'Feed-URL überschreitet 2048 Zeichen.' };

  if (type === 'RSS' || type === 'NEWS') {
    let url: URL;
    try { url = new URL(input); } catch { return { ok: false, reason: 'Bitte eine vollständige http(s)-URL angeben.' }; }
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'Nur http:// oder https:// URLs erlaubt.' };
    if (isBlockedHost(url.hostname)) return { ok: false, reason: 'Lokale/private Hosts sind nicht erlaubt (SSRF-Schutz).' };
    const normalized = normalizeUrl(input);
    return { ok: true, resolved: { platform: type, sourceId: `${type.toLowerCase()}:${normalized.toLowerCase()}`, url: normalized, display: url.hostname.replace(/^www\./, '') } };
  }

  if (type === 'TWITCH') {
    const login = extractTwitchLogin(input);
    if (!login) return { ok: false, reason: 'Bitte eine Twitch-Kanal-URL angeben (z. B. https://twitch.tv/name).' };
    return { ok: true, resolved: { platform: 'TWITCH', sourceId: `twitch:${login}`, url: `https://twitch.tv/${login}`, display: login } };
  }

  if (type === 'STEAM') {
    const appId = extractSteamAppId(input);
    if (!appId) return { ok: false, reason: 'Bitte eine Steam-App-URL angeben (z. B. https://store.steampowered.com/app/730).' };
    return { ok: true, resolved: { platform: 'STEAM', sourceId: `steam:${appId}`, url: `https://store.steampowered.com/app/${appId}`, display: `Steam App ${appId}` } };
  }

  if (type === 'YOUTUBE') {
    const ref = extractYouTubeRef(input);
    if (!ref) return { ok: false, reason: 'Bitte eine YouTube-Kanal-, @Handle-, /user/- oder Playlist-URL angeben. Einzelne Video-, Shorts- und Live-URLs sind keine Feed-Quelle.' };
    return { ok: true, resolved: { platform: 'YOUTUBE', sourceId: `yt:${ref.toLowerCase()}`, url: ref, display: ref.replace(/^playlist:/, 'Playlist ').replace(/^user:/, '') } };
  }

  if (type === 'WEBHOOK') {
    const label = input.slice(0, 200);
    return { ok: true, resolved: { platform: 'WEBHOOK', sourceId: 'webhook', url: label, display: label || 'Webhook' } };
  }

  return { ok: false, reason: 'Unbekannter Feed-Typ.' };
}
