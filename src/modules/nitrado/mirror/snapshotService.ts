/**
 * SnapshotService — One-Shot-Voll-Spiegel einer NitradoConnection.
 *
 * READ-ONLY-Garantie:
 *   - Verwendet ausschliesslich NitradoReadClient (nur GET).
 *   - Kein Import von NitradoClient oder anderer schreibender Helfer.
 *   - Schreibt nur lokal in DB + uploads/nitrado-mirror.
 *
 * Hartes Tabu (per Test abgesichert):
 *   - keine Strings POST|PUT|DELETE|PATCH in dieser Datei
 *   - keine Importe, die schreibende Methoden exportieren
 */

import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { decrypt } from '../../../utils/security';
import { logger } from '../../../utils/logger';
import { NitradoReadClient, type FileEntry } from './readClient';
import {
  MAX_FILE_BYTES,
  INLINE_TEXT_BYTES,
  guessMimeByExt,
  looksLikeText,
  sha256,
  storeBlob,
} from './storage';

export interface SnapshotProgress {
  snapshotId: string;
  status: 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED';
  totalFiles: number;
  totalDirs: number;
  totalBytes: bigint;
  storedBytes: bigint;
  oversizeFiles: number;
  errorCount: number;
  lastError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

interface SnapshotOptions {
  guildId: string;
  nitradoConnId: string;
  triggeredBy: string;
}

const ROOTS = ['/']; // Nitrado liefert ab Server-Root rekursiv durchgehbar

/**
 * Startet einen Voll-Snapshot. Läuft asynchron im Hintergrund; gibt
 * sofort die snapshotId zurück.
 */
export async function startSnapshot(opts: SnapshotOptions): Promise<{ snapshotId: string }> {
  const conn = await prisma.nitradoConnection.findFirst({
    where: { id: opts.nitradoConnId, guildId: opts.guildId },
    select: { id: true, encryptedToken: true, serviceId: true, nitradoServerId: true, status: true, guildId: true },
  });
  if (!conn) throw new Error('NitradoConnection nicht gefunden.');
  // NIT-012: serviceId ist das Mirror-Feld, nitradoServerId das kanonische —
  // Fallback, solange Altbestand noch nicht gespiegelt ist.
  const serviceId = conn.serviceId ?? conn.nitradoServerId;
  if (!serviceId) throw new Error('NitradoConnection hat keine Service-ID hinterlegt.');

  const snap = await prisma.nitradoSnapshot.create({
    data: {
      guildId: opts.guildId,
      nitradoConnId: opts.nitradoConnId,
      serviceId,
      status: 'RUNNING',
      triggeredBy: opts.triggeredBy,
    },
    select: { id: true },
  });

  // Hintergrund-Lauf — wir warten nicht.
  void runSnapshot(snap.id, conn.guildId, opts.nitradoConnId, serviceId, conn.encryptedToken)
    .catch(err => {
      logger.error('[NitradoMirror] Snapshot abgebrochen', err as Error);
    });

  return { snapshotId: snap.id };
}

async function runSnapshot(
  snapshotId: string,
  guildId: string,
  connId: string,
  serviceId: string,
  encryptedToken: string,
): Promise<void> {
  const token = decrypt(encryptedToken, config.security.encryptionKey);
  const client = new NitradoReadClient(token);

  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0n;
  let storedBytes = 0n;
  let oversizeFiles = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let status: 'OK' | 'PARTIAL' | 'FAILED' = 'OK';

  try {
    // 1. Service-Meta + Gameserver-Settings (komplett, ein Call)
    const [serviceMeta, gameserver] = await Promise.all([
      client.getServiceMeta(serviceId).catch(e => { errorCount++; lastError = String((e as Error).message); return null; }),
      client.getGameserver(serviceId).catch(e => { errorCount++; lastError = String((e as Error).message); return null; }),
    ]);

    await prisma.nitradoSnapshot.update({
      where: { id: snapshotId },
      data: {
        serviceMetaJson: (serviceMeta ?? undefined) as unknown as object,
        settingsJson: (gameserver ?? undefined) as unknown as object,
      },
    });

    // 2. Verzeichnisbaum rekursiv durchwandern (BFS, sequenziell zum Schonen der API)
    const queue: string[] = [...ROOTS];
    const seenDirs = new Set<string>();

    while (queue.length > 0) {
      const dir = queue.shift()!;
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);

      let entries: FileEntry[];
      try {
        entries = await client.listDir(serviceId, dir);
      } catch (e) {
        errorCount++;
        lastError = `listDir ${dir}: ${(e as Error).message}`;
        logger.warn('[NitradoMirror] listDir fehlgeschlagen', { dir, err: (e as Error).message });
        await prisma.nitradoSnapshotFile.create({
          data: {
            snapshotId,
            path: dir,
            name: dir.split('/').filter(Boolean).pop() ?? '/',
            parentDir: parentOf(dir),
            isDir: true,
            errorMsg: lastError,
          },
        });
        continue;
      }

      // Verzeichnis selbst eintragen (für Browser)
      try {
        await prisma.nitradoSnapshotFile.create({
          data: {
            snapshotId,
            path: dir,
            name: dir === '/' ? '/' : (dir.split('/').filter(Boolean).pop() ?? '/'),
            parentDir: parentOf(dir),
            isDir: true,
          },
        });
        totalDirs++;
      } catch { /* unique violation moeglich falls /, ignorieren */ }

      for (const entry of entries) {
        const fullPath = entry.path;
        if (entry.type === 'dir') {
          queue.push(fullPath);
          continue;
        }

        // Datei
        totalFiles++;
        totalBytes += BigInt(entry.size);

        if (entry.size > MAX_FILE_BYTES) {
          oversizeFiles++;
          await prisma.nitradoSnapshotFile.create({
            data: {
              snapshotId,
              path: fullPath,
              name: entry.name,
              parentDir: dir,
              isDir: false,
              sizeBytes: BigInt(entry.size),
              modifiedAt: entry.modified_at ? new Date(entry.modified_at * 1000) : null,
              mimeGuess: guessMimeByExt(entry.name),
              oversize: true,
            },
          });
          continue;
        }

        try {
          const buf = await client.downloadFile(serviceId, fullPath, MAX_FILE_BYTES);
          const hash = sha256(buf);
          const text = looksLikeText(buf);
          const mime = guessMimeByExt(entry.name);
          let storedPath: string | null = null;
          let inlineText: string | null = null;

          if (text && buf.length <= INLINE_TEXT_BYTES) {
            inlineText = buf.toString('utf8');
          }
          // immer auch als Blob ablegen (lückenlose Kopie, egal ob Text oder Binär)
          storedPath = await storeBlob(connId, hash, buf);
          storedBytes += BigInt(buf.length);

          await prisma.nitradoSnapshotFile.create({
            data: {
              snapshotId,
              path: fullPath,
              name: entry.name,
              parentDir: dir,
              isDir: false,
              sizeBytes: BigInt(buf.length),
              modifiedAt: entry.modified_at ? new Date(entry.modified_at * 1000) : null,
              sha256: hash,
              mimeGuess: mime,
              isText: text,
              contentText: inlineText,
              storedPath,
            },
          });
        } catch (e) {
          errorCount++;
          lastError = `download ${fullPath}: ${(e as Error).message}`;
          logger.warn('[NitradoMirror] download fehlgeschlagen', { fullPath, err: (e as Error).message });
          await prisma.nitradoSnapshotFile.create({
            data: {
              snapshotId,
              path: fullPath,
              name: entry.name,
              parentDir: dir,
              isDir: false,
              sizeBytes: BigInt(entry.size),
              modifiedAt: entry.modified_at ? new Date(entry.modified_at * 1000) : null,
              mimeGuess: guessMimeByExt(entry.name),
              errorMsg: lastError,
            },
          });
        }

        // sanftes Throttling — 50ms zwischen Files
        await new Promise(r => setTimeout(r, 50));
      }

      // Zwischenstand persistieren (alle 100 Verzeichnisse)
      if (totalDirs % 100 === 0) {
        await prisma.nitradoSnapshot.update({
          where: { id: snapshotId },
          data: { totalFiles, totalDirs, totalBytes, storedBytes, oversizeFiles, errorCount, lastError },
        });
      }
    }

    if (errorCount > 0) status = 'PARTIAL';
  } catch (e) {
    errorCount++;
    lastError = (e as Error).message;
    status = 'FAILED';
    logger.error('[NitradoMirror] Snapshot fehlgeschlagen', e as Error);
  } finally {
    const finishedAt = new Date();
    await prisma.nitradoSnapshot.update({
      where: { id: snapshotId },
      data: {
        status,
        finishedAt,
        totalFiles,
        totalDirs,
        totalBytes,
        storedBytes,
        oversizeFiles,
        errorCount,
        lastError,
      },
    });
    logger.info('[NitradoMirror] Snapshot fertig', {
      snapshotId, status, totalFiles, totalDirs,
      totalBytes: totalBytes.toString(), storedBytes: storedBytes.toString(),
      oversizeFiles, errorCount,
    });

    // AI-14: Ein abgeschlossener Mirror-Snapshot ist die einzige Quelle fuer
    // LIVE_SERVER-Knowledge. Indexfehler duerfen den Snapshot selbst nicht
    // nachtraeglich auf FAILED setzen; der AI-Pfad bleibt stattdessen fail-closed.
    if (status === 'OK' || status === 'PARTIAL') {
      try {
        const { indexNitradoSnapshotKnowledge } = await import('../../ai/liveServerKnowledgeIndex.js');
        await indexNitradoSnapshotKnowledge({ snapshotId, guildId, nitradoConnId: connId });
      } catch (e) {
        logger.warn('[AI-14] Live-Server-Knowledge konnte nicht aktualisiert werden', {
          snapshotId,
          guildId,
          nitradoConnId: connId,
          e: String(e),
        });
      }
    }
  }
}

function parentOf(p: string): string {
  if (p === '/' || p === '') return '';
  const trimmed = p.replace(/\/$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

export async function getSnapshotProgress(snapshotId: string, guildId: string): Promise<SnapshotProgress | null> {
  const s = await prisma.nitradoSnapshot.findFirst({
    where: { id: snapshotId, guildId },
    select: {
      id: true, status: true, totalFiles: true, totalDirs: true, totalBytes: true,
      storedBytes: true, oversizeFiles: true, errorCount: true, lastError: true,
      startedAt: true, finishedAt: true,
    },
  });
  if (!s) return null;
  return {
    snapshotId: s.id,
    status: s.status,
    totalFiles: s.totalFiles,
    totalDirs: s.totalDirs,
    totalBytes: s.totalBytes,
    storedBytes: s.storedBytes,
    oversizeFiles: s.oversizeFiles,
    errorCount: s.errorCount,
    lastError: s.lastError,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
  };
}
