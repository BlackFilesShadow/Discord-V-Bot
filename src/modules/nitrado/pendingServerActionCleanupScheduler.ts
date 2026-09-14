/**
 * PendingServerAction-Cleanup-Scheduler.
 *
 * PENDING/CONSUMED/verwaiste RUNNING Step-Up-Aktionen ("/confirm-action"-
 * Warteschlange fuer REMOVE_MONEY, FORCE_LINK, FORCE_UNLINK, ...) wuerden ohne
 * aktive Bereinigung unbegrenzt in der DB wachsen: deleteExpiredPendingServerActions()
 * existierte bereits (voll getestet), war aber nirgends verdrahtet. Da PENDING-
 * Zeilen laut createPendingServerAction() nur maximal 5 Minuten leben, reicht ein
 * stuendlicher Lauf deutlich -- viel haeufiger als die taegliche Audit-Log-Retention
 * noetig waere. Run laeuft 1x bei Boot (kurzer Delay) und danach stuendlich.
 * unref() damit ein offener Handle den Bot-Shutdown nicht blockiert.
 */
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { deleteExpiredPendingServerActions, type PendingServerActionClient } from './pendingServerAction';

const ONE_HOUR_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000; // 1 min nach Boot, damit ready/restore zuerst durchlaufen

let scheduled = false;
let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

export async function runPendingServerActionCleanupOnce(): Promise<number> {
  try {
    const deleted = await deleteExpiredPendingServerActions(prisma as unknown as PendingServerActionClient);
    if (deleted > 0) {
      logger.info(`pendingServerActionCleanup: ${deleted} abgelaufene/konsumierte Pending-Actions geloescht.`);
    }
    return deleted;
  } catch (e) {
    logger.warn('pendingServerActionCleanup: deleteMany fehlgeschlagen', { err: (e as Error).message });
    return 0;
  }
}

/** Registriert den stuendlichen Run. Idempotent: mehrfache Aufrufe sind no-ops. */
export function startPendingServerActionCleanupScheduler(): void {
  if (scheduled) return;
  scheduled = true;

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void runPendingServerActionCleanupOnce();
  }, STARTUP_DELAY_MS);
  startupTimer.unref?.();

  intervalTimer = setInterval(() => { void runPendingServerActionCleanupOnce(); }, ONE_HOUR_MS);
  intervalTimer.unref?.();
  logger.info('pendingServerActionCleanup: Scheduler aktiv (stuendlich).');
}

/** Stoppt Startup-Delay und Stunden-Timer symmetrisch fuer geordneten Shutdown. */
export function stopPendingServerActionCleanupScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  scheduled = false;
}
