import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import type { VirtualAccountRawDb } from './virtualAccounts';

interface LockedAccountRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  balance: bigint;
}

interface LockedFinanceRow {
  bankBalance: bigint;
  accountPurpose: string;
}

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

export type VirtualAccountDeletionMode = 'HARD_DELETED' | 'CONTROL_HIDDEN';

export interface DeletedVirtualAccount {
  id: string;
  name: string;
  mode: VirtualAccountDeletionMode;
}

/**
 * Archived lottery pots remain required by immutable lottery/ledger history.
 * They can therefore be removed from the control surface without deleting the
 * underlying accounting row. CUSTOM/GENERAL accounts keep the strict hard
 * delete path when no protected history exists.
 */
export async function listHiddenVirtualAccountIds(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<Set<string>> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ accountId: string }>>(
    'SELECT "accountId" FROM "EconomyVirtualAccountControlHidden" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId),
    String(args.nitradoConnId),
  );
  return new Set(rows.map(row => row.accountId));
}

/**
 * Hard-delete remains restricted to CUSTOM/GENERAL accounts without protected
 * booking/system history. The delete action itself owns the financial reset:
 * callers do not have to empty wallet/bank manually before deleting. Both
 * pockets are reset to zero under the same row locks immediately before the
 * physical delete, so no parallel money movement can race the reset/delete.
 *
 * LOTTERY_POT is intentionally different: a terminal archived pot with zero
 * wallet/bank is only hidden from account control. LotteryRound and ledger
 * references stay intact for audit/history and can never be silently erased.
 */
export async function deleteUnusedVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
}): Promise<DeletedVirtualAccount> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  try {
    return await prisma.$transaction(async tx => {
      const raw = rawDb(tx);
      const accounts = await raw.$queryRawUnsafe<LockedAccountRow[]>(
        'SELECT "id", "name", "kind"::text AS kind, "status"::text AS status, "balance" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      const account = accounts[0];
      if (!account) throw new Error('Virtuelles Konto nicht gefunden.');

      const finances = await raw.$queryRawUnsafe<LockedFinanceRow[]>(
        'SELECT "bankBalance", "accountPurpose" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      const finance = finances[0];
      if (!finance) throw new Error('Konto-Finanzprofil fehlt; Loeschung wird aus Sicherheitsgruenden abgebrochen.');
      if (finance.accountPurpose !== 'GENERAL') throw new Error('Die Serverbank ist ein geschuetztes Systemkonto und kann nicht geloescht werden.');

      if (account.kind !== 'CUSTOM') {
        if (account.kind !== 'LOTTERY_POT') {
          throw new Error('Schwarzmarkt-Systemkonten koennen nicht geloescht werden.');
        }
        if (account.status !== 'ARCHIVED') {
          throw new Error('Ein Lotterie-Konto kann erst nach Abschluss und Archivierung entfernt werden.');
        }
        if (account.balance !== 0n || finance.bankBalance !== 0n) {
          throw new Error('Ein archiviertes Lotterie-Konto kann nur bei Wallet=0 und Bank=0 entfernt werden.');
        }

        const nonTerminalRounds = await raw.$queryRawUnsafe<Array<{ exists: boolean }>>(
          `SELECT EXISTS(
            SELECT 1 FROM "LotteryRound"
            WHERE "potAccountId"=$1
              AND "status" NOT IN ('FINISHED'::"LotteryRoundStatus", 'REFUNDED'::"LotteryRoundStatus")
            LIMIT 1
          ) AS exists`,
          args.accountId,
        );
        if (nonTerminalRounds[0]?.exists) {
          throw new Error('Das Lotterie-Konto gehoert noch zu einer nicht abgeschlossenen Runde und kann nicht entfernt werden.');
        }

        const hidden = await raw.$executeRawUnsafe(
          'INSERT INTO "EconomyVirtualAccountControlHidden" ("accountId", "guildId", "nitradoConnId", "hiddenAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "hiddenAt"=CURRENT_TIMESTAMP WHERE "EconomyVirtualAccountControlHidden"."guildId"=EXCLUDED."guildId" AND "EconomyVirtualAccountControlHidden"."nitradoConnId"=EXCLUDED."nitradoConnId"',
          args.accountId,
          String(args.guildId),
          String(args.nitradoConnId),
        );
        if (hidden !== 1) throw new Error('Lotterie-Konto konnte nicht sicher aus der Kontoverwaltung entfernt werden.');
        return { id: account.id, name: account.name, mode: 'CONTROL_HIDDEN' };
      }

      const entries = await raw.$queryRawUnsafe<Array<{ exists: boolean }>>(
        'SELECT EXISTS(SELECT 1 FROM "EconomyVirtualAccountEntry" WHERE "virtualAccountId"=$1 LIMIT 1) AS exists',
        args.accountId,
      );
      if (entries[0]?.exists) {
        throw new Error('Dieses Konto besitzt Buchungshistorie und darf deshalb nicht hart geloescht werden. Bitte archivieren.');
      }

      const protectedRefs = await raw.$queryRawUnsafe<Array<{ protected: boolean }>>(
        `SELECT (
          EXISTS(SELECT 1 FROM "LotteryRound" WHERE "potAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketListing" WHERE "vendorAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketPurchase" WHERE "vendorAccountId"=$1 LIMIT 1)
        ) AS protected`,
        args.accountId,
      );
      if (protectedRefs[0]?.protected) {
        throw new Error('Dieses Konto wird von Lotterie-/Markt-Historie referenziert und kann nicht geloescht werden.');
      }

      const financeReset = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      if (financeReset !== 1) throw new Error('Konto-Finanzprofil wurde parallel veraendert; Loeschung abgebrochen.');

      const walletReset = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccount" SET "balance"=0, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind"',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      if (walletReset !== 1) throw new Error('Virtuelles Konto wurde parallel veraendert; Loeschung abgebrochen.');

      const deleted = await raw.$executeRawUnsafe(
        'DELETE FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      if (deleted !== 1) throw new Error('Virtuelles Konto wurde parallel veraendert; Loeschung abgebrochen.');
      return { id: account.id, name: account.name, mode: 'HARD_DELETED' };
    });
  } catch (error) {
    const candidate = typeof error === 'object' && error !== null ? error as { code?: string; meta?: { code?: string } } : {};
    if (candidate.code === '23503' || candidate.meta?.code === '23503') {
      throw new Error('Das Konto wird noch von geschuetzter Historie referenziert und kann nicht geloescht werden. Bitte archivieren.');
    }
    throw error;
  }
}
