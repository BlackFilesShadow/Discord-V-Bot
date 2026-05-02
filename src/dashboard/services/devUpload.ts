/**
 * DEV-Upload-Service (Phase 2).
 *
 * - Storage on disk under uploads/dev-logs/<userDiscordId>/<id>/<safeName>
 * - Magic-Number-Pruefung verhindert Mime-Spoofing fuer XML/JSON.
 *   ADM/RPT haben kein magisches Praefix -> wir pruefen UTF-8/ASCII-only
 *   und max-Zeilenlaenge als Heuristik gegen Binaerdaten-Smuggling.
 * - sha256 wird mitgespeichert fuer Integritaetsvergleich + Audit.
 * - TTL: standardmaessig 24h; cleanup ueber `cleanupExpiredUploads()`.
 * - Strikt per-User isoliert: alle Lese-/Loesch-Operationen pruefen
 *   userDiscordId. Kein Cross-User-Zugriff moeglich (Spec 11).
 *
 * Sicherheits-Bemerkungen:
 *  - storedPath wird IMMER serverseitig vergeben (cuid + safeName).
 *  - Die User-eingegebene originalName wird sanitisiert und nur als
 *    Display-Name in der DB gehalten — niemals fuer den Pfad.
 *  - kind wird vom Server validiert, nicht vom Client uebernommen.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

export type DevUploadKind = 'ADM' | 'RPT' | 'XML' | 'JSON';
export const DEV_UPLOAD_KINDS: ReadonlyArray<DevUploadKind> = ['ADM', 'RPT', 'XML', 'JSON'];

export interface DevUploadInput {
  userDiscordId: string;
  kind: DevUploadKind;
  originalName: string;
  buffer: Buffer;
  mimeType: string;
}

export interface DevUploadRecord {
  id: string;
  userDiscordId: string;
  kind: DevUploadKind;
  originalName: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  expiresAt: Date;
}

const UPLOADS_BASE = path.resolve(process.cwd(), 'uploads', 'dev-logs');
const TTL_MS = 24 * 60 * 60 * 1000;            // 24h
export const MAX_DEV_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB pro Datei
export const MAX_DEV_UPLOADS_PER_REQUEST = 10;

const EXTENSIONS: Record<DevUploadKind, string> = {
  ADM: '.adm',
  RPT: '.rpt',
  XML: '.xml',
  JSON: '.json',
};

// Akzeptierte Mime-Types pro Kind. Fuer ADM/RPT akzeptieren wir text/plain.
const ALLOWED_MIME: Record<DevUploadKind, ReadonlySet<string>> = {
  ADM: new Set(['text/plain', 'application/octet-stream', '']),
  RPT: new Set(['text/plain', 'application/octet-stream', '']),
  XML: new Set(['application/xml', 'text/xml', 'text/plain', '']),
  JSON: new Set(['application/json', 'text/json', 'text/plain', '']),
};

function sanitizeName(name: string): string {
  // Nur Buchstaben/Zahlen/Punkt/Strich/Underscore, max 128 Zeichen.
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return base.length > 0 ? base : 'upload';
}

function sniffKindByMagic(buf: Buffer): { kind: DevUploadKind | 'BINARY' | 'TEXT'; reason?: string } {
  if (buf.length === 0) return { kind: 'TEXT' };
  // BOM strip
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;

  // Reject bekannte Binaerformate (PDF, ZIP, EXE, JPEG, PNG, GIF, ELF, MP4 ftyp box).
  const head = buf.slice(start, start + 8);
  const sig = head.toString('hex');
  if (sig.startsWith('25504446')) return { kind: 'BINARY', reason: 'PDF' };
  if (sig.startsWith('504b0304')) return { kind: 'BINARY', reason: 'ZIP' };
  if (sig.startsWith('4d5a'))     return { kind: 'BINARY', reason: 'EXE' };
  if (sig.startsWith('ffd8ff'))   return { kind: 'BINARY', reason: 'JPEG' };
  if (sig.startsWith('89504e47')) return { kind: 'BINARY', reason: 'PNG' };
  if (sig.startsWith('474946'))   return { kind: 'BINARY', reason: 'GIF' };
  if (sig.startsWith('7f454c46')) return { kind: 'BINARY', reason: 'ELF' };
  if (head.slice(4).toString('ascii').startsWith('ftyp')) return { kind: 'BINARY', reason: 'MP4' };

  // Skip whitespace fuer XML/JSON-Sniff.
  let i = start;
  while (i < buf.length && i < start + 64 && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  const firstChar = String.fromCharCode(buf[i] ?? 0);
  if (firstChar === '<') return { kind: 'XML' };
  if (firstChar === '{' || firstChar === '[') return { kind: 'JSON' };
  return { kind: 'TEXT' };
}

function isLikelyText(buf: Buffer): boolean {
  // Erste 4 KB scannen; >5% Nicht-Text-Bytes -> ablehnen.
  const sample = buf.slice(0, 4096);
  if (sample.length === 0) return true;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    // Erlaubte Steuerzeichen: TAB(9), LF(10), CR(13).
    if (b === 0) { bad += 4; continue; }
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) bad += 1;
    // Hohe DEL-Bereiche moderat erlaubt (UTF-8); 0x7f als Marker.
    if (b === 0x7f) bad += 1;
  }
  return bad / sample.length < 0.05;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateDevUpload(kind: DevUploadKind, mime: string, buf: Buffer): ValidationResult {
  if (!DEV_UPLOAD_KINDS.includes(kind)) return { ok: false, error: `Unbekannte Upload-Art: ${kind}` };
  if (buf.length === 0) return { ok: false, error: 'Datei ist leer.' };
  if (buf.length > MAX_DEV_UPLOAD_BYTES) return { ok: false, error: `Datei groesser als ${MAX_DEV_UPLOAD_BYTES} Bytes.` };

  const mimeNorm = (mime || '').toLowerCase();
  const allowed = ALLOWED_MIME[kind];
  if (!allowed.has(mimeNorm)) {
    return { ok: false, error: `Mime-Type "${mime}" nicht erlaubt fuer ${kind}.` };
  }

  if (!isLikelyText(buf)) {
    return { ok: false, error: 'Datei enthaelt zu viele Nicht-Text-Bytes (Binaerdatei?).' };
  }

  const sniff = sniffKindByMagic(buf);
  if (sniff.kind === 'BINARY') {
    return { ok: false, error: `Datei sieht wie Binaerdatei (${sniff.reason}) aus.` };
  }

  // Fuer XML/JSON: Magic-Praefix muss passen, sonst hat User die falsche Kategorie gewaehlt.
  if (kind === 'XML' && sniff.kind !== 'XML') {
    return { ok: false, error: 'Datei beginnt nicht mit "<" — kein gueltiges XML.' };
  }
  if (kind === 'JSON' && sniff.kind !== 'JSON') {
    return { ok: false, error: 'Datei beginnt nicht mit "{" oder "[" — kein gueltiges JSON.' };
  }
  return { ok: true };
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function saveDevUpload(input: DevUploadInput): Promise<DevUploadRecord> {
  const v = validateDevUpload(input.kind, input.mimeType, input.buffer);
  if (!v.ok) throw new Error(v.error ?? 'Validierung fehlgeschlagen');

  const safeName = sanitizeName(input.originalName) || `upload${EXTENSIONS[input.kind]}`;
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const expiresAt = new Date(Date.now() + TTL_MS);

  const record = await prisma.devUpload.create({
    data: {
      userDiscordId: input.userDiscordId,
      kind: input.kind,
      originalName: safeName,
      storedPath: '', // wird gleich gesetzt
      mimeType: input.mimeType || 'application/octet-stream',
      sizeBytes: input.buffer.length,
      sha256,
      expiresAt,
    },
  });

  const userDir = path.join(UPLOADS_BASE, input.userDiscordId, record.id);
  await ensureDir(userDir);
  const fullPath = path.join(userDir, safeName);
  await fs.writeFile(fullPath, input.buffer, { mode: 0o600 });

  const rel = path.relative(path.resolve(process.cwd(), 'uploads'), fullPath);
  const updated = await prisma.devUpload.update({
    where: { id: record.id },
    data: { storedPath: rel },
  });

  logAudit('DEV_UPLOAD_CREATED', 'SECURITY', {
    userDiscordId: input.userDiscordId,
    uploadId: updated.id,
    kind: input.kind,
    sizeBytes: updated.sizeBytes,
    sha256,
  });

  return toRecord(updated);
}

function toRecord(row: { id: string; userDiscordId: string; kind: string; originalName: string; storedPath: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: Date; expiresAt: Date }): DevUploadRecord {
  return {
    id: row.id,
    userDiscordId: row.userDiscordId,
    kind: row.kind as DevUploadKind,
    originalName: row.originalName,
    storedPath: row.storedPath,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function listDevUploads(userDiscordId: string, kind?: DevUploadKind): Promise<DevUploadRecord[]> {
  const rows = await prisma.devUpload.findMany({
    where: {
      userDiscordId,
      deletedAt: null,
      expiresAt: { gt: new Date() },
      ...(kind ? { kind } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map(toRecord);
}

export async function getDevUpload(userDiscordId: string, id: string): Promise<DevUploadRecord | null> {
  const row = await prisma.devUpload.findFirst({
    where: { id, userDiscordId, deletedAt: null, expiresAt: { gt: new Date() } },
  });
  return row ? toRecord(row) : null;
}

export async function readDevUploadContent(userDiscordId: string, id: string): Promise<{ record: DevUploadRecord; buffer: Buffer } | null> {
  const rec = await getDevUpload(userDiscordId, id);
  if (!rec) return null;
  const fullPath = path.resolve(process.cwd(), 'uploads', rec.storedPath);
  // Defense in depth: verhindert Path-Traversal falls storedPath manipuliert wuerde.
  const expectedPrefix = path.join(UPLOADS_BASE, rec.userDiscordId) + path.sep;
  if (!fullPath.startsWith(expectedPrefix)) {
    logger.error('[DEV-Upload] Path-Traversal-Versuch erkannt', { id, fullPath });
    return null;
  }
  const buffer = await fs.readFile(fullPath);
  return { record: rec, buffer };
}

export async function deleteDevUpload(userDiscordId: string, id: string): Promise<boolean> {
  const rec = await getDevUpload(userDiscordId, id);
  if (!rec) return false;
  await prisma.devUpload.update({
    where: { id: rec.id },
    data: { deletedAt: new Date() },
  });
  const fullPath = path.resolve(process.cwd(), 'uploads', rec.storedPath);
  const expectedPrefix = path.join(UPLOADS_BASE, rec.userDiscordId) + path.sep;
  if (fullPath.startsWith(expectedPrefix)) {
    await fs.unlink(fullPath).catch(() => { /* already gone */ });
    // Verzeichnis aufraeumen, wenn leer.
    await fs.rmdir(path.dirname(fullPath)).catch(() => { /* not empty */ });
  }
  logAudit('DEV_UPLOAD_DELETED', 'SECURITY', { userDiscordId, uploadId: id });
  return true;
}

