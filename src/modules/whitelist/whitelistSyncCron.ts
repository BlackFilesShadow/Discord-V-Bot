/**
 * Phase 7 WL-V2: 5-Minuten-Reconciliation zwischen lokaler Whitelist-Wahrheit
 * und dem realen DayZ-Whitelist-Setting bei Nitrado.
 *
 * Wichtig:
 * - Remote wird vollstaendig gelesen (`NitradoClient.getWhitelist`).
 * - Mutationen gehen NICHT direkt an Nitrado, sondern in die bestehende
 *   NitradoJob-Outbox. Damit bleiben Retry, Serialisierung und der
 *   per-Connection Advisory-Lock im JobWorker die einzige Write-Grenze.
 * - Nitrado-1A: Identische aktive Jobs werden zusaetzlich cross-process unter
 *   einem DB-xact-Lock dedupliziert; der lokale `queued`-Set ist nur Fast-Path.
 * - Lokale Eintraege bekommen einen ehrlichen SYNCED/LOCAL_ONLY-Status.
 * - PENDING_REMOVE bleibt lokal erhalten, bis ein frischer Remote-Read die
 *   Entfernung bestaetigt. Erst dann wird der lokale Spiegel final geloescht.
 */

import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { NitradoClient } from '../nitrado/nitradoClient';
import { diffWhitelist } from './whitelistSync';
import {
  enqueueWhitelistAdd,
  enqueueWhitelistRemove,
  type WhitelistOutboxClient,
} from './whitelistOutbox';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

type PendingJob = { operation: string; payload: unknown };
type LocalWhitelistEntry = {
  id: string;
  gameId: string;
  syncState: 'LOCAL_ONLY' | 'SYNCED' | 'PENDING_REMOVE';
};

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
  const remoteNorm = new Set(remoteNames.map((n) => n.trim().toLowerCase()));

  const local = await prisma.whitelistEntry.findMany({
    where: { guildId: conn.guildId, nitradoConnId: conn.id },
    select: { id: true, gameId: true, syncState: true },
  }) as LocalWhitelistEntry[];

  const desiredLocal = local.filter((entry) => entry.syncState !== 'PENDING_REMOVE');
  const localNames = desiredLocal.map((e) => e.gameId);
  const diff = diffWhitelist(localNames, remoteNames);
  const now = new Date();
  let finalizedRemovals = 0;

  // Status ist eine Beobachtung des gerade gelesenen Remote-Zustands.
  // PENDING_REMOVE ist dagegen eine lokale Absicht und darf niemals wieder zu
  // LOCAL_ONLY/SYNCED umgeschrieben werden. Sobald der Name remote wirklich
  // fehlt, ist die Entfernung bestaetigt und der lokale Spiegel darf weg.
  for (const entry of local) {
    const isRemote = remoteNorm.has(entry.gameId.trim().toLowerCase());
    if (entry.syncState === 'PENDING_REMOVE') {
      if (!isRemote) {
        const deleted = await prisma.whitelistEntry.deleteMany({
          where: {
            id: entry.id,
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            syncState: 'PENDING_REMOVE',
          },
        });
        finalizedRemovals += deleted.count;
      }
      continue;
    }

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

  const outbox = prisma as unknown as WhitelistOutboxClient;
  let enqueued = 0;
  for (const gameId of diff.toAdd) {
    const key = jobKey('WHITELIST_ADD', gameId);
    if (queued.has(key)) continue;
    if (await enqueueWhitelistAdd(outbox, { guildId: conn.guildId, nitradoConnId: conn.id }, gameId)) {
      enqueued++;
    }
    queued.add(key);
  }
  for (const gameId of diff.toRemove) {
    const key = jobKey('WHITELIST_REMOVE', gameId);
    if (queued.has(key)) continue;
    if (await enqueueWhitelistRemove(outbox, { guildId: conn.guildId, nitradoConnId: conn.id }, gameId)) {
      enqueued++;
    }
    queued.add(key);
  }

  if (enqueued > 0 || diff.synced.length > 0 || finalizedRemovals > 0) {
    logAudit('WHITELIST_RECONCILED', 'WHITELIST', {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      synced: diff.synced.length,
      addQueued: diff.toAdd.length,
      removeQueued: diff.toRemove.length,
      newlyEnqueued: enqueued,
      finalizedRemovals,
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
