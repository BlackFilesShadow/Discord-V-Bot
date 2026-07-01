/**
 * Zentrale URL-Parser- & Feed-Resolver-Engine.
 *
 * Die URL ist die EINZIGE technische Grundlage fuer Erkennung, Validierung und
 * Verarbeitung eines Feeds. Namen dienen ausschliesslich der Anzeige.
 *
 * Diese Engine:
 *  - normalisiert URLs (Tracking-Parameter entfernen, Host kleinschreiben)
 *  - erkennt die Plattform anhand der URL
 *  - validiert, ob die URL zum gewaehlten Typ passt
 *  - extrahiert die technische Quell-Kennung (Twitch-Login, Steam-AppID,
 *    YouTube-Referenz, normalisierte URL bei RSS/News)
 *  - erzeugt eine eindeutige, stabile Source-ID
 *
 * Rueckwaertskompatibel: bestehende Feeds, die nur den Login/die AppID (statt
 * einer vollstaendigen URL) gespeichert haben, werden weiterhin korrekt
 * aufgeloest.
 */

import { isBlockedHost } from '../../utils/ssrf';

export type FeedPlatform = 'RSS' | 'NEWS' | 'TWITCH' | 'STEAM' | 'YOUTUBE' | 'WEBHOOK';

export interface ResolvedSource {
  platform: FeedPlatform;
  /** Technische, stabile Kennung der Quelle (z. B. `twitch:login`, `steam:730`). */
  sourceId: string;
  /** Normalisierte, zu speichernde URL (bei WEBHOOK das Label). */
  url: string;
  /** Vorschlag fuer den Anzeigenamen (nur Darstellung). */
  display: string;
}

// Bekannte Tracking-/Kampagnen-Parameter, die keine inhaltliche Bedeutung haben.
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|mkt_|igshid$|si$|ref$|ref_src$|ref_url$|source$|cmpid$|ns_|yclid$|_hsenc$|_hsmi$|vero_|spm$)/i;

/**
 * Normalisiert eine URL: Host kleinschreiben, Tracking-Parameter + Fragment
 * entfernen, Standard-Ports weglassen. Ungueltige Eingaben werden unveraendert
 * (getrimmt) zurueckgegeben.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  u.hostname = u.hostname.toLowerCase();
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAM.test(k)) kept.set(k, v);
  }
  u.search = kept.toString();
  u.hash = '';
  return u.toString();
}

/** Twitch-Login aus URL extrahieren; akzeptiert auch einen blossen Login (Legacy). */
export function extractTwitchLogin(input: string): string | null {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
      if (host !== 'twitch.tv') return null; // strikte Host-Pruefung (kein Substring-Spoofing)
      const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
      return /^[A-Za-z0-9_]{3,25}$/.test(seg) ? seg.toLowerCase() : null;
    } catch { return null; }
  }
  const noProto = s.match(/^(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})/i);
  if (noProto) return noProto[1].toLowerCase();
  if (/^[A-Za-z0-9_]{3,25}$/.test(s)) return s.toLowerCase(); // Legacy: nur Login gespeichert
  return null;
}

/** Steam-AppID aus Store-/Community-/News-URL extrahieren; akzeptiert Legacy-AppID. */
export function extractSteamAppId(input: string): string | null {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase();
      if (host !== 'store.steampowered.com' && host !== 'steamcommunity.com') return null;
      const m = u.pathname.match(/\/app\/(\d{1,10})/i);
      return m ? m[1] : null;
    } catch { return null; }
  }
  const noProto = s.match(/^(?:store\.steampowered\.com|steamcommunity\.com)\/(?:news\/)?app\/(\d{1,10})/i);
  if (noProto) return noProto[1];
  if (/^\d{1,10}$/.test(s)) return s; // Legacy: nur AppID gespeichert
  return null;
}

/**
 * YouTube-Referenz normalisieren. Rueckgabe ist eine fuer den Resolver nutzbare
 * Eingabe: vollstaendige URL, Kanal-ID (UC…), @Handle oder `playlist:<id>`.
 */
