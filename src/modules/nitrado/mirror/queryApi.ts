/**
 * Mirror Query-API — die einheitliche Lese-Schnittstelle, über die der
 * Bot, das Dashboard und die KI/RAG-Schicht Snapshot-Daten abfragen.
 *
 * Strikt READ-ONLY (DB + lokales FS).
 */

import prisma from '../../../database/prisma';
import { readBlob } from './storage';

export interface SnapshotSummary {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED';
  totalFiles: number;
  totalDirs: number;
  totalBytes: bigint;
  storedBytes: bigint;
  oversizeFiles: number;
  errorCount: number;
}

export async function listSnapshots(guildId: string, nitradoConnId: string): Promise<SnapshotSummary[]> {
  const rows = await prisma.nitradoSnapshot.findMany({
    where: { guildId, nitradoConnId },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, startedAt: true, finishedAt: true, status: true,
      totalFiles: true, totalDirs: true, totalBytes: true,
      storedBytes: true, oversizeFiles: true, errorCount: true,
    },
  });
  return rows;
}

/** Letzter erfolgreich abgeschlossener (OK oder PARTIAL) Snapshot. */
export async function getLatestSnapshot(guildId: string, nitradoConnId: string): Promise<SnapshotSummary | null> {
  const row = await prisma.nitradoSnapshot.findFirst({
    where: { guildId, nitradoConnId, status: { in: ['OK', 'PARTIAL'] } },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true, startedAt: true, finishedAt: true, status: true,
      totalFiles: true, totalDirs: true, totalBytes: true,
      storedBytes: true, oversizeFiles: true, errorCount: true,
    },
  });
  return row;
}

export async function getSettings(snapshotId: string): Promise<{ serviceMeta: unknown; gameserver: unknown } | null> {
  const s = await prisma.nitradoSnapshot.findUnique({
    where: { id: snapshotId },
    select: { serviceMetaJson: true, settingsJson: true },
  });
  if (!s) return null;
  return { serviceMeta: s.serviceMetaJson, gameserver: s.settingsJson };
}

export interface MirrorFileMeta {
  id: string;
  path: string;
  name: string;
  parentDir: string;
  isDir: boolean;
  sizeBytes: bigint;
  modifiedAt: Date | null;
  sha256: string | null;
  mimeGuess: string | null;
  isText: boolean;
  oversize: boolean;
  errorMsg: string | null;
  hasContent: boolean;
}

export async function listFiles(snapshotId: string, parentDir = '/'): Promise<MirrorFileMeta[]> {
  const rows = await prisma.nitradoSnapshotFile.findMany({
    where: { snapshotId, parentDir },
    orderBy: [{ isDir: 'desc' }, { name: 'asc' }],
    select: {
      id: true, path: true, name: true, parentDir: true, isDir: true,
      sizeBytes: true, modifiedAt: true, sha256: true, mimeGuess: true,
      isText: true, oversize: true, errorMsg: true, storedPath: true, contentText: true,
    },
  });
  return rows.map(r => ({
    id: r.id, path: r.path, name: r.name, parentDir: r.parentDir, isDir: r.isDir,
    sizeBytes: r.sizeBytes, modifiedAt: r.modifiedAt, sha256: r.sha256,
    mimeGuess: r.mimeGuess, isText: r.isText, oversize: r.oversize, errorMsg: r.errorMsg,
    hasContent: !!(r.storedPath || r.contentText),
  }));
}

export async function findFiles(snapshotId: string, nameContains: string, limit = 100): Promise<MirrorFileMeta[]> {
  const rows = await prisma.nitradoSnapshotFile.findMany({
    where: { snapshotId, isDir: false, name: { contains: nameContains, mode: 'insensitive' } },
    orderBy: [{ name: 'asc' }],
    take: Math.min(limit, 500),
    select: {
      id: true, path: true, name: true, parentDir: true, isDir: true,
      sizeBytes: true, modifiedAt: true, sha256: true, mimeGuess: true,
      isText: true, oversize: true, errorMsg: true, storedPath: true, contentText: true,
    },
  });
  return rows.map(r => ({
    id: r.id, path: r.path, name: r.name, parentDir: r.parentDir, isDir: r.isDir,
    sizeBytes: r.sizeBytes, modifiedAt: r.modifiedAt, sha256: r.sha256,
    mimeGuess: r.mimeGuess, isText: r.isText, oversize: r.oversize, errorMsg: r.errorMsg,
    hasContent: !!(r.storedPath || r.contentText),
  }));
}

export interface MirrorFileContent {
  meta: MirrorFileMeta;
  content: Buffer | null;
  textContent: string | null;
}

export async function getFile(snapshotId: string, path: string): Promise<MirrorFileContent | null> {
  const r = await prisma.nitradoSnapshotFile.findFirst({
    where: { snapshotId, path },
    select: {
      id: true, path: true, name: true, parentDir: true, isDir: true,
      sizeBytes: true, modifiedAt: true, sha256: true, mimeGuess: true,
      isText: true, oversize: true, errorMsg: true, storedPath: true, contentText: true,
    },
  });
  if (!r) return null;
  const meta: MirrorFileMeta = {
    id: r.id, path: r.path, name: r.name, parentDir: r.parentDir, isDir: r.isDir,
    sizeBytes: r.sizeBytes, modifiedAt: r.modifiedAt, sha256: r.sha256,
    mimeGuess: r.mimeGuess, isText: r.isText, oversize: r.oversize, errorMsg: r.errorMsg,
    hasContent: !!(r.storedPath || r.contentText),
  };
  if (r.contentText !== null && r.contentText !== undefined) {
    return { meta, content: Buffer.from(r.contentText, 'utf8'), textContent: r.contentText };
  }
  if (r.storedPath) {
    const buf = await readBlob(r.storedPath);
    return { meta, content: buf, textContent: r.isText ? buf.toString('utf8') : null };
  }
  return { meta, content: null, textContent: null };
}

/**
 * Liest einen Wert aus einer einfachen `key = value;`-Konfig (z.B. serverDZ.cfg).
 * Quote-Stripping inklusive. Für komplexe Strukturen besser den Inhalt
 * holen und gezielt parsen.
 */
export async function getCfgValue(snapshotId: string, filePath: string, key: string): Promise<string | null> {
  const f = await getFile(snapshotId, filePath);
  if (!f?.textContent) return null;
  const lines = f.textContent.split(/\r?\n/);
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*=\\s*(.*?)\\s*;?\\s*(?://.*)?$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}
