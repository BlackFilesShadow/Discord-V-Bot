import { config } from '../../config';
import { logger } from '../../utils/logger';
import { cleanupGuildMemberData } from './guildMemberCleanup';
import { renewLeaveCleanupClaimLease } from './leaveCleanupLease';
import { runLeaveLinkEconomyAfterConfirmedWhitelistStep } from './leaveCleanupLinkEconomy';
import { finalizeLeaveRejoinState } from './leaveCleanupRejoin';
import {
  advanceLeaveCleanupStep,
  claimNextLeaveCleanupRequest,
  completeLeaveCleanupRequest,
  deferLeaveCleanupRequest,
  leaveCleanupJobKey,
  readLeaveCleanupDetails,
  recoverStaleLeaveCleanupRequests,
  retryOrDeadLetterLeaveCleanupRequest,
  type LeaveCleanupRequestLike,
} from './leaveCleanupSaga';
import { sanitizeLeaveCleanupError } from './leaveCleanupSecurity';
import { runLeaveStatsSessionsCleanupStep } from './leaveCleanupStatsSessions';
import { runLeaveWhitelistCleanupStep } from './leaveCleanupWhitelist';
import { recoverPendingGoodbyeDeliveries, updateGoodbyeCleanupFailure } from '../welcome/goodbyeStatus';

const POLL_INTERVAL_MS = 15_000;
const RECOVERY_INTERVAL_MS = 60_000;
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_JOBS_PER_TICK = 10;
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRecoveryAt = 0;

export type LeaveCleanupWorkerResult = 'COMPLETED' | 'WAITING';

class LeaveCleanupProcessingError extends Error {
  constructor(
    public readonly request: LeaveCleanupRequestLike,
    public readonly originalError: unknown,
  ) {
    super(sanitizeLeaveCleanupError(originalError));
    this.name = 'LeaveCleanupProcessingError';
  }
}

async function recoverStaleIfDue(now: Date = new Date()): Promise<number> {
  const nowMs = now.getTime();
  if (lastRecoveryAt > 0 && nowMs - lastRecoveryAt < RECOVERY_INTERVAL_MS) return 0;
  lastRecoveryAt = nowMs;

  try {
    const recovered = await recoverStaleLeaveCleanupRequests(now);
    if (recovered > 0) {
      logger.warn(`Leave-Cleanup: ${recovered} stale Request(s) fuer Failover freigegeben.`);
    }
    return recovered;
  } catch (error) {
    logger.error(`Leave-Cleanup Stale-Recovery fehlgeschlagen: ${sanitizeLeaveCleanupError(error)}`);
    return 0;
  }
}

/**
 * Haelt den Claim waehrend eines potenziell langen destruktiven Substeps aktiv.
 *
 * - vor dem Step: sofortige CAS-Erneuerung
 * - waehrenddessen: Heartbeat alle 60s (deutlich unter 5-Min-Stale-Grenze)
 * - nach dem Step: laufenden Heartbeat abwarten und Claim erneut CAS-pruefen
 *
 * Jede erfolgreiche Erneuerung wird dem aufrufenden Worker sofort als neuer
 * Request-Snapshot zurueckgegeben. Damit verwenden nachfolgende Defer/Retry/
 * Advance/Finalizer niemals ein altes claimedAt. Verliert der Worker den Claim,
 * bleibt der Step ohne weiteren Checkpoint retrybar/fail-closed.
 */
async function runWithLeaseHeartbeat<T>(
  initialRequest: LeaveCleanupRequestLike,
  guildId: string,
  discordId: string,
  onLease: (request: LeaveCleanupRequestLike) => void,
  operation: () => Promise<T>,
): Promise<T> {
  let currentRequest = await renewLeaveCleanupClaimLease(initialRequest, guildId, discordId);
  onLease(currentRequest);

  let heartbeatError: unknown = null;
  let heartbeatChain: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    heartbeatChain = heartbeatChain.then(async () => {
      if (heartbeatError) return;
      try {
        currentRequest = await renewLeaveCleanupClaimLease(currentRequest, guildId, discordId);
        onLease(currentRequest);
      } catch (error) {
        heartbeatError = error;
      }
    });
  }, LEASE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const result = await operation();
    clearInterval(heartbeat);
    await heartbeatChain;
    if (heartbeatError) throw heartbeatError;

    // Finaler Ownership-Check direkt nach dem Side-Effect. Das schliesst auch
    // kurze Schritte, bei denen der periodische Timer noch nicht feuern musste.
    currentRequest = await renewLeaveCleanupClaimLease(currentRequest, guildId, discordId);
    onLease(currentRequest);
    return result;
  } catch (error) {
    clearInterval(heartbeat);
    await heartbeatChain;
    if (heartbeatError) throw heartbeatError;
    throw error;
  }
}

