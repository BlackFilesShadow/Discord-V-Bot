import { Attachment } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../utils/logger';

/**
 * Persistente Speicherung von Discord-Attachments im uploads-Volume.
 * Discord-CDN-URLs verfallen seit Sept 2023 nach ~24h, daher lokale Kopie.
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
 * L\u00e4dt das Discord-Attachment herunter und speichert es persistent.
 * Pfad-Schema: uploads/media/<scope>/<guildId>/<key>.<ext>
 */
export async function saveAttachment(
  attachment: Attachment,
  scope: 'triggers' | 'welcome',
  guildId: string,
  key: string,
): Promise<SavedMedia> {
  // Validierung
  const ext = extFromName(attachment.name || '');
  if (!ALLOWED_EXT.test(attachment.name || '')) {
    return { ok: false, message: '\u274c Nur JPG/PNG/GIF/WEBP/MP4/WEBM/MOV erlaubt.' };
  }
  if (attachment.contentType && !ALLOWED_MIME.test(attachment.contentType)) {
    return { ok: false, message: `\u274c Unerlaubter MIME-Type: ${attachment.contentType}` };
  }
  if (attachment.size > MAX_MEDIA_BYTES) {
    return { ok: false, message: `\u274c Datei zu gro\u00df (${(attachment.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).` };
  }

  // Download
  let buffer: Buffer;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      return { ok: false, message: `\u274c Download fehlgeschlagen (HTTP ${res.status}).` };
    }
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
  } catch (err) {
    logger.error('Media-Download Fehler:', err);
    return { ok: false, message: `\u274c Download-Fehler: ${String(err).slice(0, 200)}` };
  }

  // Speichern
  const dir = path.join(MEDIA_BASE_DIR, scope, sanitize(guildId));
  await fs.mkdir(dir, { recursive: true });
  const filename = `${sanitize(key)}${ext}`;
  const fullPath = path.join(dir, filename);
  try {
    await fs.writeFile(fullPath, buffer);
  } catch (err) {
    logger.error('Media-Speichern Fehler:', err);
    return { ok: false, message: `\u274c Speichern fehlgeschlagen: ${String(err).slice(0, 200)}` };
  }

  return { ok: true, message: '\u2705 Media gespeichert.', localPath: fullPath };
}

/**
 * L\u00f6scht eine zuvor gespeicherte Mediendatei (best effort).
 */
export async function deleteMediaIfLocal(filePath?: string | null): Promise<void> {
  if (!filePath) return;
  if (!filePath.startsWith(MEDIA_BASE_DIR)) return; // nur eigene Dateien
  try {
    await fs.unlink(filePath);
  } catch {
    /* ignore */
  }
}