export function extractYouTubeRef(input: string): string | null {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
      if (host !== 'youtube.com' && host !== 'youtu.be') return null;
      const list = u.searchParams.get('list');
      if (list && /^[\w-]+$/.test(list)) return `playlist:${list}`;
      return s; // vollstaendige URL (Kanal/Handle/User)
    } catch { return null; }
  }
  const playlist = s.match(/^playlist:([\w-]+)$/i) ?? s.match(/[?&]list=([\w-]+)/);
  if (playlist) return `playlist:${playlist[1]}`;
  if (/^UC[\w-]{20,}$/.test(s)) return s;
  if (/^@?[\w.-]{1,100}$/.test(s)) return s.startsWith('@') ? s : `@${s}`;
  return null;
}

/**
 * Validiert + loest eine Feed-Quelle anhand von Typ und URL auf.
 * Gibt bei Erfolg die technische Kennung + normalisierte URL zurueck.
 */
export function resolveFeedSource(
  type: string,
  rawUrl: string,
): { ok: true; resolved: ResolvedSource } | { ok: false; reason: string } {
  const url = (rawUrl ?? '').trim();
  if (!url) return { ok: false, reason: 'Feed-URL darf nicht leer sein.' };
  if (url.length > 2048) return { ok: false, reason: 'Feed-URL überschreitet 2048 Zeichen.' };

  switch (type) {
    case 'RSS':
    case 'NEWS': {
      let u: URL;
      try { u = new URL(url); } catch {
        return { ok: false, reason: 'Bitte eine vollständige http(s)-URL angeben.' };
      }
      if (!['http:', 'https:'].includes(u.protocol)) {
        return { ok: false, reason: 'Nur http:// oder https:// URLs erlaubt.' };
      }
      if (isBlockedHost(u.hostname)) {
        return { ok: false, reason: 'Lokale/private Hosts sind nicht erlaubt (SSRF-Schutz).' };
      }
      const norm = normalizeUrl(url);
      return {
        ok: true,
        resolved: {
          platform: type,
          sourceId: `${type.toLowerCase()}:${norm.toLowerCase()}`,
          url: norm,
          display: u.hostname.replace(/^www\./, ''),
        },
      };
    }
    case 'TWITCH': {
      const login = extractTwitchLogin(url);
      if (!login) {
        return { ok: false, reason: 'Bitte eine Twitch-Kanal-URL angeben (z. B. https://twitch.tv/name).' };
      }
      return {
        ok: true,
        resolved: { platform: 'TWITCH', sourceId: `twitch:${login}`, url: `https://twitch.tv/${login}`, display: login },
      };
    }
    case 'STEAM': {
      const appid = extractSteamAppId(url);
      if (!appid) {
        return { ok: false, reason: 'Bitte eine Steam-URL angeben (z. B. https://store.steampowered.com/app/730).' };
      }
      return {
        ok: true,
        resolved: {
          platform: 'STEAM',
          sourceId: `steam:${appid}`,
          url: `https://store.steampowered.com/app/${appid}`,
          display: `Steam App ${appid}`,
        },
      };
    }
    case 'YOUTUBE': {
      const ref = extractYouTubeRef(url);
      if (!ref) {
        return { ok: false, reason: 'Bitte eine YouTube-Kanal-, Handle- oder Playlist-URL angeben.' };
      }
      // Vollstaendige URL bevorzugt speichern, sonst die Referenz.
      const stored = /youtube\.com|youtu\.be/i.test(url) ? normalizeUrl(url) : ref;
      return {
        ok: true,
        resolved: { platform: 'YOUTUBE', sourceId: `yt:${ref.toLowerCase()}`, url: stored, display: ref.replace(/^playlist:/, 'Playlist ') },
      };
    }
    case 'WEBHOOK': {
      // Eingehende Webhooks: keine externe URL; freies Label (nur Anzeige).
      const label = url.slice(0, 200);
      return { ok: true, resolved: { platform: 'WEBHOOK', sourceId: 'webhook', url: label, display: label || 'Webhook' } };
    }
    default:
      return { ok: false, reason: 'Unbekannter Feed-Typ.' };
  }
}
