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

export type VirtualAccountDeletionMode = 'HARD_DELETED' | 'CONTROL_HIDDEN';

export interface DeletedVirtualAccount {
  id: string;
  name: string;
  mode: VirtualAccountDeletionMode;
  walletRemoved: string;
  bankRemoved: string;
  domainPreserved: boolean;
}

/**
 * Historical/domain-owned accounts remain physically present when deleting the
 * control-surface entry would otherwise destroy immutable accounting, lottery or
 * market state. They disappear from the generic virtual-account dashboard while
 * their owning domain can continue to work with the same scoped account row.
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
 * Kehrt eine vorherige Control-Hidden-Loeschung um (nur Sichtbarkeit im
 * generischen Konten-Dashboard; Kontodaten/-funktion waren nie betroffen).
 * Strikt guild+connection-gescoppt, damit kein fremdes Konto sichtbar wird.
 */
export async function restoreHiddenVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
}): Promise<boolean> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const deleted = await rawDb().$executeRawUnsafe(
    'DELETE FROM "EconomyVirtualAccountControlHidden" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
    args.accountId,
    String(args.guildId),
    String(args.nitradoConnId),
  );
  return deleted === 1;
}

async function writeControlHidden(raw: VirtualAccountRawDb, args: {
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<void> {
  const hidden = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountControlHidden" ("accountId", "guildId", "nitradoConnId", "hiddenAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "hiddenAt"=CURRENT_TIMESTAMP WHERE "EconomyVirtualAccountControlHidden"."guildId"=EXCLUDED."guildId" AND "EconomyVirtualAccountControlHidden"."nitradoConnId"=EXCLUDED."nitradoConnId"',
    args.accountId,
    String(args.guildId),
    String(args.nitradoConnId),
  );
  if (hidden !== 1) throw new Error('Konto konnte nicht sicher aus der Kontoverwaltung entfernt werden.');
}

async function hideDomainOwnedAccount(raw: VirtualAccountRawDb, args: {
  account: LockedAccountRow;
  finance: LockedFinanceRow;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<DeletedVirtualAccount> {
  await writeControlHidden(raw, {
    accountId: args.account.id,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
  });
  return {
    id: args.account.id,
    name: args.account.name,
    mode: 'CONTROL_HIDDEN',
    walletRemoved: '0',
    bankRemoved: '0',
    domainPreserved: true,
  };
}

async function retireCustomAccount(raw: VirtualAccountRawDb, args: {
  account: LockedAccountRow;
  finance: LockedFinanceRow;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  actorDiscordId?: UserDiscordId;
}): Promise<DeletedVirtualAccount> {
  const reason = 'Konto gelöscht; Restguthaben wurde kontrolliert auf 0 gesetzt.';

  if (args.account.balance > 0n) {
    const inserted = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'CONTROL_DELETE_RESET\',\'WALLET\',$7,NULL,$8,\'control-delete\',CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `control-delete:${args.account.id}:wallet`, String(args.guildId), String(args.nitradoConnId), args.account.id,
      -args.account.balance, args.actorDiscordId ? String(args.actorDiscordId) : null, reason,
    );
    if (inserted !== 1) throw new Error('Wallet-Loeschbuchung existiert bereits; bitte Konten neu laden.');
  }
  if (args.finance.bankBalance > 0n) {
    const inserted = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'CONTROL_DELETE_RESET\',\'BANK\',$7,NULL,$8,\'control-delete\',CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `control-delete:${args.account.id}:bank`, String(args.guildId), String(args.nitradoConnId), args.account.id,
      -args.finance.bankBalance, args.actorDiscordId ? String(args.actorDiscordId) : null, reason,
    );
    if (inserted !== 1) throw new Error('Bank-Loeschbuchung existiert bereits; bitte Konten neu laden.');
  }

  const financeReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0, "accountPurpose"=CASE WHEN "accountPurpose"=\'BANK_TREASURY\' THEN \'GENERAL\' ELSE "accountPurpose" END, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
    args.account.id, String(args.guildId), String(args.nitradoConnId),
  );
  if (financeReset !== 1) throw new Error('Konto-Finanzprofil wurde parallel veraendert; Loeschung abgebrochen.');

  const walletReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccount" SET "balance"=0, "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "acceptUserTransfers"=false, "archivedAt"=COALESCE("archivedAt", CURRENT_TIMESTAMP), "archivedByDiscordId"=COALESCE("archivedByDiscordId", $4), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind"',
    args.account.id, String(args.guildId), String(args.nitradoConnId), args.actorDiscordId ? String(args.actorDiscordId) : null,
  );
  if (walletReset !== 1) throw new Error('Virtuelles Konto wurde parallel veraendert; Loeschung abgebrochen.');

  await writeControlHidden(raw, {
    accountId: args.account.id,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
  });
  return {
    id: args.account.id,
    name: args.account.name,
    mode: 'CONTROL_HIDDEN',
    walletRemoved: args.account.balance.toString(),
    bankRemoved: args.finance.bankBalance.toString(),
    domainPreserved: false,
  };
}

