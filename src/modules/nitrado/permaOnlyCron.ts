/**
 * Keep-Online-Cron — reconciled den expliziten Phase-7-Schalter
 * `NitradoConnection.keepOnlineEnabled`.
 *
 * WICHTIG:
 * - Legacy `ServerSettings.permaOnly` ist NICHT mehr Source-of-Truth.
 * - Pro Connection wird hoechstens ein PENDING/RUNNING RESTART_IF_DOWN-Job
 *   erzeugt.
 * - Der Check+Insert laeuft SERIALIZABLE, damit zwei Prozesse nicht beide
 *   denselben Job enqueuen koennen (NIT-009).
 * - Ob wirklich gestartet werden darf entscheidet der Worker anhand des
 *   Remote-Status; `suspended` darf dort niemals auto-gestartet werden.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

const POLL_INTERVAL_MS = 3 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let running = false;

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2034';
}

async function enqueueIfMissing(slot: { id: string; guildId: string }): Promise<boolean> {
  try {
    return await prisma.$transaction(async tx => {
      const existing = await tx.nitradoJob.findFirst({
        where: {
          guildId: slot.guildId,
          nitradoConnId: slot.id,
          operation: 'RESTART_IF_DOWN',
          status: { in: ['PENDING', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (existing) return false;

      await tx.nitradoJob.create({
        data: {
          guildId: slot.guildId,
          nitradoConnId: slot.id,
          operation: 'RESTART_IF_DOWN',
          payload: {},
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
        },
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    // Bei konkurrierenden SERIALIZABLE-Transaktionen gewinnt genau eine.
    // Der Verlierer wartet bis zum naechsten Poll statt einen Doppeljob zu
    // erzeugen. Andere DB-Fehler bleiben sichtbar.
    if (isSerializationConflict(error)) return false;
    throw error;
  }
}

export async function runKeepOnlinePollOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler-Sweep; jeder erzeugte Job bleibt guild+connection scoped.
    const slots = await prisma.nitradoConnection.findMany({
      where: {
        keepOnlineEnabled: true,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      },
      select: { id: true, guildId: true },
    });

    let enqueued = 0;
    for (const slot of slots) {
      if (await enqueueIfMissing(slot)) enqueued += 1;
    }

    if (enqueued > 0) {
      logger.info(`Keep-Online-Cron: ${enqueued}/${slots.length} Reconcile-Job(s) enqueued`);
    }
  } catch (error) {
    logger.error('Keep-Online-Cron-Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startPermaOnlyCron(): void {
  if (timer || initialTimer) return;
  logger.info(`Keep-Online-Cron gestartet (Intervall ${POLL_INTERVAL_MS / 60_000} min)`);

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runKeepOnlinePollOnce();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();

  timer = setInterval(() => { void runKeepOnlinePollOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopPermaOnlyCron(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
