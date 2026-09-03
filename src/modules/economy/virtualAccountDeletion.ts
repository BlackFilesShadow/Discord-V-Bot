import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
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

export type VirtualAccountDeletionMode = 'HARD_DELETED' | 'HISTORY_RETAINED';

export interface DeletedVirtualAccount {
  id: string;
  name: string;
  mode: VirtualAccountDeletionMode;
  walletRemoved: string;
  bankRemoved: string;
  domainPreserved: boolean;
}

/**
 * Returns terminal deletion markers for CUSTOM accounts whose immutable ledger
 * or historical foreign-key references require the physical account row to stay
 * in PostgreSQL. These rows are not active accounts and must never be exposed as
 * restorable control-surface entries.
 */
export async function listDeletedVirtualAccountIds(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<Set<string>> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ accountId: string }>>(
    'SELECT "accountId" FROM "EconomyVirtualAccountDeleted" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId),
    String(args.nitradoConnId),
  );
  return new Set(rows.map(row => row.accountId));
}

/** Compatibility alias only; terminal deletion remains irreversible. */
export const listHiddenVirtualAccountIds = listDeletedVirtualAccountIds;

/** Legacy compatibility hook. Deleted accounts are never restored. */
export async function restoreHiddenVirtualAccount(_args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
}): Promise<boolean> {
  return false;
}

async function writeDeletedMarker(raw: VirtualAccountRawDb, args: {
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<void> {
  const marked = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountDeleted" ("accountId", "guildId", "nitradoConnId", "deletedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "deletedAt"=CURRENT_TIMESTAMP WHERE "EconomyVirtualAccountDeleted"."guildId"=EXCLUDED."guildId" AND "EconomyVirtualAccountDeleted"."nitradoConnId"=EXCLUDED."nitradoConnId"',
    args.accountId,
    String(args.guildId),
    String(args.nitradoConnId),
  );
  if (marked !== 1) throw new Error('Konto konnte nicht sicher als gelöscht markiert werden.');
}

async function retainZeroBalanceCustomHistory(raw: VirtualAccountRawDb, args: {
  account: LockedAccountRow;
  finance: LockedFinanceRow;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  actorDiscordId?: UserDiscordId;
}): Promise<DeletedVirtualAccount> {
  const financeReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccountFinance" SET "accountPurpose"=CASE WHEN "accountPurpose"=\'BANK_TREASURY\' THEN \'GENERAL\' ELSE "accountPurpose" END, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "bankBalance"=0',
    args.account.id, String(args.guildId), String(args.nitradoConnId),
  );
  if (financeReset !== 1) throw new Error('Konto-Finanzprofil wurde parallel verändert; Löschung abgebrochen.');

  const walletReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccount" SET "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "acceptUserTransfers"=false, "archivedAt"=COALESCE("archivedAt", CURRENT_TIMESTAMP), "archivedByDiscordId"=COALESCE("archivedByDiscordId", $4), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0',
    args.account.id, String(args.guildId), String(args.nitradoConnId), args.actorDiscordId ? String(args.actorDiscordId) : null,
  );
  if (walletReset !== 1) throw new Error('Virtuelles Konto wurde parallel verändert; Löschung abgebrochen.');

  await writeDeletedMarker(raw, {
    accountId: args.account.id,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
  });
  return {
    id: args.account.id,
    name: args.account.name,
    mode: 'HISTORY_RETAINED',
    walletRemoved: '0',
    bankRemoved: '0',
    domainPreserved: false,
  };
}

/**
 * Terminal user-visible deletion for CUSTOM accounts.
 *
 * Safety invariants:
 * - Domain-owned system accounts are rejected and stay owned by their feature.
 * - Deletion never destroys funds: wallet and bank must both already be zero.
 * - A fresh empty CUSTOM account without immutable history is physically deleted.
 * - A zero-balance CUSTOM account with immutable history is made inert and marked
 *   deleted so existing RESTRICT foreign keys remain valid until the dedicated
 *   historical-identity migration can remove the live row safely.
 * - A deleted server-bank is declassified to GENERAL so a new treasury can be
 *   created without reviving the deleted account.
 */
export async function deleteUnusedVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId?: UserDiscordId;
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
      if (account.kind !== 'CUSTOM') {
        throw new Error('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
      }

      const finances = await raw.$queryRawUnsafe<LockedFinanceRow[]>(
        'SELECT "bankBalance", "accountPurpose" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      const finance = finances[0];
      if (!finance) throw new Error('Konto-Finanzprofil fehlt; Löschung wird aus Sicherheitsgründen abgebrochen.');

      if (account.balance !== 0n || finance.bankBalance !== 0n) {
        throw new Error('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
      }

      const entries = await raw.$queryRawUnsafe<Array<{ exists: boolean }>>(
        'SELECT EXISTS(SELECT 1 FROM "EconomyVirtualAccountEntry" WHERE "virtualAccountId"=$1 LIMIT 1) AS exists',
        args.accountId,
      );
      const protectedRefs = await raw.$queryRawUnsafe<Array<{ protected: boolean }>>(
        `SELECT (
          EXISTS(SELECT 1 FROM "LotteryRound" WHERE "potAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketListing" WHERE "vendorAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketPurchase" WHERE "vendorAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketOrder" WHERE "vendorAccountId"=$1 LIMIT 1)
        ) AS protected`,
        args.accountId,
      );
      const mustPreserveRow = Boolean(entries[0]?.exists) || Boolean(protectedRefs[0]?.protected);

      if (mustPreserveRow) {
        return retainZeroBalanceCustomHistory(raw, {
          account,
          finance,
          guildId: args.guildId,
          nitradoConnId: args.nitradoConnId,
          actorDiscordId: args.actorDiscordId,
        });
      }

      const deleted = await raw.$executeRawUnsafe(
        'DELETE FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      if (deleted !== 1) throw new Error('Virtuelles Konto wurde parallel verändert; Löschung abgebrochen.');
      return {
        id: account.id,
        name: account.name,
        mode: 'HARD_DELETED',
        walletRemoved: '0',
        bankRemoved: '0',
        domainPreserved: false,
      };
    });
  } catch (error) {
    const candidate = typeof error === 'object' && error !== null ? error as { code?: string; meta?: { code?: string } } : {};
    if (candidate.code === '23503' || candidate.meta?.code === '23503') {
      throw new Error('Das Konto wurde während der Löschung neu von geschützter Historie referenziert. Es wurde nicht teilweise gelöscht; bitte Konten neu laden und erneut löschen.');
    }
    throw error;
  }
}
