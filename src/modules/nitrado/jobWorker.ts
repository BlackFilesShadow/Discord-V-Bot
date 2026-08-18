/**
 * NitradoJob-Worker — Outbox-Pattern fuer Nitrado-API-Calls.
 *
 * Polling alle JOB_POLL_INTERVAL_MS. Pickt PENDING/RUNNING-Jobs deren
 * `nextRunAt <= now`. Jeder Job laeuft mit:
 *   - Status PENDING -> RUNNING
 *   - Dispatch je `operation`
 *   - Bei Erfolg -> DONE
 *   - Bei Fehler:
 *       attempts++ ; if attempts >= maxAttempts -> DEAD
 *       sonst -> PENDING + nextRunAt = now + 30s * 2^attempts (Backoff bis ~1h)
 *
 * Operationen:
 *   - WHITELIST_ADD      payload: { gameId }
 *   - WHITELIST_REMOVE   payload: { gameId }
 *   - SERVER_BAN_ADD     payload: { banId, encryptedIdentifier }
 *   - SERVER_BAN_REMOVE  payload: { banId }
 *   - KEEPALIVE          payload: {}              -> validateToken()
 *   - DOWNLOAD_ADM       payload: { profileDir? } -> wird vom ADM-Sync genutzt
 *   - RESTART_IF_DOWN    payload: {}
 *
 * Multi-instance: Jeder ausgefuehrte Job haelt zusaetzlich einen dedizierten
 * PostgreSQL-Advisory-Lock pro nitradoConnId. Damit koennen mehrere Worker
 * dieselbe Outbox pollen, aber niemals denselben Nitrado-Service parallel
 * bearbeiten.
 */

import crypto from 'crypto';
import { Client as PgClient } from 'pg';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient, NitradoApiError } from './nitradoClient';
import { decideWhitelistRemoteIntent } from './whitelistIntent';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { isBanActive } from '../bans/banRegistry';
import { matchesBanIdentifier } from '../bans/banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  parseServerBanJobPayload,
  type BanOutboxClient,
} from '../bans/banOutbox';

const JOB_POLL_INTERVAL_MS = 10_000;
const MAX_PARALLEL = 4;
const BACKOFF_BASE_SECONDS = 30;
const STALE_RUNNING_MS = 5 * 60 * 1000; // RUNNING-Jobs ohne Update >5min werden recovered
const CONN_LOCK_RETRY_MS = 1_000;
// int4 namespace "NITR" fuer per-Connection Advisory Locks.
const CONN_LOCK_NAMESPACE = 0x4e495452;

// NIT-008: Retention. DONE kurz, DEAD laenger (Diagnose). Sweep max 1x/Stunde.
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionAt = 0;

// Temporäre oder manuell aufgehobene Remote-Banns werden mindestens 1x/min zur
// Removal-Outbox reconciled. REMOVE braucht keinen gespeicherten Klartext-ID.
const BAN_RECONCILE_INTERVAL_MS = 60_000;
let lastBanReconcileAt = 0;

// NIT-007: bekannte Operationen. Alles andere -> sofort permanent DEAD.
const KNOWN_OPERATIONS = new Set([
  'WHITELIST_ADD',
  'WHITELIST_REMOVE',
  'SERVER_BAN_ADD',
  'SERVER_BAN_REMOVE',
  'KEEPALIVE',
  'DOWNLOAD_ADM',
  'RESTART_IF_DOWN',
]);

let timer: NodeJS.Timeout | null = null;
let running = false;

interface JobPayload {
  gameId?: string;
  profileDir?: string;
  banId?: string;
  encryptedIdentifier?: string;
  [key: string]: unknown;
}

function jobPayloadGameId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const gameId = (value as Record<string, unknown>).gameId;
  return typeof gameId === 'string' && gameId.trim() ? gameId.trim() : null;
}

class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

