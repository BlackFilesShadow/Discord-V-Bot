import { randomUUID } from 'node:crypto';
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

/**
 * Compatibility alias for older internal callers while the authoritative safety
 * router uses the terminal-deletion name. It does not make deletion reversible.
 */
export const listHiddenVirtualAccountIds = listDeletedVirtualAccountIds;

/**
 * Legacy compatibility hook. User-visible deletion is terminal; callers of the
 * retired restore endpoint receive no restoration and must treat the account as
 * deleted from the active control surface.
 */
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

async function retainCustomHistory(raw: VirtualAccountRawDb, args: {
  account: LockedAccountRow;
  finance: LockedFinanceRow;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  actorDiscordId?: UserDiscordId;
}): Promise<DeletedVirtualAccount> {
  const reason = 'Konto dauerhaft gelöscht; Restguthaben wurde kontrolliert auf 0 gesetzt.';

  if (args.account.balance > 0n) {
    const inserted = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'CONTROL_DELETE_RESET\',\'WALLET\',$7,NULL,$8,\'control-delete\',CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `control-delete:${args.account.id}:wallet`, String(args.guildId), String(args.nitradoConnId), args.account.id,
      -args.account.balance, args.actorDiscordId ? String(args.actorDiscordId) : null, reason,
    );
    if (inserted !== 1) throw new Error('Wallet-Löschbuchung existiert bereits; bitte Konten neu laden.');
  }
  if (args.finance.bankBalance > 0n) {
    const inserted = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'CONTROL_DELETE_RESET\',\'BANK\',$7,NULL,$8,\'control-delete\',CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `control-delete:${args.account.id}:bank`, String(args.guildId), String(args.nitradoConnId), args.account.id,
      -args.finance.bankBalance, args.actorDiscordId ? String(args.actorDiscordId) : null, reason,
    );
    if (inserted !== 1) throw new Error('Bank-Löschbuchung existiert bereits; bitte Konten neu laden.');
  }

  const financeReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0, "accountPurpose"=CASE WHEN "accountPurpose"=\'BANK_TREASURY\' THEN \'GENERAL\' ELSE "accountPurpose" END, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
    args.account.id, String(args.guildId), String(args.nitradoConnId),
  );
  if (financeReset !== 1) throw new Error('Konto-Finanzprofil wurde parallel verändert; Löschung abgebrochen.');

  // ARCHIVED is an internal persistence state only. The terminal deletion marker
  // below removes this row from every active control surface and there is no
  // restore path after a user-visible delete.
  const walletReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccount" SET "balance"=0, "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "acceptUserTransfers"=false, "archivedAt"=COALESCE("archivedAt", CURRENT_TIMESTAMP), "archivedByDiscordId"=COALESCE("archivedByDiscordId", $4), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind"',
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
    walletRemoved: args.account.balance.toString(),
    bankRemoved: args.finance.bankBalance.toString(),
    domainPreserved: false,
  };
}

/**
 * Terminal user-visible deletion for CUSTOM accounts:
 *
 * - System accounts are rejected defensively and remain owned by Lotterie or
 *   Schwarzmarkt.
 * - A fresh empty CUSTOM account without immutable history is physically deleted.
 * - A CUSTOM account with balances or immutable history is atomically zeroed,
 *   made inert and marked deleted. Its row remains only so ledger/audit foreign
 *   keys stay valid; it is never listed or restorable again.
 * - A deleted server-bank is declassified to GENERAL so a new treasury can be
 *   created immediately without reviving the deleted account.
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
      const hasMoney = account.balance !== 0n || finance.bankBalance !== 0n;
      const mustPreserveRow = hasMoney || Boolean(entries[0]?.exists) || Boolean(protectedRefs[0]?.protected);

      if (mustPreserveRow) {
        return retainCustomHistory(raw, {
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