/**
 * Fuehrt genau einen persistent geclaimten Request entlang seiner gespeicherten
 * Substep-Position fort. Jeder irreversible Schritt wird VOR dem naechsten
 * Destruktiv-Schritt persistiert, wodurch Restart-Recovery nie wieder bei einer
 * bereits verlorenen Identitaetsquelle beginnen muss.
 */
export async function processLeaveCleanupRequest(
  initialRequest: LeaveCleanupRequestLike,
): Promise<LeaveCleanupWorkerResult> {
  let request = initialRequest;

  try {
    for (let guard = 0; guard < 8; guard++) {
      const details = readLeaveCleanupDetails(request.details);
      if (!details) throw new Error('Leave-Worker: ungueltige Request-Metadaten.');
      const guildId = details.guildId;
      const discordId = request.discordId;

      if (request.status !== 'IN_PROGRESS') {
        throw new Error('Leave-Worker: Request ist nicht IN_PROGRESS.');
      }
      let expectedJobKey = '';
      try {
        expectedJobKey = leaveCleanupJobKey(guildId, discordId);
      } catch {
        throw new Error('Leave-Worker: ungueltiger Guild/User-Scope im Request.');
      }
      if (request.userId !== expectedJobKey) {
        throw new Error('Leave-Worker: persistenter Job-Key passt nicht zum Guild/User-Scope.');
      }

      if (details.step === 'WHITELIST') {
        const result = await runWithLeaseHeartbeat(
          request,
          guildId,
          discordId,
          renewed => { request = renewed; },
          () => runLeaveWhitelistCleanupStep(guildId, discordId, request.id),
        );
        if (result.state !== 'DONE') {
          await deferLeaveCleanupRequest(request, 'WHITELIST_PENDING');
          return 'WAITING';
        }
        request = await advanceLeaveCleanupStep(request, 'WHITELIST');
        continue;
      }

      if (details.step === 'STATS_SESSIONS') {
        const result = await runWithLeaseHeartbeat(
          request,
          guildId,
          discordId,
          renewed => { request = renewed; },
          () => runLeaveStatsSessionsCleanupStep(guildId, discordId),
        );
        if (result.state !== 'DONE') {
          await deferLeaveCleanupRequest(request, result.reason ?? 'ACTIVE_SESSION');
          return 'WAITING';
        }
        request = await advanceLeaveCleanupStep(request, 'STATS_SESSIONS');
        continue;
      }

      if (details.step === 'LINK_ECONOMY') {
        if (details.scope === 'STANDARD') {
          request = await advanceLeaveCleanupStep(request, 'LINK_ECONOMY');
          continue;
        }
        const result = await runWithLeaseHeartbeat(
          request,
          guildId,
          discordId,
          renewed => { request = renewed; },
          () => runLeaveLinkEconomyAfterConfirmedWhitelistStep(guildId, discordId),
        );
        if (result.state !== 'DONE') {
          await deferLeaveCleanupRequest(request, result.reason ?? 'ACTIVE_LOTTERY');
          return 'WAITING';
        }
        request = await advanceLeaveCleanupStep(request, 'LINK_ECONOMY');
        continue;
      }

      if (details.step === 'GUILD_DATA') {
        if (details.scope === 'STANDARD') {
          request = await advanceLeaveCleanupStep(request, 'GUILD_DATA');
          continue;
        }
        const result = await runWithLeaseHeartbeat(
          request,
          guildId,
          discordId,
          renewed => { request = renewed; },
          () => cleanupGuildMemberData(guildId, discordId),
        );
        if (!result.performed && result.reason === 'transaction_failed') {
          throw new Error('Leave-Worker: Guild-Daten-Cleanup fehlgeschlagen.');
        }

        // Rejoin kann waehrend des laufenden Remote-/DB-Cleanups eintreffen.
        // Der Heartbeat hat den Claim bis unmittelbar nach GUILD_DATA aktiv
        // gehalten. Der Finalizer prueft danach denselben Token+Lease-Snapshot
        // unter FOR UPDATE, bevor Fresh-State mutiert wird.
        await finalizeLeaveRejoinState(request, guildId, discordId);

        request = await advanceLeaveCleanupStep(request, 'GUILD_DATA');
        continue;
      }

      if (details.step === 'COMPLETE') {
        // Auch ein direkt nach Restart geladener COMPLETE-Claim wird vor dem
        // finalen Rejoin-Check noch einmal auf aktive Ownership erneuert.
        request = await renewLeaveCleanupClaimLease(request, guildId, discordId);
        if (details.scope === 'FULL_PURGE_LEGACY') {
          await finalizeLeaveRejoinState(request, guildId, discordId);
        }
        await completeLeaveCleanupRequest(request, guildId, config.security.encryptionKey);
        return 'COMPLETED';
      }
    }

    throw new Error('Leave-Worker: Substep-Guard ueberschritten.');
  } catch (error) {
    // `request` wird bei jedem Heartbeat und jedem erfolgreichen persistenten
    // Checkpoint aktualisiert. Retry darf niemals mit einem alten Lease-/Step-
    // Snapshot einen spaeteren Zustand zurueckschreiben.
    throw new LeaveCleanupProcessingError(request, error);
  }
}

