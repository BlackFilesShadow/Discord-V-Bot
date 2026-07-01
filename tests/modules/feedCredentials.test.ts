process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Pro-Feed API-Keys (verschluesselt): Format-Validierung, Verschluesselungs-
 * Roundtrip, Entfernen (leer) und Ignorieren (Feld fehlt / falscher Typ).
 */
import {
  resolveCredentialUpdate, getYouTubeKey, getTwitchCreds,
} from '../../src/modules/feeds/feedCredentials';

const VALID_YT = 'AIza' + 'a'.repeat(35);              // 39 Zeichen, AIza-Praefix
const VALID_TW_ID = 'a'.repeat(30);
const VALID_TW_SECRET = 'b'.repeat(30);

describe('resolveCredentialUpdate — YouTube', () => {
  it('verschluesselt einen gueltigen Key und ist per getYouTubeKey lesbar', () => {
    const r = resolveCredentialUpdate('YOUTUBE', { youtubeApiKey: VALID_YT });
    expect(r.ok).toBe(true);
    if (r.ok && r.change) {
      expect(typeof r.value).toBe('string');
      expect(r.value).not.toContain(VALID_YT);       // Klartext nie im Blob
      expect(getYouTubeKey(r.value)).toBe(VALID_YT);  // Roundtrip
    } else { throw new Error('erwartet change'); }
  });
  it('lehnt ungueltiges Key-Format ab', () => {
    expect(resolveCredentialUpdate('YOUTUBE', { youtubeApiKey: 'nope' }).ok).toBe(false);
  });
  it('leerer Key -> entfernen (value null)', () => {
    const r = resolveCredentialUpdate('YOUTUBE', { youtubeApiKey: '' });
    expect(r).toEqual({ ok: true, change: true, value: null });
  });
  it('fehlendes Feld -> keine Aenderung', () => {
    expect(resolveCredentialUpdate('YOUTUBE', {})).toEqual({ ok: true, change: false });
  });
});

describe('resolveCredentialUpdate — Twitch', () => {
  it('verschluesselt gueltige Client-ID + Secret (getTwitchCreds Roundtrip)', () => {
    const r = resolveCredentialUpdate('TWITCH', { twitchClientId: VALID_TW_ID, twitchClientSecret: VALID_TW_SECRET });
    expect(r.ok).toBe(true);
    if (r.ok && r.change && r.value) {
      expect(r.value).not.toContain(VALID_TW_SECRET);
      expect(getTwitchCreds(r.value)).toEqual({ twitchClientId: VALID_TW_ID, twitchClientSecret: VALID_TW_SECRET });
    } else { throw new Error('erwartet change'); }
  });
  it('lehnt unvollstaendige/ungueltige Credentials ab', () => {
    expect(resolveCredentialUpdate('TWITCH', { twitchClientId: VALID_TW_ID, twitchClientSecret: 'x' }).ok).toBe(false);
    expect(resolveCredentialUpdate('TWITCH', { twitchClientId: 'x', twitchClientSecret: VALID_TW_SECRET }).ok).toBe(false);
  });
  it('beide leer -> entfernen (value null)', () => {
    expect(resolveCredentialUpdate('TWITCH', { twitchClientId: '', twitchClientSecret: '' }))
      .toEqual({ ok: true, change: true, value: null });
  });
});

describe('Decrypt-Guards', () => {
  it('getYouTubeKey/getTwitchCreds liefern null bei fehlendem/kaputtem Blob', () => {
    expect(getYouTubeKey(null)).toBeNull();
    expect(getYouTubeKey('kaputt')).toBeNull();
    expect(getTwitchCreds(undefined)).toBeNull();
  });
  it('RSS-Feeds haben keine per-Feed-Credentials -> ignoriert', () => {
    expect(resolveCredentialUpdate('RSS', { youtubeApiKey: VALID_YT })).toEqual({ ok: true, change: false });
  });
});