function isServerBanOperation(operation: string): boolean {
  return operation === 'SERVER_BAN_ADD' || operation === 'SERVER_BAN_REMOVE';
}

interface HeldConnectionLock {
  release: () => Promise<void>;
}

export function nitradoConnectionLockKeys(nitradoConnId: string): [number, number] {
  const digest = crypto.createHash('sha256').update(nitradoConnId).digest();
  return [CONN_LOCK_NAMESPACE, digest.readInt32BE(0)];
}

async function tryAcquireConnectionLock(nitradoConnId: string): Promise<HeldConnectionLock | null> {
  const [k1, k2] = nitradoConnectionLockKeys(nitradoConnId);
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [k1, k2]);
    if (result.rows?.[0]?.locked !== true) {
      await client.end();
      return null;
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]);
      } catch (error) {
        logger.warn(`NitradoJob-Worker: Connection-Lock konnte nicht sauber freigegeben werden: ${String(error)}`);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

async function requeueForConnectionLock(id: string, guildId: string): Promise<void> {
  await prisma.nitradoJob.updateMany({
    where: { id, guildId, status: 'RUNNING' },
    data: {
      status: 'PENDING',
      nextRunAt: new Date(Date.now() + CONN_LOCK_RETRY_MS),
      updatedAt: new Date(),
    },
  });
}

/**
 * Legt Removal-Jobs fuer Remote-Banns an, die lokal bereits aufgehoben oder
 * zeitlich abgelaufen sind. Dedupe geschieht in banOutbox.
 */
async function reconcileRemoteBanRemovals(now: Date): Promise<void> {
  if (Date.now() - lastBanReconcileAt < BAN_RECONCILE_INTERVAL_MS) return;
  lastBanReconcileAt = Date.now();

  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- absichtlicher globaler Reconcile ueber die eigene Ban-Registry; jeder erzeugte Job traegt Guild+Connection-Scope.
    const rows = await prisma.serverBanEntry.findMany({
      where: {
        appliedRemotely: true,
        OR: [
          { active: false },
          { expiresAt: { lte: now } },
        ],
      },
      select: { id: true, guildId: true, nitradoConnId: true },
      take: 200,
    });

    for (const row of rows) {
      await enqueueServerBanRemove(
        prisma as unknown as BanOutboxClient,
        { guildId: row.guildId, nitradoConnId: row.nitradoConnId },
        row.id,
      );
    }
  } catch (e) {
    logger.warn(`Server-Ban-Reconcile fehlgeschlagen: ${(e as Error).message}`);
  }
}

/**
 * Nitrado-1B: Ein Retry darf niemals seine historische Operation ueber den
 * aktuellen lokalen Whitelist-Sollzustand stellen. Die Pruefung laeuft NACH
 * dem per-Connection-Advisory-Lock und VOR Token/Remote-API-Arbeit.
 *
 * Superseded Jobs werden als erfolgreicher No-op DONE quittiert: sie sind nicht
 * technisch fehlgeschlagen, sondern durch eine neuere Nutzer-/Reconcile-
 * Entscheidung obsolet geworden. Dabei wird kein Spielername zusaetzlich
 * geloggt oder in Audit-Metadaten kopiert.
 */
async function finishSupersededWhitelistJob(args: {
  id: string;
  guildId: string;
  operation: 'WHITELIST_ADD' | 'WHITELIST_REMOVE';
  desiredState: string;
  reason: string;
}): Promise<void> {
  await prisma.nitradoJob.updateMany({
    where: { id: args.id, guildId: args.guildId, status: 'RUNNING' },
    data: { status: 'DONE', lastError: null, updatedAt: new Date() },
  });
  logAudit('NITRADO_WHITELIST_JOB_SUPERSEDED', 'NITRADO', {
    guildId: args.guildId,
    jobId: args.id,
    operation: args.operation,
    desiredState: args.desiredState,
    reason: args.reason,
  });
  emitGuildEvent(args.guildId, {
    type: 'nitrado.job.updated',
    payload: { guildId: args.guildId, jobId: args.id, status: 'DONE' },
  });
}

