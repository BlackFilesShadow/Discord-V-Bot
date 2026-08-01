/**
 * BankInterest (Phase 5) — tagesidempotente Bankzinsen.
 *
 * Zinsen werden pro Tag genau einmal gutgeschrieben. Doppelte Absicherung:
 *  - BankInterestRun (@@unique[guildId, runDate]) markiert den Tageslauf,
 *  - der Ledger-Key `interest:<guild>:<date>:<user>` verhindert je User eine
 *    Doppelbuchung (auch bei Teilabbruch + Retry).
 * Standard bankInterestPercent=0 -> es passiert nichts (dormant).
 */

import { bookLedgerEntry, type LedgerClient } from './ledger';

/** Zinsbetrag (Abrundung) fuer ein Bankguthaben. Nie negativ. */
export function computeInterest(bankBalance: bigint, percent: number): bigint {
  if (bankBalance <= 0n || percent <= 0) return 0n;
  return (bankBalance * BigInt(Math.floor(percent))) / 100n;
}

/** Tagesschluessel YYYY-MM-DD in der angegebenen Zeitzone. */
export function interestDateKey(now: Date, timeZone = 'Europe/Berlin'): string {
  // en-CA formatiert als YYYY-MM-DD.
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
    // upsert wird von bookLedgerEntry (LedgerClient) mitgenutzt.
    upsert: (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

/**
 * Fuehrt den Tages-Zinslauf fuer eine Guild aus. Idempotent: bereits erfasste
 * Tage werden uebersprungen; einzelne User sind zusaetzlich ueber den Ledger-Key
 * abgesichert. Bucht auf die Bank.
 */
export async function runDailyInterestForGuild(
  client: BankInterestClient,
  args: { guildId: string; percent: number; runDate: string; limit?: number },
): Promise<{ credited: number; total: bigint; skipped: boolean }> {
  if (args.percent <= 0) return { credited: 0, total: 0n, skipped: true };

  const already = await client.bankInterestRun.findUnique({
    where: { guildId_runDate: { guildId: args.guildId, runDate: args.runDate } },
  });
  if (already) return { credited: 0, total: 0n, skipped: true };

  const accounts = await client.economyAccount.findMany({
    where: { guildId: args.guildId, bankBalance: { gt: 0 } },
    take: args.limit ?? 10000,
  });

  let credited = 0;
  let total = 0n;
  for (const a of accounts) {
    const interest = computeInterest(a.bankBalance, args.percent);
    if (interest <= 0n) continue;
    const res = await bookLedgerEntry(client, {
      idempotencyKey: `interest:${args.guildId}:${args.runDate}:${a.userDiscordId}`,
      guildId: args.guildId,
      userDiscordId: a.userDiscordId,
      bankDelta: interest,
      type: 'INTEREST',
      reason: 'Bank-Zinsen',
    });
    if (res.booked) { credited++; total += interest; }
  }

  // Tageslauf erfassen (nach der Gutschrift; Doppelbuchung bereits ueber
  // Ledger-Keys ausgeschlossen). Kollision am selben Tag -> ignorieren.
  try {
    await client.bankInterestRun.create({
      data: {
        guildId: args.guildId,
        runDate: args.runDate,
        interestPercent: Math.floor(args.percent),
        accountsCredited: credited,
        totalCredited: total,
      },
    });
  } catch { /* @@unique-Kollision durch Parallel-Lauf -> ok */ }

  return { credited, total, skipped: false };
}
