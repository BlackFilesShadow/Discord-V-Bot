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

export type VirtualAccountDeletionMode = 'HARD_DELETED';

export interface DeletedVirtualAccount {
  id: string;
  name: string;
  mode: VirtualAccountDeletionMode;
  walletRemoved: string;
  bankRemoved: string;
  domainPreserved: boolean;
}

export async function listDeletedVirtualAccountIds(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<Set<string>> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ accountId: string }>>(
    'SELECT "accountId" FROM "EconomyVirtualAccountHistoryIdentity" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "deletedAt" IS NOT NULL',
    String(args.guildId),
    String(args.nitradoConnId),
  );
  return new Set(rows.map(row => row.accountId));
}

/** Compatibility alias; deleted identities are historical only and never live rows. */
export const listHiddenVirtualAccountIds = listDeletedVirtualAccountIds;

/** Legacy compatibility hook. Terminal deletion is irreversible. */
export async function restoreHiddenVirtualAccount(_args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
}): Promise<boolean> {
  return false;
}

/**
 * Terminal user-visible deletion for CUSTOM accounts.
 *
 * Safety invariants:
 * - Domain-owned system accounts are rejected and stay owned by their feature.
 * - Wallet and bank must already be zero; deletion never burns or transfers funds.
 * - Active lottery/market work blocks generic deletion.
 * - Historical ledger/lottery/market/order rows point to the dedicated immutable
 *   EconomyVirtualAccountHistoryIdentity, never to the live account row.
 * - The live EconomyVirtualAccount row is always physically deleted on success.
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

      // Serialize terminal deletion against the historical identity before checking
      // active domain dependencies. Database triggers on active domain rows acquire
      // KEY SHARE on the same live account, closing create-vs-delete races.
      const identities = await raw.$queryRawUnsafe<Array<{ accountId: string; deletedAt: Date | null }>>(
        'SELECT "accountId", "deletedAt" FROM "EconomyVirtualAccountHistoryIdentity" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      const identity = identities[0];
      if (!identity) throw new Error('Historische Kontoidentität fehlt; Löschung wird aus Sicherheitsgründen abgebrochen.');
      if (identity.deletedAt) throw new Error('Dieses Konto wurde bereits dauerhaft gelöscht.');

      const activeRefs = await raw.$queryRawUnsafe<Array<{ active: boolean }>>(
        `SELECT (
          EXISTS(SELECT 1 FROM "LotteryRound" WHERE "potAccountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status" IN ('ACTIVE','DRAWING','REFUNDING') LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketListing" WHERE "vendorAccountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "active"=TRUE LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketOrder" WHERE "vendorAccountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"='OPEN'::"EconomyMarketOrderStatus" LIMIT 1)
        ) AS active`,
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      if (Boolean(activeRefs[0]?.active)) {
        throw new Error('Konto wird noch von einem aktiven Fachvorgang verwendet und kann nicht generisch gelöscht werden.');
      }

      const snapshotted = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccountHistoryIdentity" SET "deletedAt"=CURRENT_TIMESTAMP, "deletedByDiscordId"=$4, "nameSnapshot"=$5, "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "deletedAt" IS NULL',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
        args.actorDiscordId ? String(args.actorDiscordId) : null,
        account.name,
      );
      if (snapshotted !== 1) throw new Error('Historische Kontoidentität wurde parallel verändert; Löschung abgebrochen.');

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
        domainPreserved: true,
      };
    });
  } catch (error) {
    const candidate = typeof error === 'object' && error !== null ? error as { code?: string; meta?: { code?: string } } : {};
    if (candidate.code === '23503' || candidate.meta?.code === '23503') {
      throw new Error('Das Konto wird noch von geschütztem Live-Zustand referenziert und kann nicht gelöscht werden. Es wurde nicht teilweise gelöscht.');
    }
    throw error;
  }
}
