/**
 * Pro-Feed API-Zugangsdaten (verschluesselt, AES-256-GCM).
 *
 * YouTube-Feeds koennen einen eigenen `YOUTUBE_API_KEY`, Twitch-Feeds eigene
 * `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` hinterlegen. Ist nichts hinterlegt,
 * greift der globale ENV-Key (Fallback). Gespeichert wird ausschliesslich der
 * verschluesselte JSON-Blob in `Feed.credentialsEnc`; die Klartext-Secrets
 * verlassen den Server nie ueber die API (write-only).
 *
 * Format-Recherche (offizielle Muster):
 *  - YouTube Data API v3 Key: beginnt mit `AIza`, gesamt 39 Zeichen
 *    -> /^AIza[0-9A-Za-z_-]{35}$/
 *  - Twitch Client-ID:     30 Zeichen, klein-alphanumerisch  -> /^[a-z0-9]{30}$/
 *  - Twitch Client-Secret: 30 Zeichen, klein-alphanumerisch  -> /^[a-z0-9]{30}$/
 */
import { encrypt, decrypt } from '../../utils/security';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface TwitchCreds { twitchClientId: string; twitchClientSecret: string }
export interface YouTubeCreds { youtubeApiKey: string }
export type FeedCreds = TwitchCreds | YouTubeCreds;

const YOUTUBE_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;
const TWITCH_ID_RE = /^[a-z0-9]{30}$/;
const TWITCH_SECRET_RE = /^[a-z0-9]{30}$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Ergebnis fuer die Route:
 *  - change:false            -> Body enthielt keine Credential-Felder -> unveraendert lassen
 *  - change:true, value:null -> Felder leer -> gespeicherte Credentials loeschen
 *  - change:true, value:str  -> verschluesselter Blob zum Speichern
 */
export type CredentialUpdate =
  | { ok: true; change: false }
  | { ok: true; change: true; value: string | null }
  | { ok: false; error: string };

/**
 * Liest die typ-spezifischen Credential-Felder aus dem Request-Body, validiert
 * das Format und liefert den verschluesselten Blob (oder null zum Loeschen).
 */
export function resolveCredentialUpdate(feedType: string, body: Record<string, unknown>): CredentialUpdate {
  if (feedType === 'YOUTUBE') {
    if (!('youtubeApiKey' in body)) return { ok: true, change: false };
    const key = str(body.youtubeApiKey);
    if (key.length === 0) return { ok: true, change: true, value: null }; // entfernen
    if (!YOUTUBE_KEY_RE.test(key)) {
      return { ok: false, error: 'Ungültiger YouTube-API-Key (erwartet: „AIza…", 39 Zeichen).' };
    }
    return { ok: true, change: true, value: encryptCreds({ youtubeApiKey: key }) };
  }

  if (feedType === 'TWITCH') {
    const hasId = 'twitchClientId' in body;
    const hasSecret = 'twitchClientSecret' in body;
    if (!hasId && !hasSecret) return { ok: true, change: false };
    const id = str(body.twitchClientId);
    const secret = str(body.twitchClientSecret);
    if (id.length === 0 && secret.length === 0) return { ok: true, change: true, value: null }; // entfernen
    if (!TWITCH_ID_RE.test(id)) {
      return { ok: false, error: 'Ungültige Twitch-Client-ID (erwartet: 30 Zeichen a–z/0–9).' };
    }
    if (!TWITCH_SECRET_RE.test(secret)) {
      return { ok: false, error: 'Ungültiges Twitch-Client-Secret (erwartet: 30 Zeichen a–z/0–9).' };
    }
    return { ok: true, change: true, value: encryptCreds({ twitchClientId: id, twitchClientSecret: secret }) };
  }

  // Andere Feed-Typen kennen keine per-Feed-Credentials -> ignorieren.
  return { ok: true, change: false };
}

/** Verschluesselt einen Credential-Datensatz zu einem speicherbaren Blob. */
export function encryptCreds(creds: FeedCreds): string {
  return encrypt(JSON.stringify(creds), config.security.encryptionKey);
}

/** Entschluesselt Twitch-Credentials eines Feeds (oder null bei fehlend/ungueltig). */
export function getTwitchCreds(credentialsEnc: string | null | undefined): TwitchCreds | null {
  const c = decryptCreds(credentialsEnc);
  if (c && 'twitchClientId' in c && 'twitchClientSecret' in c && c.twitchClientId && c.twitchClientSecret) {
    return { twitchClientId: c.twitchClientId, twitchClientSecret: c.twitchClientSecret };
  }
  return null;
}

/** Entschluesselt einen YouTube-Key eines Feeds (oder null bei fehlend/ungueltig). */
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
