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
 * - Nitrado-1N: Auch der Remote-Read/Reconcile selbst laeuft unter demselben
 *   per-Connection Advisory-Lock wie Worker und Token/Service/Delete. Nach
 *   Lockgewinn wird der kanonische Connection-Snapshot frisch gelesen. Damit
 *   kann ein alter Token/Service-Snapshot niemals Jobs fuer ein inzwischen
 *   anderes Remote-Ziel erzeugen.
 * - LOCAL_ONLY bedeutet weiterhin: V-Bot will den Namen remote hinzufuegen.
 * - SYNCED + remote fehlend ist eine beobachtete Remote-Abweichung. Der lokale
 *   aktive Spiegel wird niemals automatisch entfernt; ein Admin entscheidet
 *   explizit ueber die weitere Behandlung. LOCAL_ONLY wird ebenfalls nie
 *   verworfen.
 * - PENDING_REMOVE bleibt lokal erhalten, bis ein frischer Remote-Read die
 *   Entfernung bestaetigt. Erst dann wird der lokale Spiegel final geloescht.
 * - Remote-only Eintraege sind Fremdwahrheit und werden vom Hintergrund-Cron
 *   niemals automatisch geloescht. Ein destruktiver Push bleibt eine explizite
 *   Admin-Aktion ueber die vorhandenen Command-/Dashboard-Pfade.
 */

import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { NitradoClient } from '../nitrado/nitradoClient';
import { tryAcquireNitradoConfigMutationLock } from '../nitrado/configMutationLock';
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
type WhitelistSyncConnection = {
  id: string;
  guildId: string;
  encryptedToken: string;
  nitradoServerId: string | null;
};

function normGameId(value: string): string {
  return value.trim().toLowerCase();
}

function payloadGameId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).gameId;
  return typeof value === 'string' ? normGameId(value) : null;
}

function jobKey(operation: string, gameId: string): string {
  return `${operation}:${normGameId(gameId)}`;
}

/**
 * Aufrufer haelt fuer die gesamte Funktion den kanonischen NITR-Connection-
 * Lock. `conn` ist bereits NACH Lockgewinn frisch aus der DB gelesen.
 */
