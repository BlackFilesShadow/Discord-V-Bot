import { randomUUID } from 'node:crypto';
import { Attachment } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { safeAxiosGet } from '../../utils/ssrf';

/**
 * Persistente Speicherung von Discord-Attachments und externer Media im
 * uploads-Volume. Jede externe URL wird über den zentralen SSRF-Client geladen;
 * Größe, MIME und Magic Bytes werden nach dem Download erneut geprüft.
 */

export const MEDIA_BASE_DIR = path.resolve(process.cwd(), 'uploads', 'media');
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov)$/i;
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime))$/i;

type MediaKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'mp4' | 'webm';
type MediaScope = 'triggers' | 'welcome';

export interface SavedMedia {
  ok: boolean;
  message: string;
  localPath?: string;
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
}

function extFromName(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? `.${m[1].toLowerCase()}` : '';
}

function detectMediaKind(buffer: Buffer): MediaKind | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 6) {
    const sig = buffer.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('hex').toLowerCase() === '1a45dfa3') return 'webm';
  if (buffer.length >= 12) {
    const box = buffer.subarray(4, 8).toString('ascii');
    if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'mp4';
  }
  return null;
}

function extMatchesKind(ext: string, kind: MediaKind): boolean {
  if (kind === 'jpeg') return ext === '.jpg' || ext === '.jpeg';
  if (kind === 'mp4') return ext === '.mp4' || ext === '.mov';
  return ext === `.${kind}`;
}

function canonicalExt(kind: MediaKind): string {
  if (kind === 'jpeg') return '.jpg';
  return `.${kind}`;
}

function mimeMatchesKind(rawMime: string | null | undefined, kind: MediaKind): boolean {
  if (!rawMime) return true;
  const mime = rawMime.split(';', 1)[0].trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream') return true;
  if (kind === 'jpeg') return mime === 'image/jpeg' || mime === 'image/jpg';
  if (kind === 'mp4') return mime === 'video/mp4' || mime === 'video/quicktime';
  return mime === (kind === 'png' || kind === 'gif' || kind === 'webp' ? `image/${kind}` : 'video/webm');
}

async function persistMedia(
  buffer: Buffer,
  scope: MediaScope,
  guildId: string,
  key: string,
  ext: string,
): Promise<SavedMedia> {
  const safeGuild = sanitize(guildId);
  const safeKey = sanitize(key);
  if (!safeGuild || !safeKey) return { ok: false, message: '❌ Ungültiger Media-Speicherschlüssel.' };

  const dir = path.join(MEDIA_BASE_DIR, scope, safeGuild);
  // Jede Ingestion bekommt einen neuen Pfad. So bleibt die bisher aktive Datei
  // bis zum erfolgreichen DB-Schreibvorgang unangetastet; erst der Aufrufer
  // entfernt sie nach erfolgreichem Commit.
  const fullPath = path.join(dir, `${safeKey}_${randomUUID()}${ext}`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o750 });
    await fs.writeFile(fullPath, buffer, { mode: 0o640 });
  } catch (err) {
    logger.error('Media-Speichern Fehler:', err);
    return { ok: false, message: `❌ Speichern fehlgeschlagen: ${String(err).slice(0, 200)}` };
  }

  return { ok: true, message: '✅ Media gespeichert.', localPath: fullPath };
}

/**
 * Lädt das Discord-Attachment herunter und speichert es persistent.
 * Pfad-Schema: uploads/media/<scope>/<guildId>/<key>_<uuid>.<ext>
 */
export async function saveAttachment(
  attachment: Attachment,
  scope: MediaScope,
  guildId: string,
  key: string,
): Promise<SavedMedia> {
  const ext = extFromName(attachment.name || '');
  if (!ALLOWED_EXT.test(attachment.name || '')) {
    return { ok: false, message: '❌ Nur JPG/PNG/GIF/WEBP/MP4/WEBM/MOV erlaubt.' };
  }
  if (attachment.contentType && !ALLOWED_MIME.test(attachment.contentType)) {
    return { ok: false, message: `❌ Unerlaubter MIME-Type: ${attachment.contentType}` };
  }
  if (attachment.size > MAX_MEDIA_BYTES) {
    return { ok: false, message: `❌ Datei zu groß (${(attachment.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
  }

  let buffer: Buffer;
  let responseContentType: string | undefined;
  try {
    const res = await safeAxiosGet<ArrayBuffer>(attachment.url, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_MEDIA_BYTES,
      maxBodyLength: MAX_MEDIA_BYTES,
    });
    buffer = Buffer.from(res.data);
    const header = res.headers?.['content-type'];
    responseContentType = typeof header === 'string' ? header : undefined;
    if (buffer.length > MAX_MEDIA_BYTES) {
      return { ok: false, message: `❌ Datei zu groß (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
    }
  } catch (err) {
    logger.error('Media-Download Fehler:', err);
    return { ok: false, message: `❌ Download-Fehler: ${String(err).slice(0, 200)}` };
  }

  const kind = detectMediaKind(buffer);
  if (!kind) return { ok: false, message: '❌ Dateiinhalt ist kein unterstütztes Bild/Video.' };
  if (!extMatchesKind(ext, kind)) return { ok: false, message: '❌ Dateiendung und Dateiinhalt stimmen nicht überein.' };
  if (!mimeMatchesKind(attachment.contentType, kind) || !mimeMatchesKind(responseContentType, kind)) {
    return { ok: false, message: '❌ MIME-Type und Dateiinhalt stimmen nicht überein.' };
  }

  return persistMedia(buffer, scope, guildId, key, ext);
}

/**
 * Materialisiert nutzergesteuerte Remote-Media. Anders als beim Discord-
 * Attachment wird keiner URL-Endung vertraut: der lokale Dateityp wird allein
 * aus den validierten Magic Bytes abgeleitet.
 */
export async function saveRemoteMedia(
  rawUrl: string,
  scope: MediaScope,
  guildId: string,
  key: string,
): Promise<SavedMedia> {
  let buffer: Buffer;
  let responseContentType: string | undefined;
  try {
    const res = await safeAxiosGet<ArrayBuffer>(rawUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_MEDIA_BYTES,
      maxBodyLength: MAX_MEDIA_BYTES,
    });
    buffer = Buffer.from(res.data);
    const header = res.headers?.['content-type'];
    responseContentType = typeof header === 'string' ? header : undefined;
    if (buffer.length > MAX_MEDIA_BYTES) {
      return { ok: false, message: `❌ Datei zu groß (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
    }
  } catch (err) {
    logger.error('Remote-Media-Download Fehler:', err);
    return { ok: false, message: `❌ Download-Fehler: ${String(err).slice(0, 200)}` };
  }

  const kind = detectMediaKind(buffer);
  if (!kind) return { ok: false, message: '❌ Dateiinhalt ist kein unterstütztes Bild/Video.' };
  if (!mimeMatchesKind(responseContentType, kind)) {
    return { ok: false, message: '❌ MIME-Type und Dateiinhalt stimmen nicht überein.' };
  }

  return persistMedia(buffer, scope, guildId, key, canonicalExt(kind));
}

function isManagedMediaPath(filePath: string): boolean {
  const base = path.resolve(MEDIA_BASE_DIR);
  const candidate = path.resolve(filePath);
  const rel = path.relative(base, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Löscht eine zuvor gespeicherte Mediendatei (best effort). */
export async function deleteMediaIfLocal(filePath?: string | null): Promise<void> {
  if (!filePath || !isManagedMediaPath(filePath)) return;
  try {
    await fs.unlink(path.resolve(filePath));
  } catch {
    /* ignore */
  }
}
