/**
 * NitradoJob-Worker — Outbox-Pattern fuer Nitrado-API-Calls.
 *
 * Polling alle JOB_POLL_INTERVAL_MS. Pickt PENDING-Jobs deren `nextRunAt <= now`.
 * Jeder Job laeuft mit:
 *   - atomarem PENDING -> RUNNING + durable Claim-Lease
 *   - Heartbeat waehrend der gesamten Ausfuehrung
 *   - Dispatch je `operation`
 *   - tokengefencetem DONE/DEAD/PENDING-Zustandswechsel
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
 * PostgreSQL-Advisory-Lock pro nitradoConnId. Die DB-Lease fenced den Besitz
 * des einzelnen Jobs; der Connection-Lock serialisiert Remote-Mutationen pro
 * Nitrado-Service.
 */

import crypto from 'crypto';
import { Client as PgClient } from 'pg';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { NitradoClient, NitradoApiError } from './nitradoClient';
import { reconcileWhitelistRemoteIntent } from './whitelistIntent';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { isBanActive } from '../bans/banRegistry';
import { matchesBanIdentifier } from '../bans/banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  parseServerBanJobPayload,
  type BanOutboxClient,
} from '../bans/banOutbox';
import {
  NITRADO_JOB_HEARTBEAT_INTERVAL_MS,
  claimNitradoJob,
  heartbeatNitradoJobClaim,
  recoverStaleNitradoJobClaims,
  transitionClaimedNitradoJob,
  type NitradoJobClaim,
} from './jobLease';

const JOB_POLL_INTERVAL_MS = 10_000;
const MAX_PARALLEL = 4;
const BACKOFF_BASE_SECONDS = 30;
const CONN_LOCK_RETRY_MS = 1_000;
// int4 namespace "NITR" fuer per-Connection Advisory Locks.
const CONN_LOCK_NAMESPACE = 0x4e495452;

// NIT-008: Retention. DONE kurz, DEAD laenger (Diagnose). Sweep max 1x/Stunde.
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionAt = 0;

// Temporaere oder manuell aufgehobene Remote-Banns werden mindestens 1x/min zur
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

