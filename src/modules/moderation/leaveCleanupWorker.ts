import { config } from '../../config';
import { logger } from '../../utils/logger';
import { cleanupGuildMemberData } from './guildMemberCleanup';
import { runLeaveLinkEconomyAfterConfirmedWhitelistStep } from './leaveCleanupLinkEconomy';
import {
  advanceLeaveCleanupStep,
  claimNextLeaveCleanupRequest,
  completeLeaveCleanupRequest,
  deferLeaveCleanupRequest,
  readLeaveCleanupDetails,
  recoverStaleLeaveCleanupRequests,
  retryOrDeadLetterLeaveCleanupRequest,
  type LeaveCleanupRequestLike,
} from './leaveCleanupSaga';
import { sanitizeLeaveCleanupError } from './leaveCleanupSecurity';
import { runLeaveStatsSessionsCleanupStep } from './leaveCleanupStatsSessions';
import { runLeaveWhitelistCleanupStep } from './leaveCleanupWhitelist';

const POLL_INTERVAL_MS = 15_000;
const MAX_JOBS_PER_TICK = 10;
let timer: NodeJS.Timeout | null = null;
let running = false;

export type LeaveCleanupWorkerResult = 'COMPLETED' | 'WAITING';

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

  for (let guard = 0; guard < 8; guard++) {
    const details = readLeaveCleanupDetails(request.details);
    if (!details) throw new Error('Leave-Worker: ungueltige Request-Metadaten.');
    const guildId = details.guildId;
    const discordId = request.discordId;

    if (details.step === 'WHITELIST') {
      const result = await runLeaveWhitelistCleanupStep(guildId, discordId);
      if (result.state !== 'DONE') {
        await deferLeaveCleanupRequest(request, 'WHITELIST_PENDING');
        return 'WAITING';
      }
      request = await advanceLeaveCleanupStep(request, 'WHITELIST');
      continue;
    }

    if (details.step === 'STATS_SESSIONS') {
      const result = await runLeaveStatsSessionsCleanupStep(guildId, discordId);
      if (result.state !== 'DONE') {
        await deferLeaveCleanupRequest(request, result.reason ?? 'ACTIVE_SESSION');
        return 'WAITING';
      }
      request = await advanceLeaveCleanupStep(request, 'STATS_SESSIONS');
      continue;
    }

    if (details.step === 'LINK_ECONOMY') {
      const result = await runLeaveLinkEconomyAfterConfirmedWhitelistStep(guildId, discordId);
      if (result.state !== 'DONE') {
        await deferLeaveCleanupRequest(request, result.reason ?? 'ACTIVE_LOTTERY');
        return 'WAITING';
      }
      request = await advanceLeaveCleanupStep(request, 'LINK_ECONOMY');
      continue;
    }

    if (details.step === 'GUILD_DATA') {
      const result = await cleanupGuildMemberData(guildId, discordId);
      if (!result.performed && result.reason === 'transaction_failed') {
        throw new Error('Leave-Worker: Guild-Daten-Cleanup fehlgeschlagen.');
      }
      request = await advanceLeaveCleanupStep(request, 'GUILD_DATA');
      continue;
    }

    if (details.step === 'COMPLETE') {
      await completeLeaveCleanupRequest(request, guildId, config.security.encryptionKey);
      return 'COMPLETED';
    }
  }

  throw new Error('Leave-Worker: Substep-Guard ueberschritten.');
}

/** Ein Worker-Tick; exportiert fuer deterministische Runtime-/Restart-Tests. */
export async function runLeaveCleanupWorkerOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  let handled = 0;
  try {
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const request = await claimNextLeaveCleanupRequest();
      if (!request) break;
      handled++;
      try {
        await processLeaveCleanupRequest(request);
      } catch (error) {
        try {
          const state = await retryOrDeadLetterLeaveCleanupRequest(request, error);
          const message = sanitizeLeaveCleanupError(error);
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
 * Startup-Recovery wird vor dem Timer ausgefuehrt. Die eigentliche Remote-
 * Verarbeitung wird nicht in den Prozessstart hinein blockierend awaited.
 */
export async function startLeaveCleanupWorker(): Promise<void> {
  if (timer) return;
  try {
    const recovered = await recoverStaleLeaveCleanupRequests();
    if (recovered > 0) logger.warn(`Leave-Cleanup: ${recovered} stale Request(s) nach Restart freigegeben.`);
  } catch (error) {
    logger.error(`Leave-Cleanup Restart-Recovery fehlgeschlagen: ${sanitizeLeaveCleanupError(error)}`);
  }

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
}