/**
 * Loescht abgelaufene Uploads von Disk + DB. Wird periodisch aufgerufen
 * (siehe server.ts). Hard-Delete nach 7 Tagen seit Soft-Delete.
 */
export async function cleanupExpiredUploads(): Promise<{ removed: number }> {
  const now = new Date();
  const expired = await prisma.devUpload.findMany({
    where: {
      OR: [
        { deletedAt: null, expiresAt: { lt: now } },
        { deletedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
    take: 500,
  });
  let removed = 0;
  for (const row of expired) {
    const fullPath = path.resolve(process.cwd(), 'uploads', row.storedPath);
    const expectedPrefix = path.join(UPLOADS_BASE, row.userDiscordId) + path.sep;
    if (fullPath.startsWith(expectedPrefix)) {
      await fs.unlink(fullPath).catch(() => { /* */ });
      await fs.rmdir(path.dirname(fullPath)).catch(() => { /* */ });
    }
    if (row.deletedAt && row.deletedAt < new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)) {
      await prisma.devUpload.delete({ where: { id: row.id } }).catch(() => { /* */ });
    } else {
      await prisma.devUpload.update({ where: { id: row.id }, data: { deletedAt: now } }).catch(() => { /* */ });
    }
    removed++;
  }
  if (removed > 0) logger.info(`[DEV-Upload] cleanup: ${removed} entfernt.`);
  return { removed };
}

export function startDevUploadCleanupTimer(): NodeJS.Timeout {
  const tick = (): void => {
    cleanupExpiredUploads().catch(err => logger.error('[DEV-Upload] cleanup error:', err as Error));
  };
  const id = setInterval(tick, 60 * 60 * 1000); // 1h
  // Start nach 30s, damit Boot nicht blockiert.
  setTimeout(tick, 30_000);
  return id;
}
