import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import { computeInterestBasisPoints, normalizeInterestBasisPoints } from './bankInterest';

interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface TreasuryRow {
  accountId: string;
  bankBalance: bigint;
}

function rawDb(client: unknown = prisma): RawDb {
  return client as RawDb;
}

/**
 * Verzinst ausschliesslich echte Serverbanken (accountPurpose=BANK_TREASURY).
 * MARKET_VENDOR, LOTTERY_POT und normale CUSTOM/GENERAL-Konten werden dadurch
 * konstruktiv ausgeschlossen. Der virtuelle Ledger-Key macht jeden
 * Account+Server+Tag auch bei Parallelitaet/Retry exakt einmal wirksam.
 */
export async function runDailyTreasuryInterestForServer(args: {
  guildId: string;
  nitradoConnId: string;
  runDate: string;
  basisPoints: number;
}): Promise<{ credited: number; total: bigint }> {
  const basisPoints = normalizeInterestBasisPoints(args.basisPoints);
  if (basisPoints <= 0) return { credited: 0, total: 0n };

  const candidates = await rawDb().$queryRawUnsafe<TreasuryRow[]>(
    `SELECT f."accountId", f."bankBalance"
       FROM "EconomyVirtualAccountFinance" f
       JOIN "EconomyVirtualAccount" a
         ON a."id"=f."accountId" AND a."guildId"=f."guildId" AND a."nitradoConnId"=f."nitradoConnId"
      WHERE f."guildId"=$1
        AND f."nitradoConnId"=$2
        AND f."accountPurpose"='BANK_TREASURY'
        AND f."bankBalance">0
        AND a."kind"='CUSTOM'::"EconomyVirtualAccountKind"
        AND a."status"='ACTIVE'::"EconomyVirtualAccountStatus"
      ORDER BY f."accountId"`,
    args.guildId,
    args.nitradoConnId,
  );

  let credited = 0;
  let total = 0n;
  for (const candidate of candidates) {
    const result = await prisma.$transaction(async tx => {
      const raw = rawDb(tx);
      const locked = await raw.$queryRawUnsafe<TreasuryRow[]>(
        `SELECT f."accountId", f."bankBalance"
           FROM "EconomyVirtualAccountFinance" f
           JOIN "EconomyVirtualAccount" a
             ON a."id"=f."accountId" AND a."guildId"=f."guildId" AND a."nitradoConnId"=f."nitradoConnId"
          WHERE f."accountId"=$1
            AND f."guildId"=$2
            AND f."nitradoConnId"=$3
            AND f."accountPurpose"='BANK_TREASURY'
            AND a."kind"='CUSTOM'::"EconomyVirtualAccountKind"
            AND a."status"='ACTIVE'::"EconomyVirtualAccountStatus"
          LIMIT 1
          FOR UPDATE OF f, a`,
        candidate.accountId,
        args.guildId,
        args.nitradoConnId,
      );
      const row = locked[0];
      if (!row || row.bankBalance <= 0n) return 0n;

      const interest = computeInterestBasisPoints(row.bankBalance, basisPoints);
      if (interest <= 0n) return 0n;
      const key = `interest:treasury:${args.guildId}:${args.nitradoConnId}:${args.runDate}:${row.accountId}`;
      const inserted = await raw.$executeRawUnsafe(
        `INSERT INTO "EconomyVirtualAccountEntry"
          ("id","idempotencyKey","guildId","nitradoConnId","virtualAccountId","delta","entryType","sourcePocket","actorDiscordId","userDiscordId","reason","sourceRef","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,'BANK_INTEREST','BANK',NULL,NULL,'Taegliche Bank-Zinsen',$7,CURRENT_TIMESTAMP)
         ON CONFLICT ("idempotencyKey") DO NOTHING`,
        randomUUID(),
        key,
        args.guildId,
        args.nitradoConnId,
        row.accountId,
        interest,
        `bank-interest:${args.runDate}`,
      );
      if (inserted !== 1) return 0n;

      const updated = await raw.$executeRawUnsafe(
        `UPDATE "EconomyVirtualAccountFinance"
            SET "bankBalance"="bankBalance"+$4, "updatedAt"=CURRENT_TIMESTAMP
          WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "accountPurpose"='BANK_TREASURY'`,
        row.accountId,
        args.guildId,
        args.nitradoConnId,
        interest,
      );
      if (updated !== 1) throw new Error('Serverbank-Zins konnte nicht atomar gutgeschrieben werden.');
      return interest;
    });

    if (result > 0n) {
      credited++;
      total += result;
    }
  }

  return { credited, total };
}
