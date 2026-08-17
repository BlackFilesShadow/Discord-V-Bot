/**
 * BankInterest (Phase 5) — tagesidempotente, gameserver-gescoppte Bankzinsen.
 *
 * Zinsen werden pro Guild+Gameserver+Tag genau einmal gutgeschrieben.
 * Doppelte Absicherung:
 *  - BankInterestRun (guildServerRunDate) markiert den Tageslauf,
 *  - der Ledger-Key `interest:<guild>:<server>:<date>:<subject>` verhindert je
 *    User eine Doppelbuchung, ohne die Discord-ID im unveraenderlichen Key zu
 *    konservieren (auch bei Teilabbruch + Retry).
 * Standard bankInterestPercent=0 -> es passiert nichts (dormant).
 */

import { config } from '../../config';
import { bookLedgerEntry, type LedgerClient } from './ledger';
import { economySubjectKey } from './subjectKey';

/** Zinsbetrag (Abrundung) fuer ein Bankguthaben. Nie negativ. */
export function computeInterest(bankBalance: bigint, percent: number): bigint {
  if (bankBalance <= 0n || percent <= 0) return 0n;
  return (bankBalance * BigInt(Math.floor(percent))) / 100n;
}

/** Tagesschluessel YYYY-MM-DD in der angegebenen Zeitzone. */
export function interestDateKey(now: Date, timeZone = 'Europe/Berlin'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface InterestAccountRow {
  userDiscordId: string;
  bankBalance: bigint;
}

export interface BankInterestClient extends LedgerClient {
  bankInterestRun: {
    findUnique: (args: unknown) => Promise<{ id: string } | null>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
  economyAccount: {
    findMany: (args: unknown) => Promise<InterestAccountRow[]>;
    upsert: (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export interface BankInterestScope {
  guildId: string;
  nitradoConnId: string;
}

/**
 * Fuehrt den Tages-Zinslauf fuer exakt einen Gameserver aus.
 * Idempotent: bereits erfasste Server-Tage werden uebersprungen; einzelne User
 * sind zusaetzlich ueber den serverbezogenen Ledger-Key abgesichert.
 */
export async function runDailyInterestForServer(
  client: BankInterestClient,
  args: BankInterestScope & { percent: number; runDate: string; limit?: number },
): Promise<{ credited: number; total: bigint; skipped: boolean }> {
  if (args.percent <= 0) return { credited: 0, total: 0n, skipped: true };

  const already = await client.bankInterestRun.findUnique({
    where: {
      guildServerRunDate: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
        runDate: args.runDate,
      },
    },
  });
  if (already) return { credited: 0, total: 0n, skipped: true };

  const accounts = await client.economyAccount.findMany({
    where: {
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      bankBalance: { gt: 0 },
    },
    take: args.limit ?? 10000,
  });

  let credited = 0;
  let total = 0n;
  for (const a of accounts) {
    const interest = computeInterest(a.bankBalance, args.percent);
    if (interest <= 0n) continue;
    const subjectKey = economySubjectKey(args.guildId, a.userDiscordId, config.security.encryptionKey);
    const res = await bookLedgerEntry(client, {
      idempotencyKey: `interest:${args.guildId}:${args.nitradoConnId}:${args.runDate}:${subjectKey}`,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      userDiscordId: a.userDiscordId,
      bankDelta: interest,
      type: 'INTEREST',
      reason: 'Bank-Zinsen',
    });
    if (res.booked) {
      credited++;
      total += interest;
    }
  }

  // Tageslauf erst nach den Gutschriften erfassen. Bei Parallel-Runs bleiben die
  // eigentlichen Geldbuchungen durch die Ledger-Keys idempotent.
  try {
    await client.bankInterestRun.create({
      data: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
        runDate: args.runDate,
        interestPercent: Math.floor(args.percent),
        accountsCredited: credited,
        totalCredited: total,
      },
    });
  } catch { /* Unique-Kollision durch Parallel-Lauf -> Geld bleibt idempotent */ }

  return { credited, total, skipped: false };
}
