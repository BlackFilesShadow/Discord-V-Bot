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
import {
  readCurrentAdmBinding,
  withFreshAdmBinding,
  type AdmBindingSnapshot,
} from '../adm/bindingFence';
import { NitradoReadClient, type FileEntry } from './readClient';
import {
  acquireMirrorSnapshotLease,
  finalizeMirrorSnapshotLease,
  MIRROR_HEARTBEAT_MS,
  mirrorLeaseBindingKey,
  releaseMirrorSnapshotLease,
  renewMirrorSnapshotLease,
} from './mirrorLease';
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

const ROOTS = ['/'];

export async function startSnapshot(opts: SnapshotOptions): Promise<{ snapshotId: string }> {
  const binding = await readCurrentAdmBinding({ id: opts.nitradoConnId, guildId: opts.guildId });
  if (!binding) throw new Error('NitradoConnection ist nicht ACTIVE oder hat keine kanonische Service-ID.');

  const lease = await acquireMirrorSnapshotLease({
    guildId: opts.guildId,
    nitradoConnId: opts.nitradoConnId,
    serviceId: binding.nitradoServerId,
    bindingKey: mirrorLeaseBindingKey(binding),
    triggeredBy: opts.triggeredBy,
  });
  if (lease.reused || !lease.leaseToken) return { snapshotId: lease.snapshotId };

  try {
    await withFreshAdmBinding(binding, async () => undefined);
  } catch (error) {
    const finalized = await finalizeMirrorSnapshotLease({
      guildId: binding.guildId,
      nitradoConnId: binding.id,
      snapshotId: lease.snapshotId,
      leaseToken: lease.leaseToken,
      status: 'FAILED',
      totalFiles: 0,
      totalDirs: 0,
      totalBytes: 0n,
      storedBytes: 0n,
      oversizeFiles: 0,
      errorCount: 1,
      lastError: `Binding vor Mirror-Start stale: ${(error as Error).message}`,
    });
    if (finalized) {
      await releaseMirrorSnapshotLease({
        guildId: binding.guildId,
        nitradoConnId: binding.id,
        snapshotId: lease.snapshotId,
        leaseToken: lease.leaseToken,
      });
    }
    throw error;
  }

  void runSnapshot(lease.snapshotId, binding, lease.leaseToken)
    .catch(err => {
      logger.error('[NitradoMirror] Snapshot abgebrochen', err as Error);
    });

  return { snapshotId: lease.snapshotId };
}

async function runSnapshot(
  snapshotId: string,
  binding: AdmBindingSnapshot,
  leaseToken: string,
): Promise<void> {
  const guildId = binding.guildId;
  const connId = binding.id;
  const serviceId = binding.nitradoServerId;
  const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
  const client = new NitradoReadClient(token);

  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0n;
  let storedBytes = 0n;
  let oversizeFiles = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let status: 'OK' | 'PARTIAL' | 'FAILED' = 'OK';
  let lastHeartbeatAt = 0;

  const heartbeat = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < MIRROR_HEARTBEAT_MS) return;
    await renewMirrorSnapshotLease({
      guildId,
      nitradoConnId: connId,
      snapshotId,
      leaseToken,
    });
    lastHeartbeatAt = now;
  };

  try {
    await heartbeat(true);

    const [serviceMeta, gameserver] = await Promise.all([
      client.getServiceMeta(serviceId).catch(e => { errorCount++; lastError = String((e as Error).message); return null; }),
      client.getGameserver(serviceId).catch(e => { errorCount++; lastError = String((e as Error).message); return null; }),
    ]);
    await heartbeat();

    await prisma.nitradoSnapshot.updateMany({
      where: { id: snapshotId, guildId, nitradoConnId: connId, status: 'RUNNING' },
      data: {
        serviceMetaJson: (serviceMeta ?? undefined) as unknown as object,
        settingsJson: (gameserver ?? undefined) as unknown as object,
      },
    });

    const queue: string[] = [...ROOTS];
    const seenDirs = new Set<string>();

    while (queue.length > 0) {
      await heartbeat();
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
      } catch { /* duplicate directory row can be ignored */ }

      for (const entry of entries) {
        await heartbeat();
        const fullPath = entry.path;
        if (entry.type === 'dir') {
          queue.push(fullPath);
          continue;
        }

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

        let buf: Buffer;
        try {
          buf = await client.downloadFile(serviceId, fullPath, MAX_FILE_BYTES);
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
          continue;
        }

        await heartbeat();

        try {
          const hash = sha256(buf);
          const text = looksLikeText(buf);
          const mime = guessMimeByExt(entry.name);
          let storedPath: string | null = null;
          let inlineText: string | null = null;

          if (text && buf.length <= INLINE_TEXT_BYTES) inlineText = buf.toString('utf8');
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
          lastError = `persist ${fullPath}: ${(e as Error).message}`;
          logger.warn('[NitradoMirror] Datei konnte lokal nicht persistiert werden', { fullPath, err: (e as Error).message });
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

        await new Promise(r => setTimeout(r, 50));
      }

      if (totalDirs % 100 === 0) {
        await prisma.nitradoSnapshot.updateMany({
          where: { id: snapshotId, guildId, nitradoConnId: connId, status: 'RUNNING' },
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
    const finalized = await finalizeMirrorSnapshotLease({
      guildId,
      nitradoConnId: connId,
      snapshotId,
      leaseToken,
      status,
      totalFiles,
      totalDirs,
      totalBytes,
      storedBytes,
      oversizeFiles,
      errorCount,
      lastError,
    }).catch((error) => {
      logger.error('[NitradoMirror] Lease-Finalisierung fehlgeschlagen', error as Error);
      return false;
    });

    if (!finalized) {
      logger.warn('[NitradoMirror] Staler/ersetzter Snapshot verwirft finale Side-Effects', {
        snapshotId,
        guildId,
        nitradoConnId: connId,
      });
      return;
    }

    logger.info('[NitradoMirror] Snapshot fertig', {
      snapshotId, status, totalFiles, totalDirs,
      totalBytes: totalBytes.toString(), storedBytes: storedBytes.toString(),
      oversizeFiles, errorCount,
    });

    try {
      if (status === 'OK' || status === 'PARTIAL') {
        try {
          const { indexNitradoSnapshotKnowledge } = await import('../../ai/liveServerKnowledgeIndex.js');
          await indexNitradoSnapshotKnowledge({
            snapshotId,
            guildId,
            nitradoConnId: connId,
            binding,
            mirrorLeaseToken: leaseToken,
          });
        } catch (e) {
          logger.warn('[AI-14] Live-Server-Knowledge konnte nicht aktualisiert werden', {
            snapshotId,
            guildId,
            nitradoConnId: connId,
            e: String(e),
          });
        }
      }
    } finally {
      await releaseMirrorSnapshotLease({
        guildId,
        nitradoConnId: connId,
        snapshotId,
        leaseToken,
      }).catch((error) => {
        logger.warn('[NitradoMirror] Lease-Release fehlgeschlagen', { snapshotId, e: String(error) });
        return false;
      });
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