class LostJobClaimError extends Error {
  constructor(jobId: string) {
    super(`NitradoJob ${jobId}: Ausfuehrungs-Claim verloren.`);
    this.name = 'LostJobClaimError';
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

async function requeueForConnectionLock(claim: NitradoJobClaim): Promise<void> {
  const requeued = await transitionClaimedNitradoJob(claim, {
    status: 'PENDING',
    nextRunAt: new Date(Date.now() + CONN_LOCK_RETRY_MS),
    updatedAt: new Date(),
  });
  if (!requeued) {
    logger.warn(`NitradoJob ${claim.id}: Connection-Lock-Requeue verworfen, Claim nicht mehr aktuell.`);
  }
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
 * aktuellen lokalen Whitelist-Sollzustand stellen. Superseded Jobs werden erst
 * NACH garantiertem Gegen-Intent tokengefencet DONE quittiert.
 */
async function finishSupersededWhitelistJob(args: {
  claim: NitradoJobClaim;
  operation: 'WHITELIST_ADD' | 'WHITELIST_REMOVE';
  desiredState: string;
  reason: string;
}): Promise<void> {
  const done = await transitionClaimedNitradoJob(args.claim, {
    status: 'DONE',
    lastError: null,
    updatedAt: new Date(),
  });
  if (!done) {
    logger.warn(`NitradoJob ${args.claim.id}: superseded DONE verworfen, Claim nicht mehr aktuell.`);
    return;
  }
  logAudit('NITRADO_WHITELIST_JOB_SUPERSEDED', 'NITRADO', {
    guildId: args.claim.guildId,
    jobId: args.claim.id,
    operation: args.operation,
    desiredState: args.desiredState,
    reason: args.reason,
  });
  emitGuildEvent(args.claim.guildId, {
    type: 'nitrado.job.updated',
    payload: { guildId: args.claim.guildId, jobId: args.claim.id, status: 'DONE' },
  });
}

export async function executeJob(claim: NitradoJobClaim): Promise<void> {
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatChain: Promise<void> = Promise.resolve();
  let claimLost = false;

  const renewClaim = async (): Promise<boolean> => {
    if (claimLost) return false;
    try {
      const owned = await heartbeatNitradoJobClaim(claim);
      if (!owned) claimLost = true;
      return owned;
    } catch (error) {
      claimLost = true;
      logger.warn(`NitradoJob ${claim.id}: Lease-Heartbeat fehlgeschlagen (${String(error)}).`);
      return false;
    }
  };

  const ensureClaimOwned = async (): Promise<void> => {
    if (!(await renewClaim())) throw new LostJobClaimError(claim.id);
  };

  try {
    if (!(await renewClaim())) return;
    heartbeatTimer = setInterval(() => {
      heartbeatChain = heartbeatChain.then(async () => {
        await renewClaim();
      });
    }, NITRADO_JOB_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();

    // eslint-disable-next-line local/no-unscoped-prisma-query -- Claim traegt Job-ID+Guild; die Lease wurde davor exakt fuer diesen Scope erneuert.
    const job = await prisma.nitradoJob.findUnique({ where: { id: claim.id } });
    if (!job || job.guildId !== claim.guildId || job.status !== 'RUNNING') return;

    let connectionLock: HeldConnectionLock | null;
    try {
      connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);
    } catch (error) {
      logger.warn(`NitradoJob ${job.id}: Connection-Lock nicht verfuegbar (${String(error)}), requeue.`);
      await requeueForConnectionLock(claim);
      return;
    }

    if (!connectionLock) {
      await requeueForConnectionLock(claim);
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
          claim,
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
          claim,
          job.attempts,
          job.maxAttempts,
          'Connection inaktiv oder geloescht',
          true,
          isServerBanOperation(job.operation),
        );
        return;
      }

      const payload = (job.payload as JobPayload | null) ?? {};

      if (!KNOWN_OPERATIONS.has(job.operation)) {
        await failJob(claim, job.attempts, job.maxAttempts, `Unbekannte Operation: ${job.operation}`, true);
        return;
      }

      if (job.operation === 'WHITELIST_ADD' || job.operation === 'WHITELIST_REMOVE') {
        if (typeof payload.gameId !== 'string' || !payload.gameId.trim()) {
          await failJob(claim, job.attempts, job.maxAttempts, 'payload.gameId fehlt', true);
          return;
        }
        let decision;
        try {
          decision = await reconcileWhitelistRemoteIntent(
            job.operation,
            job.guildId,
            conn.id,
            payload.gameId,
          );
        } catch (error) {
          await failJob(
            claim,
            job.attempts,
            job.maxAttempts,
            `Whitelist-Intent-Reconcile fehlgeschlagen: ${(error as Error).message}`,
            false,
          );
          return;
        }
        if (!decision.execute) {
          await finishSupersededWhitelistJob({
            claim,
            operation: job.operation,
            desiredState: decision.desiredState,
            reason: decision.reason,
          });
          return;
        }
      }

      let client: NitradoClient;
      try {
        const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
        client = new NitradoClient(token);
      } catch (e) {
        await failJob(
          claim,
          job.attempts,
          job.maxAttempts,
          `Token-Entschluesselung fehlgeschlagen: ${(e as Error).message}`,
          true,
          isServerBanOperation(job.operation),
        );
        return;
      }

      let sensitiveIdentifier: string | null = null;

      try {
        switch (job.operation) {
          case 'WHITELIST_ADD': {
            if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer WHITELIST_ADD');
            if (typeof payload.gameId !== 'string') throw new Error('payload.gameId fehlt');
            await ensureClaimOwned();
            await client.addToWhitelist(conn.nitradoServerId, payload.gameId);
            await reconcileWhitelistRemoteIntent(
              'WHITELIST_ADD',
              job.guildId,
              conn.id,
              payload.gameId,
            );
            break;
          }
          case 'WHITELIST_REMOVE': {
            if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer WHITELIST_REMOVE');
            if (typeof payload.gameId !== 'string') throw new Error('payload.gameId fehlt');
            await ensureClaimOwned();
            await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);
            await reconcileWhitelistRemoteIntent(
              'WHITELIST_REMOVE',
              job.guildId,
              conn.id,
              payload.gameId,
            );
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

            await ensureClaimOwned();
            await client.removeFromWhitelist(conn.nitradoServerId, sensitiveIdentifier);

            const before = await client.getBanlist(conn.nitradoServerId);
            const alreadyRemote = before.some(e =>
              matchesBanIdentifier(e.identifier, ban.identityHash, config.security.encryptionKey),
            );
            if (!alreadyRemote) {
              await ensureClaimOwned();
              await client.addToBanlist(conn.nitradoServerId, sensitiveIdentifier);
            }

            await prisma.serverBanEntry.updateMany({
              where: { id: ban.id, guildId: job.guildId, nitradoConnId: conn.id },
              data: { appliedRemotely: true },
            });

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
            if (isBanActive(ban, new Date())) break;
            if (!ban.appliedRemotely) break;

            const remote = await client.getBanlist(conn.nitradoServerId);
            const match = remote.find(e =>
              matchesBanIdentifier(e.identifier, ban.identityHash, config.security.encryptionKey),
            );
            if (match) {
              sensitiveIdentifier = match.identifier;
              await ensureClaimOwned();
              await client.removeFromBanlist(conn.nitradoServerId, sensitiveIdentifier);
            }

            await prisma.serverBanEntry.updateMany({
              where: { id: ban.id, guildId: job.guildId, nitradoConnId: conn.id },
              data: { appliedRemotely: false },
            });

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
            const ok = await client.validateToken();
            if (!ok) throw new Error('Token ungueltig');
            break;
          }
          case 'RESTART_IF_DOWN': {
            if (!conn.nitradoServerId) throw new Error('Kein nitradoServerId fuer RESTART_IF_DOWN');
            if (!conn.keepOnlineEnabled) {
              logger.debug(`Keep-Online skip: fuer Connection ${conn.id} deaktiviert.`);
              break;
            }

            const status = await client.getServiceStatus(conn.nitradoServerId);
            if (status === 'stopped') {
              const freshKeepOnline = await prisma.nitradoConnection.findFirst({
                where: { id: conn.id, guildId: job.guildId },
                select: { keepOnlineEnabled: true },
              });
              if (!freshKeepOnline?.keepOnlineEnabled) {
                logger.info(`Keep-Online: Auto-Start ${job.id} nach zwischenzeitlicher Deaktivierung verworfen.`);
                break;
              }

              await ensureClaimOwned();
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

        const done = await transitionClaimedNitradoJob(claim, {
          status: 'DONE',
          lastError: null,
          updatedAt: new Date(),
          ...(isServerBanOperation(job.operation) ? { payload: {} } : {}),
        });
        if (!done) {
          logger.warn(`NitradoJob ${job.id}: DONE verworfen, Claim nicht mehr aktuell.`);
          return;
        }
        logAudit('NITRADO_JOB_DONE', 'NITRADO', { guildId: job.guildId, jobId: job.id, operation: job.operation });
        emitGuildEvent(job.guildId, { type: 'nitrado.job.updated', payload: { guildId: job.guildId, jobId: job.id, status: 'DONE' } });
      } catch (e) {
        if (e instanceof LostJobClaimError) {
          logger.warn(e.message);
          return;
        }
        const rawMsg = e instanceof Error ? e.message : String(e);
        const msg = sensitiveIdentifier
          ? rawMsg.split(sensitiveIdentifier).join('[REDACTED]')
          : rawMsg;
        const httpStatus = e instanceof NitradoApiError ? e.status : null;
        const permanent = e instanceof PermanentJobError
          || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429);
        await failJob(
          claim,
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
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatChain.catch(() => undefined);
  }
}

async function failJob(
  claim: NitradoJobClaim,
  attempts: number,
  maxAttempts: number,
  errorMsg: string,
  permanent: boolean,
  scrubPayloadWhenDead = false,
): Promise<void> {
  const nextAttempts = attempts + 1;
  const dead = permanent || nextAttempts >= maxAttempts;
  if (dead) {
    const transitioned = await transitionClaimedNitradoJob(claim, {
      status: 'DEAD',
      attempts: nextAttempts,
      lastError: errorMsg.slice(0, 1000),
      updatedAt: new Date(),
      ...(scrubPayloadWhenDead ? { payload: {} } : {}),
    });
    if (!transitioned) {
      logger.warn(`NitradoJob ${claim.id}: DEAD verworfen, Claim nicht mehr aktuell.`);
      return;
    }
    logAudit('NITRADO_JOB_DEAD', 'NITRADO', { guildId: claim.guildId, jobId: claim.id, attempts: nextAttempts, error: errorMsg });
    emitGuildEvent(claim.guildId, { type: 'nitrado.job.updated', payload: { guildId: claim.guildId, jobId: claim.id, status: 'DEAD' } });
  } else {
    const backoffSec = BACKOFF_BASE_SECONDS * Math.pow(2, nextAttempts - 1);
    const nextRunAt = new Date(Date.now() + backoffSec * 1000);
    const transitioned = await transitionClaimedNitradoJob(claim, {
      status: 'PENDING',
      attempts: nextAttempts,
      lastError: errorMsg.slice(0, 1000),
      nextRunAt,
      updatedAt: new Date(),
    });
    if (!transitioned) {
      logger.warn(`NitradoJob ${claim.id}: Retry-Requeue verworfen, Claim nicht mehr aktuell.`);
      return;
    }
    logger.warn(`NitradoJob ${claim.id} fehlgeschlagen (${nextAttempts}/${maxAttempts}), retry in ${backoffSec}s: ${errorMsg}`);
    emitGuildEvent(claim.guildId, { type: 'nitrado.job.updated', payload: { guildId: claim.guildId, jobId: claim.id, status: 'PENDING' } });
  }
}

async function pollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const recovered = await recoverStaleNitradoJobClaims(new Date());
    if (recovered > 0) {
      logger.warn(`NitradoJob-Worker: ${recovered} verwaiste RUNNING-Claims auf PENDING zurueckgesetzt`);
    }

    await reconcileRemoteBanRemovals(new Date());

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

    // eslint-disable-next-line local/no-unscoped-prisma-query -- Worker scannt globale Outbox; Scope-Check erfolgt im Claim+executeJob.
    const candidates = await prisma.nitradoJob.findMany({
      where: { status: 'PENDING', nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_PARALLEL * 4,
      select: { id: true, guildId: true, nitradoConnId: true },
    });
    if (candidates.length === 0) return;

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

    const claimed: NitradoJobClaim[] = [];
    for (const c of filtered) {
      const claim = await claimNitradoJob({ id: c.id, guildId: c.guildId });
      if (claim) claimed.push(claim);
    }
    if (claimed.length === 0) return;

    await Promise.allSettled(claimed.map(executeJob));
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
