process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * URL-Resolver-Engine: URL ist die einzige technische Grundlage.
 * Prueft Plattform-Erkennung, Extraktion (Twitch/Steam/YouTube), Normalisierung
 * (Tracking-Parameter entfernen), SSRF-Schutz und Rueckwaertskompatibilitaet.
 */
import {
  resolveFeedSource, normalizeUrl, extractTwitchLogin, extractSteamAppId, extractYouTubeRef,
} from '../../src/modules/feeds/urlResolver';

describe('normalizeUrl', () => {
  it('entfernt Tracking-Parameter und Fragment, senkt den Host', () => {
    const n = normalizeUrl('https://Example.com/news?id=5&utm_source=x&fbclid=y#top');
    expect(n).toBe('https://example.com/news?id=5');
  });
});

describe('Twitch — nur URL-basiert', () => {
  it('extrahiert den Login aus einer Twitch-URL', () => {
    expect(extractTwitchLogin('https://www.twitch.tv/Shroud')).toBe('shroud');
    expect(extractTwitchLogin('twitch.tv/void__architect')).toBe('void__architect');
  });
  it('akzeptiert einen blossen Login (Legacy)', () => {
    expect(extractTwitchLogin('shroud')).toBe('shroud');
  });
  it('resolveFeedSource liefert stabile sourceId + normalisierte URL', () => {
    const r = resolveFeedSource('TWITCH', 'https://twitch.tv/Ninja');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.sourceId).toBe('twitch:ninja');
      expect(r.resolved.url).toBe('https://twitch.tv/ninja');
    }
  });
  it('lehnt ungueltige Twitch-Eingaben ab', () => {
    expect(resolveFeedSource('TWITCH', 'ab').ok).toBe(false);
  });
});

describe('Steam — nur URL-basiert', () => {
  it('extrahiert die AppID aus Store-/Community-/News-URLs', () => {
    expect(extractSteamAppId('https://store.steampowered.com/app/730/CS2/')).toBe('730');
    expect(extractSteamAppId('https://steamcommunity.com/app/440')).toBe('440');
    expect(extractSteamAppId('https://store.steampowered.com/news/app/570')).toBe('570');
  });
  it('akzeptiert eine blosse AppID (Legacy)', () => {
    expect(extractSteamAppId('730')).toBe('730');
  });
  it('resolveFeedSource normalisiert auf die Store-URL', () => {
    const r = resolveFeedSource('STEAM', 'https://store.steampowered.com/app/730/');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.sourceId).toBe('steam:730');
      expect(r.resolved.url).toBe('https://store.steampowered.com/app/730');
    }
  });
});

describe('YouTube — URL / Handle / Playlist', () => {
  it('erkennt Kanal-URL, Handle und Playlist', () => {
    expect(extractYouTubeRef('https://youtube.com/@MrBeast')).toContain('youtube.com');
    expect(extractYouTubeRef('@MrBeast')).toBe('@MrBeast');
    expect(extractYouTubeRef('MrBeast')).toBe('@MrBeast');
    expect(extractYouTubeRef('https://www.youtube.com/playlist?list=PL123abc')).toBe('playlist:PL123abc');
  });
});

describe('RSS/News — URL-Validierung + SSRF', () => {
  it('akzeptiert oeffentliche http(s)-URLs', () => {
    expect(resolveFeedSource('NEWS', 'https://example.com/rss').ok).toBe(true);
  });
  it('blockt lokale/private Hosts (SSRF)', () => {
    expect(resolveFeedSource('RSS', 'http://127.0.0.1/rss').ok).toBe(false);
    expect(resolveFeedSource('NEWS', 'http://localhost/feed').ok).toBe(false);
  });
  it('lehnt Nicht-URLs ab', () => {
    expect(resolveFeedSource('RSS', 'einfach-text').ok).toBe(false);
  });
});