export async function executeJob(jobId: string): Promise<void> {
  // Hole Job + zugehoerige Connection getrennt — `NitradoJob` hat im Schema
  // keine deklarierte Prisma-Relation zu `NitradoConnection` (nur die FK-Spalte
  // `nitradoConnId`), daher ist `include: { nitradoConn }` zur Laufzeit ungueltig.
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Worker hat Job-ID aus eigenem PENDING->RUNNING-Claim, Scope ist im executeJob-Body durch Job.guildId gebunden.
  const job = await prisma.nitradoJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  let connectionLock: HeldConnectionLock | null;
  try {
    connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);
  } catch (error) {
    logger.warn(`NitradoJob ${job.id}: Connection-Lock nicht verfuegbar (${String(error)}), requeue.`);
    await requeueForConnectionLock(job.id, job.guildId);
    return;
  }

  if (!connectionLock) {
    // Eine andere Instanz bearbeitet denselben Nitrado-Service bereits.
    await requeueForConnectionLock(job.id, job.guildId);
    return;
  }

  try {
    let conn: {
      id: string;
      guildId: string;
      encryptedToken: string;
      nitradoServerId: string | null;
      status: string;
      keepOnlineEnabled: boolean;
    } | null = null;
    try {
      conn = await prisma.nitradoConnection.findFirst({
        where: { id: job.nitradoConnId, guildId: job.guildId },
        select: {
          id: true,
          guildId: true,
          encryptedToken: true,
          nitradoServerId: true,
          status: true,
          keepOnlineEnabled: true,
        },
      });
    } catch (e) {
      await failJob(
        job.id,
        job.guildId,
        job.attempts,
        job.maxAttempts,
        `Connection-Lookup fehlgeschlagen: ${(e as Error).message}`,
        true,
        isServerBanOperation(job.operation),
      );
      return;
    }

    if (!conn || conn.status !== 'ACTIVE') {
      await failJob(
        job.id,
        job.guildId,
        job.attempts,
        job.maxAttempts,
        'Connection inaktiv oder geloescht',
        true,
        isServerBanOperation(job.operation),
      );
      return;
    }

    const payload = (job.payload as JobPayload | null) ?? {};

    // NIT-007: Unbekannte Operationen sind permanent ungueltig -> sofort DEAD,
    // statt sie sinnlos maxAttempts-mal zu wiederholen.
    if (!KNOWN_OPERATIONS.has(job.operation)) {
      await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, `Unbekannte Operation: ${job.operation}`, true);
      return;
    }

    // Nitrado-1B: Whitelist-Retry-Reihenfolge wird durch die aktuelle lokale
    // Source-of-Truth aufgeloest. Diese Pruefung liegt unter dem Connection-Lock
    // und bewusst VOR Token-Entschluesselung/Remote-API. Ein bereits obsoleter
    // Job wird daher auch bei spaeter kaputtem Token nicht faelschlich DEAD.
    if (job.operation === 'WHITELIST_ADD' || job.operation === 'WHITELIST_REMOVE') {
      if (typeof payload.gameId !== 'string' || !payload.gameId.trim()) {
        await failJob(job.id, job.guildId, job.attempts, job.maxAttempts, 'payload.gameId fehlt', true);
        return;
      }
      let decision;
      try {
        decision = await decideWhitelistRemoteIntent(
          job.operation,
          job.guildId,
          conn.id,
          payload.gameId,
        );
      } catch (error) {
        await failJob(
          job.id,
          job.guildId,
          job.attempts,
          job.maxAttempts,
          `Whitelist-Intent-Lookup fehlgeschlagen: ${(error as Error).message}`,
          false,
        );
        return;
      }
      if (!decision.execute) {
        await finishSupersededWhitelistJob({
          id: job.id,
          guildId: job.guildId,
          operation: job.operation,
          desiredState: decision.desiredState,
          reason: decision.reason,
        });
        return;
      }
    }

    // NIT-005: Token-Entschluesselung + Client-Konstruktion lagen frueher
    // AUSSERHALB des Fehlerblocks -> ein korrupter Token liess den Job dauerhaft
    // auf RUNNING haengen (nur alle 5min via Stale-Recovery, endlos). Jetzt
    // deterministisch permanent DEAD.
    let client: NitradoClient;
    try {
      const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
      client = new NitradoClient(token);
    } catch (e) {
      await failJob(
        job.id,
        job.guildId,
        job.attempts,
        job.maxAttempts,
        `Token-Entschluesselung fehlgeschlagen: ${(e as Error).message}`,
        true,
        isServerBanOperation(job.operation),
      );
      return;
    }

    // Wird gesetzt, sobald ein echter Gameserver-Identifier nur im RAM vorliegt.
    // Fehlertexte werden vor Persistenz/Logging dagegen redigiert.
    let sensitiveIdentifier: string | null = null;

    try {
      switch (job.operation) {
        case 'WHITELIST_ADD': {
          if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer WHITELIST_ADD');
          if (typeof payload.gameId !== 'string') throw new Error('payload.gameId fehlt');
          await client.addToWhitelist(conn.nitradoServerId, payload.gameId);
          break;
        }
        case 'WHITELIST_REMOVE': {
          if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer WHITELIST_REMOVE');
          if (typeof payload.gameId !== 'string') throw new Error('payload.gameId fehlt');
          await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);
          break;
        }
        case 'SERVER_BAN_ADD': {
          if (!conn.nitradoServerId) throw new PermanentJobError('Kein nitradoServerId fuer SERVER_BAN_ADD');
          const banPayload = parseServerBanJobPayload(payload);
          if (!banPayload.encryptedIdentifier) {
            throw new PermanentJobError('SERVER_BAN_ADD ohne verschluesselten Identifier');
          }

          const ban = await prisma.serverBanEntry.findFirst({
            where: { id: banPayload.banId, guildId: job.guildId, nitradoConnId: conn.id },
            select: { id: true, identityHash: true, active: true, expiresAt: true, appliedRemotely: true },
          });
          if (!ban) throw new PermanentJobError('Server-Ban-Eintrag im Job-Scope nicht gefunden');

          // Stale Add: lokal inzwischen aufgehoben/abgelaufen -> niemals remote bannen.
          if (!isBanActive(ban, new Date())) break;
          if (ban.appliedRemotely) break;

          try {
            sensitiveIdentifier = decrypt(banPayload.encryptedIdentifier, config.security.encryptionKey);
          } catch {
            throw new PermanentJobError('Server-Ban-Identifier konnte nicht entschluesselt werden');
          }
          if (!matchesBanIdentifier(sensitiveIdentifier, ban.identityHash, config.security.encryptionKey)) {
            throw new PermanentJobError('Server-Ban-Identifier passt nicht zur gespeicherten HMAC-Identitaet');
          }

          // Unter demselben per-Connection-Advisory-Lock alle inzwischen wieder
          // PENDING gewordenen alten WHITELIST_ADD-Jobs fuer exakt diesen Namen
          // neutralisieren. Ein zuvor RUNNING gewesener Add-Job muss den Lock erst
          // freigeben und ist zu diesem Zeitpunkt entweder DONE oder wieder PENDING.
          const pendingWhitelistAdds = await prisma.nitradoJob.findMany({
            where: {
              guildId: job.guildId,
              nitradoConnId: conn.id,
              operation: 'WHITELIST_ADD',
              status: 'PENDING',
            },
            select: { id: true, payload: true },
            take: 200,
          });
          const staleWhitelistAddIds = pendingWhitelistAdds
            .filter(candidate => {
              const gameId = jobPayloadGameId(candidate.payload);
              return gameId !== null && gameId.toLowerCase() === sensitiveIdentifier!.toLowerCase();
            })
            .map(candidate => candidate.id);
          if (staleWhitelistAddIds.length > 0) {
            await prisma.nitradoJob.updateMany({
              where: {
                id: { in: staleWhitelistAddIds },
                guildId: job.guildId,
                nitradoConnId: conn.id,
                operation: 'WHITELIST_ADD',
                status: 'PENDING',
              },
              data: { status: 'DONE', payload: {}, lastError: null, updatedAt: new Date() },
            });
          }

          // Harte Remote-Reihenfolge innerhalb EINER serialisierten Worker-
          // Ausfuehrung: zuerst Whitelist entfernen, erst danach Banlist setzen.
          // Schlaegt die Whitelist-Mutation fehl, greift der normale Job-Retry und
          // es wird in diesem Versuch KEIN Remote-Bann gesetzt.
          await client.removeFromWhitelist(conn.nitradoServerId, sensitiveIdentifier);

          // Idempotenz auch nach verlorener HTTP-Antwort: vor POST pruefen, ob
          // derselbe HMAC bereits auf der Remote-Banlist existiert.
          const before = await client.getBanlist(conn.nitradoServerId);
          const alreadyRemote = before.some(e =>
            matchesBanIdentifier(e.identifier, ban.identityHash, config.security.encryptionKey),
          );
          if (!alreadyRemote) {
            await client.addToBanlist(conn.nitradoServerId, sensitiveIdentifier);
          }

          await prisma.serverBanEntry.updateMany({
            where: { id: ban.id, guildId: job.guildId, nitradoConnId: conn.id },
            data: { appliedRemotely: true },
          });

          // Race-Kompensation: falls waehrend des Remote-Calls lokal aufgehoben
          // wurde, sofort einen Removal-Job nachziehen.
          const after = await prisma.serverBanEntry.findFirst({
            where: { id: ban.id, guildId: job.guildId, nitradoConnId: conn.id },
            select: { active: true, expiresAt: true },
          });
          if (after && !isBanActive(after, new Date())) {
            await enqueueServerBanRemove(
              prisma as unknown as BanOutboxClient,
              { guildId: job.guildId, nitradoConnId: conn.id },
              ban.id,
            );
          }
          break;
        }
        case 'SERVER_BAN_REMOVE': {
          if (!conn.nitradoServerId) throw new PermanentJobError('Kein nitradoServerId fuer SERVER_BAN_REMOVE');
          const banPayload = parseServerBanJobPayload(payload);
          const ban = await prisma.serverBanEntry.findFirst({
            where: { id: banPayload.banId, guildId: job.guildId, nitradoConnId: conn.id },
            select: { id: true, identityHash: true, active: true, expiresAt: true, appliedRemotely: true },
          });
          if (!ban) throw new PermanentJobError('Server-Ban-Eintrag im Job-Scope nicht gefunden');

          // Stale Remove: lokal wieder aktiv -> niemals remote entbannen.
          if (isBanActive(ban, new Date())) break;
          if (!ban.appliedRemotely) break;

          // Kein reversibler Identifier in der DB: Remote-Liste lesen und jeden
          // Identifier nur im RAM gegen den gespeicherten HMAC pruefen.
          const remote = await client.getBanlist(conn.nitradoServerId);
          const match = remote.find(e =>
            matchesBanIdentifier(e.identifier, ban.identityHash, config.security.encryptionKey),
          );
          if (match) {
            sensitiveIdentifier = match.identifier;
            await client.removeFromBanlist(conn.nitradoServerId, sensitiveIdentifier);
          }

          // Kein Match bedeutet ebenfalls: Remote-Bann ist bereits weg.
          await prisma.serverBanEntry.updateMany({
            where: { id: ban.id, guildId: job.guildId, nitradoConnId: conn.id },
            data: { appliedRemotely: false },
          });

          // Race-Kompensation: wurde waehrend des Remove-Calls lokal erneut
          // gebannt, den gerade bekannten Identifier sofort wieder als ADD
          // einreihen. Falls kein Remote-Match existierte, kann nur ein neuer
          // /server-ban mit bekanntem Identifier das Add sicher ausloesen.
          const after = await prisma.serverBanEntry.findFirst({
            where: { id: ban.id, guildId: job.guildId, nitradoConnId: conn.id },
            select: { active: true, expiresAt: true },
          });
          if (after && isBanActive(after, new Date()) && sensitiveIdentifier) {
            await enqueueServerBanAdd(
              prisma as unknown as BanOutboxClient,
              { guildId: job.guildId, nitradoConnId: conn.id },
              ban.id,
              sensitiveIdentifier,
              config.security.encryptionKey,
            );
          }
          break;
        }
        case 'KEEPALIVE': {
          const ok = await client.validateToken();
          if (!ok) throw new Error('Token ungueltig');
          break;
        }
        case 'DOWNLOAD_ADM': {
          // Echte ADM-Verarbeitung laeuft im ADM-Sync-Cron. Hier nur Token-Check.
          const ok = await client.validateToken();
          if (!ok) throw new Error('Token ungueltig');
          break;
        }
        case 'RESTART_IF_DOWN': {
          if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer RESTART_IF_DOWN');

          // KEEP: Ein bereits geclaimter Job darf nach einer Deaktivierung nicht
          // mehr remote eingreifen. Erste Schranke vor jeder Status/API-Arbeit.
          if (!conn.keepOnlineEnabled) {
            logger.debug(`Keep-Online skip: fuer Connection ${conn.id} deaktiviert.`);
            break;
          }

          const status = await client.getServiceStatus(conn.nitradoServerId);
          // KEEP-004: Nur einen explizit gestoppten Service starten. `suspended`
          // ist ein administrativer Zustand und darf niemals automatisch umgangen werden.
          if (status === 'stopped') {
            // Disable-Race schliessen: Die Einstellung kann sich waehrend der
            // Remote-Statusabfrage geaendert haben. Unmittelbar vor `start()`
            // deshalb erneut die kanonische DB-Wahrheit lesen.
            const freshKeepOnline = await prisma.nitradoConnection.findFirst({
              where: { id: conn.id, guildId: job.guildId },
              select: { keepOnlineEnabled: true },
            });
            if (!freshKeepOnline?.keepOnlineEnabled) {
              logger.info(`Keep-Online: Auto-Start ${job.id} nach zwischenzeitlicher Deaktivierung verworfen.`);
              break;
            }

            await client.start(conn.nitradoServerId);
            logAudit('NITRADO_AUTO_START', 'NITRADO', { guildId: job.guildId, jobId: job.id, details: { nitradoConnId: conn.id, statusBefore: status } });
          } else {
            logger.debug(`PermaOnly skip: server ${conn.nitradoServerId} status=${status}`);
          }
          break;
        }
        default:
          throw new Error(`Unbekannte Operation: ${job.operation}`);
      }

      await prisma.nitradoJob.updateMany({
        where: { id: job.id, guildId: job.guildId },
        data: {
          status: 'DONE',
          lastError: null,
          updatedAt: new Date(),
          ...(isServerBanOperation(job.operation) ? { payload: {} } : {}),
        },
      });
      logAudit('NITRADO_JOB_DONE', 'NITRADO', { guildId: job.guildId, jobId: job.id, operation: job.operation });
      emitGuildEvent(job.guildId, { type: 'nitrado.job.updated', payload: { guildId: job.guildId, jobId: job.id, status: 'DONE' } });
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      const msg = sensitiveIdentifier
        ? rawMsg.split(sensitiveIdentifier).join('[REDACTED]')
        : rawMsg;
      const httpStatus = e instanceof NitradoApiError ? e.status : null;
      // 4xx ausser 429 oder explizite Payload/Scope-Verstoesse = permanent.
      const permanent = e instanceof PermanentJobError
        || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429);
      await failJob(
        job.id,
        job.guildId,
        job.attempts,
        job.maxAttempts,
        msg,
        permanent,
        isServerBanOperation(job.operation),
      );
    }
  } finally {
    await connectionLock.release();
  }
}

