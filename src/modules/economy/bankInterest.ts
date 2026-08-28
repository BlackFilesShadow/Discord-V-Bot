/**
 * Tagesidempotente, gameserver-gescoppte Bankzinsen.
 *
 * Geld wird ausschliesslich mit BigInt berechnet. Zinssaetze werden als
 * Basispunkte behandelt (100 bp = 1,00 %), damit auch z. B. 2,50 % ohne
 * Floating-Point-Geldrechnung exakt funktionieren.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { bookLedgerEntry, type LedgerClient } from './ledger';
import { economySubjectKey } from './subjectKey';

export const MAX_INTEREST_BASIS_POINTS = 10_000;

export function normalizeInterestBasisPoints(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INTEREST_BASIS_POINTS) {
    throw new Error('bankInterestBasisPoints muss 0..10000 sein.');
  }
  return value;
}

/** Zinsbetrag (Abrundung) fuer ein Bankguthaben. Nie negativ. */
export function computeInterestBasisPoints(bankBalance: bigint, basisPoints: number): bigint {
  const bp = normalizeInterestBasisPoints(basisPoints);
  if (bankBalance <= 0n || bp <= 0) return 0n;
  return (bankBalance * BigInt(bp)) / 10_000n;
}

/**
 * Legacy-Helfer fuer bestehende Aufrufer/Tests mit ganzen Prozentwerten.
 * Neue Runtime-Pfade verwenden computeInterestBasisPoints direkt.
 */
export function computeInterest(bankBalance: bigint, percent: number): bigint {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error('percent muss als ganze Zahl 0..100 angegeben werden.');
  }
  return computeInterestBasisPoints(bankBalance, percent * 100);
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
  $executeRawUnsafe?: (query: string, ...values: unknown[]) => Promise<number>;
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

async function createRunMarker(
  client: BankInterestClient,
  args: BankInterestScope & { runDate: string; basisPoints: number; credited: number; total: bigint },
): Promise<void> {
  try {
    if (client.$executeRawUnsafe) {
      await client.$executeRawUnsafe(
        'INSERT INTO "BankInterestRun" ("id","guildId","nitradoConnId","runDate","interestPercent","interestBasisPoints","accountsCredited","totalCredited","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)',
        randomUUID(),
        args.guildId,
        args.nitradoConnId,
        args.runDate,
        Math.floor(args.basisPoints / 100),
        args.basisPoints,
        args.credited,
        args.total,
      );
      return;
    }
    await client.bankInterestRun.create({
      data: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
        runDate: args.runDate,
        interestPercent: Math.floor(args.basisPoints / 100),
        accountsCredited: args.credited,
        totalCredited: args.total,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * Fuehrt den Tages-Zinslauf fuer exakt einen Gameserver aus.
 * `limit` ist die PAGE-SIZE, nicht die maximale Kontenzahl.
 */
export async function runDailyInterestForServer(
  client: BankInterestClient,
  args: BankInterestScope & { basisPoints?: number; percent?: number; runDate: string; limit?: number },
): Promise<{ credited: number; total: bigint; skipped: boolean }> {
  const basisPoints = args.basisPoints !== undefined
    ? normalizeInterestBasisPoints(args.basisPoints)
    : normalizeInterestBasisPoints((args.percent ?? 0) * 100);
  if (basisPoints <= 0) return { credited: 0, total: 0n, skipped: true };

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

    for (const a of accounts) {
      const interest = computeInterestBasisPoints(a.bankBalance, basisPoints);
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

  await createRunMarker(client, {
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    runDate: args.runDate,
    basisPoints,
    credited,
    total,
  });

  return { credited, total, skipped: false };
}
