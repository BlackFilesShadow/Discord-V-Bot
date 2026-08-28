/**
 * Stuendlicher Bank-Zins-Sweep. Tages-Idempotenz liegt in den jeweiligen
 * servergescoppten Ledger-Keys/Markern. Spielerbanken und die echte
 * BANK_TREASURY werden mit demselben konfigurierten Basispunkt-Satz behandelt;
 * andere virtuelle Konten sind ausgeschlossen.
 */

import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { runDailyInterestForServer, interestDateKey, type BankInterestClient } from './bankInterest';
import { getInterestBasisPoints } from './interestRate';
import { runDailyTreasuryInterestForServer } from './virtualAccountInterest';

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function runInterestSweepOnce(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Globaler Scheduler-Sweep ist absichtlich guilduebergreifend. Nur bereits
    // servergescopte und aktivierte Configs werden betrachtet. Der exakte Satz
    // wird danach ueber die additive Basispunkt-Spalte gelesen.
    // eslint-disable-next-line local/no-unscoped-prisma-query
    const configs = await prisma.economyConfig.findMany({
      where: {
        enabled: true,
        nitradoConnId: { not: null },
      },
      select: { guildId: true, nitradoConnId: true },
    });

    for (const c of configs) {
      if (!c.nitradoConnId) continue;
      try {
        const basisPoints = await getInterestBasisPoints(c.guildId, c.nitradoConnId);
        if (basisPoints <= 0) continue;
        const runDate = interestDateKey(now, 'Europe/Berlin');
        const player = await runDailyInterestForServer(prisma as unknown as BankInterestClient, {
          guildId: c.guildId,
          nitradoConnId: c.nitradoConnId,
          basisPoints,
          runDate,
        });
        const treasury = await runDailyTreasuryInterestForServer({
          guildId: c.guildId,
          nitradoConnId: c.nitradoConnId,
          basisPoints,
          runDate,
        });
        if ((!player.skipped && player.credited > 0) || treasury.credited > 0) {
          logAudit('BANK_INTEREST_RUN', 'ECONOMY', {
            guildId: c.guildId,
            nitradoConnId: c.nitradoConnId,
            runDate,
            basisPoints,
            playerAccounts: player.credited,
            playerTotal: player.total.toString(),
            treasuryAccounts: treasury.credited,
            treasuryTotal: treasury.total.toString(),
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
