/**
 * Storage-Helper für den Nitrado-Mirror.
 *
 * - Inhaltsadressiert: Datei-Inhalte landen unter
 *   uploads/nitrado-mirror/<connId>/<sha256> (gleicher Hash → einmal abgelegt).
 * - Strikt nur lokale FS-Schreibvorgänge unter UPLOADS_BASE.
 * - Nichts wird an Nitrado zurückgespielt.
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export const UPLOADS_BASE = path.resolve(process.cwd(), 'uploads', 'nitrado-mirror');

/** Maximale Dateigröße, die noch komplett abgelegt wird. Größere → nur Meta. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Inline-Text (in DB-Spalte contentText) bis zu dieser Größe. */
export const INLINE_TEXT_BYTES = 256 * 1024; // 256 KB

/** Magic-Byte / Heuristik für Text. */
export function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  // Sample bis 4 KB: keine NUL-Bytes, hoher Anteil druckbarer Zeichen
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) return false;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  }
  return printable / sample.length > 0.85;
}

export function guessMimeByExt(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'xml': return 'application/xml';
    case 'json': return 'application/json';
    case 'cfg':
    case 'ini':
    case 'c':
    case 'h':
    case 'log':
    case 'adm':
    case 'rpt':
    case 'txt':
      return 'text/plain';
    case 'html': return 'text/html';
    case 'js': return 'application/javascript';
    case 'pbo': return 'application/octet-stream';
    case 'bikey': return 'application/octet-stream';
    case 'dll': return 'application/octet-stream';
    case 'exe': return 'application/octet-stream';
    case 'zip': return 'application/zip';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Schreibt Inhalt inhaltsadressiert. Wenn Datei mit gleichem Hash schon
 * existiert, wird nichts geschrieben (Idempotenz, Speicher-Sparsamkeit).
 * Liefert den relativen Pfad unter uploads/.
 */
export async function storeBlob(connId: string, hash: string, buf: Buffer): Promise<string> {
  const dir = path.join(UPLOADS_BASE, connId, hash.slice(0, 2));
  const file = path.join(dir, hash);
  try {
    await fs.access(file);
    return path.relative(path.resolve(process.cwd(), 'uploads'), file);
  } catch { /* not exists, write */ }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, buf, { mode: 0o600 });
  return path.relative(path.resolve(process.cwd(), 'uploads'), file);
}

export async function readBlob(relPath: string): Promise<Buffer> {
  const full = path.resolve(process.cwd(), 'uploads', relPath);
  // Pfadausbruch verhindern
  const base = path.resolve(process.cwd(), 'uploads') + path.sep;
  if (!full.startsWith(base)) throw new Error('Pfadausbruch');
  return fs.readFile(full);
}
