/**
 * Phase 7 WL-V2: 5-Minuten-Reconciliation zwischen lokaler Whitelist-Wahrheit
 * und dem realen DayZ-Whitelist-Setting bei Nitrado.
 *
 * Wichtig:
 * - Remote wird vollstaendig gelesen (`NitradoClient.getWhitelist`).
 * - Mutationen gehen NICHT direkt an Nitrado, sondern in die bestehende
 *   NitradoJob-Outbox. Damit bleiben Retry, Serialisierung und der
 *   per-Connection Advisory-Lock im JobWorker die einzige Write-Grenze.
 * - Bereits PENDING/RUNNING vorhandene identische Jobs werden nicht dupliziert.
 * - Lokale Eintraege bekommen einen ehrlichen SYNCED/LOCAL_ONLY-Status.
 */

import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { NitradoClient } from '../nitrado/nitradoClient';
import { diffWhitelist } from './whitelistSync';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

type PendingJob = { operation: string; payload: unknown };

function payloadGameId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).gameId;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function jobKey(operation: string, gameId: string): string {
  return `${operation}:${gameId.trim().toLowerCase()}`;
}

async function reconcileConnection(conn: {
  id: string;
  guildId: string;
  encryptedToken: string;
  nitradoServerId: string | null;
}): Promise<void> {
  if (!conn.nitradoServerId) return;

  const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  const api = new NitradoClient(token);
  const remoteEntries = await api.getWhitelist(conn.nitradoServerId);
  const remoteNames = remoteEntries.map((e) => e.identifier);

  const local = await prisma.whitelistEntry.findMany({
    where: { guildId: conn.guildId, nitradoConnId: conn.id },
    select: { id: true, gameId: true },
  });
  const localNames = local.map((e) => e.gameId);
  const diff = diffWhitelist(localNames, remoteNames);
  const remoteNorm = new Set(remoteNames.map((n) => n.trim().toLowerCase()));
  const now = new Date();

  // Status ist eine Beobachtung des gerade gelesenen Remote-Zustands.
  for (const entry of local) {
    const isRemote = remoteNorm.has(entry.gameId.trim().toLowerCase());
    await prisma.whitelistEntry.updateMany({
      where: { id: entry.id, guildId: conn.guildId, nitradoConnId: conn.id },
      data: {
        syncState: isRemote ? 'SYNCED' : 'LOCAL_ONLY',
        lastSyncedAt: isRemote ? now : null,
      },
    });
  }

  const existing = await prisma.nitradoJob.findMany({
    where: {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      status: { in: ['PENDING', 'RUNNING'] },
      operation: { in: ['WHITELIST_ADD', 'WHITELIST_REMOVE'] },
    },
    select: { operation: true, payload: true },
  }) as PendingJob[];
  const queued = new Set<string>();
  for (const job of existing) {
    const gameId = payloadGameId(job.payload);
    if (gameId) queued.add(jobKey(job.operation, gameId));
  }

  let enqueued = 0;
  for (const gameId of diff.toAdd) {
    const key = jobKey('WHITELIST_ADD', gameId);
    if (queued.has(key)) continue;
    await prisma.nitradoJob.create({
      data: {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        operation: 'WHITELIST_ADD',
        payload: { gameId },
      },
    });
    queued.add(key);
    enqueued++;
  }
  for (const gameId of diff.toRemove) {
    const key = jobKey('WHITELIST_REMOVE', gameId);
    if (queued.has(key)) continue;
    await prisma.nitradoJob.create({
      data: {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        operation: 'WHITELIST_REMOVE',
        payload: { gameId },
      },
    });
    queued.add(key);
    enqueued++;
  }

  if (enqueued > 0 || diff.synced.length > 0) {
    logAudit('WHITELIST_RECONCILED', 'WHITELIST', {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      synced: diff.synced.length,
      addQueued: diff.toAdd.length,
      removeQueued: diff.toRemove.length,
      newlyEnqueued: enqueued,
    });
  }
}

export async function runWhitelistSyncOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Globaler Scheduler iteriert bewusst alle Guilds, jede Folgeoperation ist
    // danach strikt auf guildId+nitradoConnId gebunden.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler, Scope wird pro Connection gebunden
    const conns = await prisma.nitradoConnection.findMany({
      where: {
        status: 'ACTIVE',
        nitradoServerId: { not: null },
        serverSettings: { some: { whitelistActive: true } },
      },
      select: {
        id: true,
        guildId: true,
        encryptedToken: true,
        nitradoServerId: true,
      },
    });

    for (const conn of conns) {
      try {
        await reconcileConnection(conn);
      } catch (error) {
        logger.warn(`Whitelist-Reconciliation fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startWhitelistSyncCron(): void {
  if (timer) return;
  logger.info(`Whitelist-V2-Reconciliation gestartet (${SYNC_INTERVAL_MS / 60_000}min).`);
  timer = setInterval(() => { void runWhitelistSyncOnce(); }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopWhitelistSyncCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