/**
 * Dashboard removal is status- and balance-independent:
 *
 * - CUSTOM accounts (including the server-bank treasury) can be removed while
 *   ACTIVE, EXPIRED or ARCHIVED and with any Wallet/Bank balance.
 * - A fresh, empty CUSTOM account is physically deleted.
 * - CUSTOM accounts with money or immutable history are atomically zeroed,
 *   archived and hidden so their audit trail survives. A deleted server-bank is
 *   declassified to GENERAL so a new treasury can be created immediately.
 * - LOTTERY_POT and MARKET_VENDOR are domain-owned system accounts. Deleting
 *   them from the generic virtual-account dashboard hides only that control
 *   surface; balances/status/domain references remain untouched so active
 *   lotteries, purchases and refunds cannot be corrupted.
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

      const finances = await raw.$queryRawUnsafe<LockedFinanceRow[]>(
        'SELECT "bankBalance", "accountPurpose" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      const finance = finances[0];
      if (!finance) throw new Error('Konto-Finanzprofil fehlt; Loeschung wird aus Sicherheitsgruenden abgebrochen.');

      if (account.kind === 'LOTTERY_POT' || account.kind === 'MARKET_VENDOR') {
        return hideDomainOwnedAccount(raw, {
          account,
          finance,
          guildId: args.guildId,
          nitradoConnId: args.nitradoConnId,
        });
      }
      if (account.kind !== 'CUSTOM') throw new Error('Unbekannter virtueller Kontotyp; Loeschung sicherheitshalber abgebrochen.');

      const entries = await raw.$queryRawUnsafe<Array<{ exists: boolean }>>(
        'SELECT EXISTS(SELECT 1 FROM "EconomyVirtualAccountEntry" WHERE "virtualAccountId"=$1 LIMIT 1) AS exists',
        args.accountId,
      );
      const protectedRefs = await raw.$queryRawUnsafe<Array<{ protected: boolean }>>(
        `SELECT (
          EXISTS(SELECT 1 FROM "LotteryRound" WHERE "potAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketListing" WHERE "vendorAccountId"=$1 LIMIT 1)
          OR EXISTS(SELECT 1 FROM "EconomyMarketPurchase" WHERE "vendorAccountId"=$1 LIMIT 1)
        ) AS protected`,
        args.accountId,
      );
      const hasMoney = account.balance !== 0n || finance.bankBalance !== 0n;
      const mustPreserveRow = hasMoney || Boolean(entries[0]?.exists) || Boolean(protectedRefs[0]?.protected);

      if (mustPreserveRow) {
        return retireCustomAccount(raw, {
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
      if (deleted !== 1) throw new Error('Virtuelles Konto wurde parallel veraendert; Loeschung abgebrochen.');
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
      throw new Error('Das Konto wird noch von geschuetzter Historie referenziert und kann nicht physisch geloescht werden. Die Historie bleibt erhalten; bitte erneut laden.');
    }
    throw error;
  }
}
