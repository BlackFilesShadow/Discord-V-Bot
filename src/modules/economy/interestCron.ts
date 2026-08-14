/**
 * Bank-Zins-Cron (Phase 5). Stuendlicher Sweep; die Tages-Idempotenz kommt aus
 * BankInterestRun (Guild+Gameserver+Tag) + serverbezogenen Ledger-Keys.
 * Nur aktive EconomyConfigs mit bankInterestPercent>0 werden bearbeitet.
 */

import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { runDailyInterestForServer, interestDateKey, type BankInterestClient } from './bankInterest';

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function runInterestSweepOnce(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Globaler Scheduler-Sweep ist absichtlich guilduebergreifend. Jede konkrete
    // Buchung wird danach strikt an Guild+Gameserver gebunden.
    // eslint-disable-next-line local/no-unscoped-prisma-query
    const configs = await prisma.economyConfig.findMany({
      where: { enabled: true, bankInterestPercent: { gt: 0 } },
      select: { guildId: true, nitradoConnId: true, bankInterestPercent: true },
    });
    for (const c of configs) {
      if (!c.nitradoConnId) {
        logger.warn(`Zinslauf uebersprungen fuer Guild ${c.guildId}: EconomyConfig ohne Gameserver-Scope.`);
        continue;
      }
      try {
        const runDate = interestDateKey(now, 'Europe/Berlin');
        const r = await runDailyInterestForServer(prisma as unknown as BankInterestClient, {
          guildId: c.guildId,
          nitradoConnId: c.nitradoConnId,
          percent: c.bankInterestPercent,
          runDate,
        });
        if (!r.skipped && r.credited > 0) {
          logAudit('BANK_INTEREST_RUN', 'ECONOMY', {
            guildId: c.guildId,
            nitradoConnId: c.nitradoConnId,
            runDate,
            accounts: r.credited,
            total: r.total.toString(),
          });
        }
      } catch (e) {
        logger.warn(`Zinslauf fehlgeschlagen fuer Guild ${c.guildId} / Server ${c.nitradoConnId}: ${(e as Error).message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startBankInterestCron(): void {
  if (timer) return;
  timer = setInterval(() => { void runInterestSweepOnce(); }, 60 * 60 * 1000);
  timer.unref?.();
  void runInterestSweepOnce();
}

export function stopBankInterestCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