async function reconcileLockedConnection(conn: WhitelistSyncConnection): Promise<void> {
  if (!conn.nitradoServerId) return;

  const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  const api = new NitradoClient(token);
  const remoteEntries = await api.getWhitelist(conn.nitradoServerId);
  const remoteNames = remoteEntries.map((e) => e.identifier);
  const remoteNorm = new Set(remoteNames.map(normGameId));

  const local = await prisma.whitelistEntry.findMany({
    where: { guildId: conn.guildId, nitradoConnId: conn.id },
    select: { id: true, gameId: true, syncState: true },
  }) as LocalWhitelistEntry[];

  const desiredLocal = local.filter((entry) => entry.syncState !== 'PENDING_REMOVE');
  const localNames = desiredLocal.map((e) => e.gameId);
  const localByName = new Map(desiredLocal.map(entry => [normGameId(entry.gameId), entry]));
  const pendingRemoveNorm = new Set(
    local.filter((entry) => entry.syncState === 'PENDING_REMOVE').map((entry) => normGameId(entry.gameId)),
  );
  const diff = diffWhitelist(localNames, remoteNames);
  const remoteOnly = diff.toRemove.filter((name) => !pendingRemoveNorm.has(normGameId(name)));
  const intentionalAdds = diff.toAdd.filter(name => localByName.get(normGameId(name))?.syncState === 'LOCAL_ONLY');
  const manualRemoteMissing = diff.toAdd.filter(name => localByName.get(normGameId(name))?.syncState === 'SYNCED');
  const now = new Date();
  let finalizedRemovals = 0;
  const pendingRemoveRemote = new Map<string, string>();

  // PENDING_REMOVE ist eine lokale Absicht und darf niemals wieder zu
  // LOCAL_ONLY/SYNCED umgeschrieben werden. Sobald der Name remote wirklich
  // fehlt, ist die Entfernung bestaetigt und der lokale Spiegel darf weg.
  //
  // Fuer normale Eintraege gilt bewusst asymmetrisch:
  // - remote vorhanden -> SYNCED (frisch bestaetigt)
  // - LOCAL_ONLY + remote fehlend -> bleibt LOCAL_ONLY (noch ausstehender Add)
  // - SYNCED + remote fehlend -> bleibt SYNCED (manuelle Remote-Abweichung)
  // Damit kann ein manueller Nitrado-Remove nicht durch den Cron rueckgaengig
  // gemacht werden, waehrend echte neue V-Bot-Adds weiterhin automatisch laufen.
  for (const entry of local) {
    const normalized = normGameId(entry.gameId);
    const isRemote = remoteNorm.has(normalized);
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
      } else {
        pendingRemoveRemote.set(normalized, entry.gameId);
      }
      continue;
    }

    if (isRemote) {
      await prisma.whitelistEntry.updateMany({
        where: { id: entry.id, guildId: conn.guildId, nitradoConnId: conn.id },
        data: { syncState: 'SYNCED', lastSyncedAt: now },
      });
    }
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
  for (const gameId of intentionalAdds) {
    const key = jobKey('WHITELIST_ADD', gameId);
    if (queued.has(key)) continue;
    if (await enqueueWhitelistAdd(outbox, { guildId: conn.guildId, nitradoConnId: conn.id }, gameId)) {
      enqueued++;
    }
    queued.add(key);
  }

  // Nur ein expliziter lokaler PENDING_REMOVE-Sollzustand darf vom Cron einen
  // Remove-Job erzeugen. `diff.toRemove` enthaelt zusaetzlich remote-only Namen
  // und darf deshalb niemals direkt als Loeschliste verwendet werden.
  for (const gameId of pendingRemoveRemote.values()) {
    const key = jobKey('WHITELIST_REMOVE', gameId);
    if (queued.has(key)) continue;
    if (await enqueueWhitelistRemove(outbox, { guildId: conn.guildId, nitradoConnId: conn.id }, gameId)) {
      enqueued++;
    }
    queued.add(key);
  }

  if (
    enqueued > 0
    || diff.synced.length > 0
    || finalizedRemovals > 0
    || remoteOnly.length > 0
    || manualRemoteMissing.length > 0
  ) {
    logAudit('WHITELIST_RECONCILED', 'WHITELIST', {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      synced: diff.synced.length,
      addQueued: intentionalAdds.length,
      manualRemoteMissingObserved: manualRemoteMissing.length,
      removeQueued: pendingRemoveRemote.size,
      remoteOnlyObserved: remoteOnly.length,
      newlyEnqueued: enqueued,
      finalizedRemovals,
    });
  }
}

/**
 * Nitrado-1N: Der aeussere Scheduler-Snapshot dient nur zur Kandidatenfindung.
 * Bevor Token/Service oder Remote-Zustand benutzt werden, wird derselbe
 * Connection-Lock wie im Worker gewonnen und danach der kanonische Snapshot
 * fuer exakt id+guild erneut gelesen. Busy bedeutet bewusst skip bis zum
 * naechsten Poll; Lock-/DB-/Remote-Fehler werden vom aeusseren Loop isoliert.
 */
async function reconcileConnection(candidate: { id: string; guildId: string }): Promise<void> {
  const lock = await tryAcquireNitradoConfigMutationLock(candidate.id);
  if (!lock) {
    logger.debug(`Whitelist-Reconciliation fuer ${candidate.id} uebersprungen: Connection ist gerade busy.`);
    return;
  }

  try {
    const fresh = await prisma.nitradoConnection.findFirst({
      where: {
        id: candidate.id,
        guildId: candidate.guildId,
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
    if (!fresh) return;

    await reconcileLockedConnection(fresh);
  } finally {
    await lock.release();
  }
}

export async function runWhitelistSyncOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Globaler Scheduler iteriert bewusst alle Guilds. Dieser Scan ist nur
    // Kandidatenfindung; Token und Service-ID werden erst nach Lockgewinn frisch
    // gelesen und niemals aus diesem potentiell veralteten Snapshot benutzt.
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