/** Ein Worker-Tick; exportiert fuer deterministische Runtime-/Restart-Tests. */
export async function runLeaveCleanupWorkerOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  let handled = 0;
  try {
    // Nicht nur beim Prozessstart recovern: Eine bereits laufende zweite
    // Instanz muss einen abgestorbenen Claim nach Ablauf der Lease uebernehmen
    // koennen, ohne selbst neu gestartet werden zu muessen.
    await recoverStaleIfDue();
    await recoverPendingGoodbyeDeliveries().catch(error => {
      logger.warn(`Goodbye-Zustellungs-Recovery fehlgeschlagen: ${sanitizeLeaveCleanupError(error)}`);
    });

    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const request = await claimNextLeaveCleanupRequest();
      if (!request) break;
      handled++;
      try {
        await processLeaveCleanupRequest(request);
      } catch (error) {
        const retryRequest = error instanceof LeaveCleanupProcessingError ? error.request : request;
        const originalError = error instanceof LeaveCleanupProcessingError ? error.originalError : error;
        try {
          const state = await retryOrDeadLetterLeaveCleanupRequest(retryRequest, originalError);
          const message = sanitizeLeaveCleanupError(originalError);
          await updateGoodbyeCleanupFailure(
            retryRequest.id,
            state === 'DEAD' ? 'FAILED' : 'RETRY',
            message,
          ).catch(statusError => {
            logger.warn(`Goodbye-Cleanup-Status konnte nicht aktualisiert werden: ${sanitizeLeaveCleanupError(statusError)}`);
          });
          if (state === 'DEAD') logger.error(`Leave-Cleanup DEAD: ${message}`);
          else logger.warn(`Leave-Cleanup Retry: ${message}`);
        } catch (retryError) {
          logger.error(`Leave-Cleanup Retry-Persistenz fehlgeschlagen: ${sanitizeLeaveCleanupError(retryError)}`);
        }
      }
    }
  } finally {
    running = false;
  }
  return handled;
}

/**
 * Startup-Recovery wird vor dem Timer ausgefuehrt. Danach prueft jeder Worker-
 * Tick dieselbe Recovery gedrosselt erneut, damit Multi-Instance-Failover auch
 * ohne Neustart der ueberlebenden Instanz funktioniert.
 */
export async function startLeaveCleanupWorker(): Promise<void> {
  if (timer) return;
  await recoverStaleIfDue();

  void runLeaveCleanupWorkerOnce().catch(error => {
    logger.error(`Leave-Cleanup initialer Worker-Tick fehlgeschlagen: ${sanitizeLeaveCleanupError(error)}`);
  });
  timer = setInterval(() => {
    void runLeaveCleanupWorkerOnce().catch(error => {
      logger.error(`Leave-Cleanup Worker-Tick fehlgeschlagen: ${sanitizeLeaveCleanupError(error)}`);
    });
  }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopLeaveCleanupWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastRecoveryAt = 0;
}