async function failJob(
  id: string,
  guildId: string,
  attempts: number,
  maxAttempts: number,
  errorMsg: string,
  permanent: boolean,
  scrubPayloadWhenDead = false,
): Promise<void> {
  const nextAttempts = attempts + 1;
  const dead = permanent || nextAttempts >= maxAttempts;
  if (dead) {
    await prisma.nitradoJob.updateMany({
      where: { id, guildId },
      data: {
        status: 'DEAD',
        attempts: nextAttempts,
        lastError: errorMsg.slice(0, 1000),
        updatedAt: new Date(),
        ...(scrubPayloadWhenDead ? { payload: {} } : {}),
      },
    });
    logAudit('NITRADO_JOB_DEAD', 'NITRADO', { guildId, jobId: id, attempts: nextAttempts, error: errorMsg });
    emitGuildEvent(guildId, { type: 'nitrado.job.updated', payload: { guildId, jobId: id, status: 'DEAD' } });
  } else {
    const backoffSec = BACKOFF_BASE_SECONDS * Math.pow(2, nextAttempts - 1);
    const nextRunAt = new Date(Date.now() + backoffSec * 1000);
    await prisma.nitradoJob.updateMany({
      where: { id, guildId },
      data: { status: 'PENDING', attempts: nextAttempts, lastError: errorMsg.slice(0, 1000), nextRunAt, updatedAt: new Date() },
    });
    logger.warn(`NitradoJob ${id} fehlgeschlagen (${nextAttempts}/${maxAttempts}), retry in ${backoffSec}s: ${errorMsg}`);
    emitGuildEvent(guildId, { type: 'nitrado.job.updated', payload: { guildId, jobId: id, status: 'PENDING' } });
  }
}

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Recovery: RUNNING-Jobs, die laenger als STALE_RUNNING_MS keine
    // updatedAt-Aenderung mehr hatten, sind nach Crash/Deploy verwaist
    // und werden wieder auf PENDING zurueckgesetzt.
    const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS);
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Recovery-Sweep ueber alle Guilds; betrifft nur eigene Job-Outbox.
    const stale = await prisma.nitradoJob.updateMany({
      where: { status: 'RUNNING', updatedAt: { lt: staleCutoff } },
      data: { status: 'PENDING', updatedAt: new Date() },
    });
    if (stale.count > 0) {
      logger.warn(`NitradoJob-Worker: ${stale.count} verwaiste RUNNING-Jobs auf PENDING zurueckgesetzt`);
    }

    await reconcileRemoteBanRemovals(new Date());

    // NIT-008: Retention-Sweep (hoechstens 1x/Stunde). Alte abgeschlossene Jobs
    // entfernen; DEAD laenger halten fuer Diagnose.
    if (Date.now() - lastRetentionAt > RETENTION_INTERVAL_MS) {
      lastRetentionAt = Date.now();
      const [doneDel, deadDel] = await Promise.all([
        // eslint-disable-next-line local/no-unscoped-prisma-query -- Retention-Sweep ueber alle Guilds; loescht nur eigene, abgeschlossene Outbox-Jobs.
        prisma.nitradoJob.deleteMany({ where: { status: 'DONE', updatedAt: { lt: new Date(Date.now() - DONE_RETENTION_MS) } } }),
        // eslint-disable-next-line local/no-unscoped-prisma-query -- Retention-Sweep ueber alle Guilds; loescht nur eigene, DEAD-Outbox-Jobs.
        prisma.nitradoJob.deleteMany({ where: { status: 'DEAD', updatedAt: { lt: new Date(Date.now() - DEAD_RETENTION_MS) } } }),
      ]);
      if (doneDel.count + deadDel.count > 0) {
        logger.info(`NitradoJob-Retention: ${doneDel.count} DONE + ${deadDel.count} DEAD entfernt.`);
      }
    }

    // Atomar: PENDING -> RUNNING fuer max MAX_PARALLEL Jobs deren nextRunAt erreicht ist.
    // WICHTIG: Pro nitradoConnId NUR ein Job parallel — Whitelist-Settings sind
    // Read-Modify-Write auf einem geteilten String und MUESSEN serialisiert werden,
    // sonst ueberschreiben sich konkurrente Updates gegenseitig (Datenverlust).
    // Der zusaetzliche DB-Advisory-Lock in executeJob macht diese Garantie auch
    // ueber mehrere Prozessinstanzen hinweg verbindlich.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Worker scannt globale Outbox; Scope-Check erfolgt im executeJob.
    const candidates = await prisma.nitradoJob.findMany({
      where: { status: 'PENDING', nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_PARALLEL * 4, // genug Vorrat damit auch bei Conn-Konflikten MAX_PARALLEL erreicht wird
      select: { id: true, guildId: true, nitradoConnId: true },
    });
    if (candidates.length === 0) return;

    // Per-Conn-Serialisierung innerhalb dieser Poll-Iteration. Der Advisory-Lock
    // in executeJob ist die zusaetzliche Instanzgrenze gegen Cross-Process-Races.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- nur RUNNING-Connection-IDs ermitteln
    const runningConns = await prisma.nitradoJob.findMany({
      where: { status: 'RUNNING' },
      select: { nitradoConnId: true },
    });
    const busyConns = new Set(runningConns.map(r => r.nitradoConnId));
    const filtered: typeof candidates = [];
    for (const c of candidates) {
      if (filtered.length >= MAX_PARALLEL) break;
      if (busyConns.has(c.nitradoConnId)) continue;
      busyConns.add(c.nitradoConnId);
      filtered.push(c);
    }
    if (filtered.length === 0) return;

    const claimed: Array<{ id: string; guildId: string }> = [];
    for (const c of filtered) {
      const upd = await prisma.nitradoJob.updateMany({
        where: { id: c.id, guildId: c.guildId, status: 'PENDING' },
        data: { status: 'RUNNING', updatedAt: new Date() },
      });
      if (upd.count === 1) claimed.push({ id: c.id, guildId: c.guildId });
    }
    if (claimed.length === 0) return;

    await Promise.allSettled(claimed.map(c => executeJob(c.id)));
  } catch (e) {
    logger.error('NitradoJob-Worker pollOnce-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startNitradoJobWorker(): void {
  if (timer) return;
  logger.info(`NitradoJob-Worker gestartet (Intervall ${JOB_POLL_INTERVAL_MS}ms, Parallel ${MAX_PARALLEL})`);
  timer = setInterval(() => { void pollOnce(); }, JOB_POLL_INTERVAL_MS);
  // F-013/NIT-010: Der Poll-Timer darf einen ansonsten beendeten Prozess
  // nicht kuenstlich am Leben halten; Shutdown wird ueber den expliziten Stop-Hook gesteuert.
  timer.unref?.();
}

export function stopNitradoJobWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * NIT-010: Geordneter Shutdown — stoppt neue Polls und wartet, bis ein evtl.
 * laufender Poll (in-flight Jobs) fertig ist, bevor Prisma getrennt wird.
 */
export async function drainAndStopJobWorker(timeoutMs = 10_000): Promise<void> {
  stopNitradoJobWorker();
  const start = Date.now();
  while (running && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (running) {
    logger.warn('NitradoJob-Worker: Drain-Timeout — laufender Poll wurde nicht rechtzeitig fertig.');
  }
}
