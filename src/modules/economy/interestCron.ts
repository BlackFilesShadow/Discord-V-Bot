/**
 * Bank-Zins-Cron (Phase 5). Stuendlicher Sweep; die Tages-Idempotenz kommt aus
 * BankInterestRun (@@unique[guildId, runDate]) + Ledger-Keys. Nur Guilds mit
 * aktiver Wirtschaft UND bankInterestPercent>0 werden bearbeitet (sonst dormant).
 */

import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { runDailyInterestForGuild, interestDateKey, type BankInterestClient } from './bankInterest';

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function runInterestSweepOnce(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- Sweep ueber alle Guilds; Buchungen sind pro Guild gebunden.
    const configs = await prisma.economyConfig.findMany({
      where: { enabled: true, bankInterestPercent: { gt: 0 } },
      select: { guildId: true, bankInterestPercent: true },
    });
    for (const c of configs) {
      try {
        const runDate = interestDateKey(now, 'Europe/Berlin');
        const r = await runDailyInterestForGuild(prisma as unknown as BankInterestClient, {
          guildId: c.guildId, percent: c.bankInterestPercent, runDate,
        });
        if (!r.skipped && r.credited > 0) {
          logAudit('BANK_INTEREST_RUN', 'ECONOMY', {
            guildId: c.guildId, runDate, accounts: r.credited, total: r.total.toString(),
          });
        }
      } catch (e) {
        logger.warn(`Zinslauf fehlgeschlagen fuer Guild ${c.guildId}: ${(e as Error).message}`);
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
  if (timer) { clearInterval(timer); timer = null; }
}
