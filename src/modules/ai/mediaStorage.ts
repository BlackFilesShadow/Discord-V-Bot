import { Attachment } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { safeAxiosGet } from '../../utils/ssrf';

/**
 * Persistente Speicherung von Discord-Attachments im uploads-Volume.
 * Discord-CDN-URLs verfallen, daher lokale Kopie. Auch eine von Discord
 * gelieferte URL wird wie externe Eingabe behandelt: DNS/Redirects werden vom
 * zentralen SSRF-Client erneut validiert und die tatsaechliche Responsegroesse
 * wird nach dem Download nochmals geprueft.
 */

export const MEDIA_BASE_DIR = path.resolve(process.cwd(), 'uploads', 'media');
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov)$/i;
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime))$/i;

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

/**
 * Lädt das Discord-Attachment herunter und speichert es persistent.
 * Pfad-Schema: uploads/media/<scope>/<guildId>/<key>.<ext>
 */
export async function saveAttachment(
  attachment: Attachment,
  scope: 'triggers' | 'welcome',
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
  try {
    const res = await safeAxiosGet<ArrayBuffer>(attachment.url, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: MAX_MEDIA_BYTES,
      maxBodyLength: MAX_MEDIA_BYTES,
    });
    buffer = Buffer.from(res.data);
    if (buffer.length > MAX_MEDIA_BYTES) {
      return { ok: false, message: `❌ Datei zu groß (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
    }
  } catch (err) {
    logger.error('Media-Download Fehler:', err);
    return { ok: false, message: `❌ Download-Fehler: ${String(err).slice(0, 200)}` };
  }

  const dir = path.join(MEDIA_BASE_DIR, scope, sanitize(guildId));
  await fs.mkdir(dir, { recursive: true });
  const filename = `${sanitize(key)}${ext}`;
  const fullPath = path.join(dir, filename);
  try {
    await fs.writeFile(fullPath, buffer);
  } catch (err) {
    logger.error('Media-Speichern Fehler:', err);
    return { ok: false, message: `❌ Speichern fehlgeschlagen: ${String(err).slice(0, 200)}` };
  }

  return { ok: true, message: '✅ Media gespeichert.', localPath: fullPath };
}

/** Löscht eine zuvor gespeicherte Mediendatei (best effort). */
export async function deleteMediaIfLocal(filePath?: string | null): Promise<void> {
  if (!filePath) return;
  if (!filePath.startsWith(MEDIA_BASE_DIR)) return;
  try {
    await fs.unlink(filePath);
  } catch {
    /* ignore */
  }
}
