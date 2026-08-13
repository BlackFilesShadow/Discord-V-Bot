import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config';

export const MAX_TRANSLATED_POST_IMAGE_BYTES = 8 * 1024 * 1024;
const PREFIX = 'upload:translated-posts/';
const ROOT = path.join(config.upload.dir, 'translated-posts');

type ImageKind = { ext: 'png' | 'jpg' | 'gif' | 'webp'; mime: string };

function detectImageKind(buffer: Buffer): ImageKind | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buffer.length >= 6) { const s = buffer.subarray(0, 6).toString('ascii'); if (s === 'GIF87a' || s === 'GIF89a') return { ext: 'gif', mime: 'image/gif' }; }
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export function validateTranslatedPostImage(file: { buffer: Buffer; mimetype?: string }): { ok: true; kind: ImageKind } | { ok: false; error: string } {
  if (!file.buffer?.length) return { ok: false, error: 'Bilddatei ist leer.' };
  if (file.buffer.length > MAX_TRANSLATED_POST_IMAGE_BYTES) return { ok: false, error: 'Bild ist größer als 8 MB.' };
  const kind = detectImageKind(file.buffer);
  if (!kind) return { ok: false, error: 'Nur PNG, JPEG, GIF oder WebP sind erlaubt.' };
  const mime = (file.mimetype ?? '').toLowerCase();
  if (mime && mime !== 'application/octet-stream' && mime !== kind.mime && !(kind.mime === 'image/jpeg' && mime === 'image/jpg')) return { ok: false, error: 'Dateityp und Bildinhalt stimmen nicht überein.' };
  return { ok: true, kind };
}

function safeManagedPath(ref: string): string | null {
  if (!ref.startsWith(PREFIX)) return null;
  const rel = ref.slice('upload:'.length).replace(/\\/g, '/');
  if (!/^translated-posts\/\d{17,20}\/[0-9a-f-]{36}\.(?:png|jpg|gif|webp)$/i.test(rel)) return null;
  const full = path.resolve(config.upload.dir, rel);
  const root = path.resolve(ROOT) + path.sep;
  return full.startsWith(root) ? full : null;
}

export function isManagedTranslatedPostImage(ref: string | null | undefined): boolean { return typeof ref === 'string' && safeManagedPath(ref) !== null; }

export async function saveTranslatedPostImage(guildId: string, file: { buffer: Buffer; mimetype?: string }): Promise<string> {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('Ungültige Guild-ID für Bildspeicherung.');
  const validation = validateTranslatedPostImage(file);
  if (!validation.ok) throw new Error(validation.error);
  const dir = path.join(ROOT, guildId);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const name = `${randomUUID()}.${validation.kind.ext}`;
  const full = path.join(dir, name);
  await fs.writeFile(full, file.buffer, { mode: 0o640 });
  return `${PREFIX}${guildId}/${name}`;
}

export function resolveTranslatedPostImage(ref: string | null | undefined): { path: string; name: string } | null {
  if (!ref) return null;
  const full = safeManagedPath(ref);
  return full ? { path: full, name: path.basename(full) } : null;
}

export async function removeTranslatedPostImage(ref: string | null | undefined): Promise<void> {
  if (!ref) return;
  const full = safeManagedPath(ref);
  if (full) await fs.unlink(full).catch(() => undefined);
}
