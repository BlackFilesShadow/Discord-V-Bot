/**
 * Pro-Feed API-Zugangsdaten (verschluesselt, AES-256-GCM).
 *
 * YouTube-Feeds koennen einen eigenen API-Key, Twitch-Feeds eigene Client-ID
 * + Client-Secret hinterlegen. Ist nichts hinterlegt, greift der globale ENV-Key.
 * Gespeichert wird ausschliesslich der verschluesselte JSON-Blob in
 * Feed.credentialsEnc; Klartext-Secrets werden nie ueber die Read-API ausgegeben.
 *
 * Wichtig: Die Anbieter dokumentieren die benoetigten Credential-Felder, aber
 * keine stabile vertragliche Zeichenlaenge fuer alle zukuenftigen Keys. Deshalb
 * validieren wir defensiv auf nicht-leere, whitespace-freie Tokens statt auf
 * historische Beispiel-Laengen wie exakt 30/39 Zeichen.
 */
import { encrypt, decrypt } from '../../utils/security';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface TwitchCreds { twitchClientId: string; twitchClientSecret: string }
export interface YouTubeCreds { youtubeApiKey: string }
export type FeedCreds = TwitchCreds | YouTubeCreds;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function validToken(value: string, min: number, max = 256): boolean {
  return value.length >= min && value.length <= max && !/\s/.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

export type CredentialUpdate =
  | { ok: true; change: false }
  | { ok: true; change: true; value: string | null }
  | { ok: false; error: string };

export function resolveCredentialUpdate(feedType: string, body: Record<string, unknown>): CredentialUpdate {
  if (feedType === 'YOUTUBE') {
    if (!('youtubeApiKey' in body)) return { ok: true, change: false };
    const key = str(body.youtubeApiKey);
    if (key.length === 0) return { ok: true, change: true, value: null };
    if (!validToken(key, 20)) {
      return { ok: false, error: 'Ungültiger YouTube-API-Key (keine Leerzeichen, 20–256 Zeichen).' };
    }
    return { ok: true, change: true, value: encryptCreds({ youtubeApiKey: key }) };
  }

  if (feedType === 'TWITCH') {
    const hasId = 'twitchClientId' in body;
    const hasSecret = 'twitchClientSecret' in body;
    if (!hasId && !hasSecret) return { ok: true, change: false };
    const id = str(body.twitchClientId);
    const secret = str(body.twitchClientSecret);
    if (id.length === 0 && secret.length === 0) return { ok: true, change: true, value: null };
    if (!validToken(id, 8)) {
      return { ok: false, error: 'Ungültige Twitch-Client-ID (keine Leerzeichen, 8–256 Zeichen).' };
    }
    if (!validToken(secret, 12)) {
      return { ok: false, error: 'Ungültiges Twitch-Client-Secret (keine Leerzeichen, 12–256 Zeichen).' };
    }
    return { ok: true, change: true, value: encryptCreds({ twitchClientId: id, twitchClientSecret: secret }) };
  }

  return { ok: true, change: false };
}

export function encryptCreds(creds: FeedCreds): string {
  return encrypt(JSON.stringify(creds), config.security.encryptionKey);
}

export function getTwitchCreds(credentialsEnc: string | null | undefined): TwitchCreds | null {
  const c = decryptCreds(credentialsEnc);
  if (c && 'twitchClientId' in c && 'twitchClientSecret' in c && c.twitchClientId && c.twitchClientSecret) {
    return { twitchClientId: c.twitchClientId, twitchClientSecret: c.twitchClientSecret };
  }
  return null;
}

export function getYouTubeKey(credentialsEnc: string | null | undefined): string | null {
  const c = decryptCreds(credentialsEnc);
  if (c && 'youtubeApiKey' in c && c.youtubeApiKey) return c.youtubeApiKey;
  return null;
}

function decryptCreds(credentialsEnc: string | null | undefined): Partial<TwitchCreds & YouTubeCreds> | null {
  if (!credentialsEnc) return null;
  try {
    const json = decrypt(credentialsEnc, config.security.encryptionKey);
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Partial<TwitchCreds & YouTubeCreds>;
    return null;
  } catch (e) {
    logger.warn(`feedCredentials: Entschluesselung fehlgeschlagen: ${(e as Error).message}`);
    return null;
  }
}
