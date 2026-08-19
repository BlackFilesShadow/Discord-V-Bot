/**
 * BankInterest (Phase 5) — tagesidempotente, gameserver-gescoppte Bankzinsen.
 *
 * Zinsen werden pro Guild+Gameserver+Tag genau einmal gutgeschrieben.
 * Doppelte Absicherung:
 *  - BankInterestRun (guildServerRunDate) markiert den Tageslauf,
 *  - der Ledger-Key `interest:<guild>:<server>:<date>:<subject>` verhindert je
 *    User eine Doppelbuchung, ohne die Discord-ID im unveraenderlichen Key zu
 *    konservieren (auch bei Teilabbruch + Retry).
 *
 * Economy-1I: Positive Bankkonten werden vollstaendig per stabiler Keyset-
 * Pagination (`createdAt`, `id`) abgearbeitet. Der Tageslauf wird erst NACH der
 * letzten Seite markiert. Damit koennen grosse Server nicht mehr hinter einem
 * festen `take`-Fenster abgeschnitten werden; Crash-/Parallel-Retries bleiben
 * durch die bestehenden Ledger-Keys idempotent.
 *
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

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; meta?: { code?: string } };
  return candidate.code === 'P2002' || candidate.code === '23505' || candidate.meta?.code === '23505';
}

export interface InterestAccountRow {
  id: string;
  userDiscordId: string;
  bankBalance: bigint;
  createdAt: Date;
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

interface InterestCursor {
  createdAt: Date;
  id: string;
}

function afterInterestCursor(cursor: InterestCursor | null): Record<string, unknown> {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

/**
 * Fuehrt den Tages-Zinslauf fuer exakt einen Gameserver aus.
 *
 * `limit` ist aus Kompatibilitaetsgruenden der Name der Option und bezeichnet
 * jetzt die PAGE-SIZE, nicht mehr die maximale Gesamtzahl der Konten. Der Lauf
 * paginiert bis zum Ende. Bereits erfasste Server-Tage werden uebersprungen;
 * einzelne User sind zusaetzlich ueber den serverbezogenen Ledger-Key gegen
 * Crash-/Parallel-Retries abgesichert.
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

  const pageSize = Math.max(1, Math.min(2_000, Math.trunc(args.limit ?? 500)));
  let credited = 0;
  let total = 0n;
  let cursor: InterestCursor | null = null;

  for (;;) {
    const accounts = await client.economyAccount.findMany({
      where: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
        bankBalance: { gt: 0 },
        ...afterInterestCursor(cursor),
      },
      select: {
        id: true,
        userDiscordId: true,
        bankBalance: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
    });
    if (accounts.length === 0) break;

    // `a` bleibt absichtlich der lokale Name: ein bestehendes Privacy-
    // Architektur-Gate pinnt genau diesen HMAC-Aufruf gegen rohe Discord-IDs.
    for (const a of accounts) {
      const interest = computeInterest(a.bankBalance, args.percent);
      if (interest <= 0n) continue;
      const subjectKey = economySubjectKey(args.guildId, a.userDiscordId, config.security.encryptionKey);
      const result = await bookLedgerEntry(client, {
        idempotencyKey: `interest:${args.guildId}:${args.nitradoConnId}:${args.runDate}:${subjectKey}`,
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
        userDiscordId: a.userDiscordId,
        bankDelta: interest,
        type: 'INTEREST',
        reason: 'Bank-Zinsen',
      });
      if (result.booked) {
        credited++;
        total += interest;
      }
    }

    const last = accounts[accounts.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
    if (accounts.length < pageSize) break;
  }

  // Tageslauf erst NACH der letzten Seite erfassen. Bei Crash davor startet der
  // naechste Sweep wieder vorne; bereits gebuchte User bleiben durch ihren
  // Ledger-Key No-op. Bei Parallel-Runs ist ausschliesslich die erwartete
  // Unique-Kollision des Tagesmarkers toleriert. Echte DB-Fehler muessen den
  // Lauf fehlschlagen lassen, damit Monitoring/Retry nicht faelschlich Erfolg
  // melden.
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
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  return { credited, total, skipped: false };
}
