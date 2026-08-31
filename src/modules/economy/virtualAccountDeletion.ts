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
}

/**
 * Historical accounts remain physically present when immutable accounting or
 * domain references exist. They are hidden from account control instead of
 * cascading history away. Fresh CUSTOM accounts can still be hard-deleted.
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

async function hideAccount(raw: VirtualAccountRawDb, args: {
  account: LockedAccountRow;
  finance: LockedFinanceRow;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  actorDiscordId?: UserDiscordId;
}): Promise<DeletedVirtualAccount> {
  const reason = 'Konto gelöscht; Restguthaben wurde kontrolliert auf 0 gesetzt.';

  if (args.account.balance > 0n) {
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'CONTROL_DELETE_RESET\',\'WALLET\',$7,NULL,$8,\'control-delete\',CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `control-delete:${args.account.id}:wallet`, String(args.guildId), String(args.nitradoConnId), args.account.id,
      -args.account.balance, args.actorDiscordId ? String(args.actorDiscordId) : null, reason,
    );
  }
  if (args.finance.bankBalance > 0n) {
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'CONTROL_DELETE_RESET\',\'BANK\',$7,NULL,$8,\'control-delete\',CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `control-delete:${args.account.id}:bank`, String(args.guildId), String(args.nitradoConnId), args.account.id,
      -args.finance.bankBalance, args.actorDiscordId ? String(args.actorDiscordId) : null, reason,
    );
  }

  const financeReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
    args.account.id, String(args.guildId), String(args.nitradoConnId),
  );
  if (financeReset !== 1) throw new Error('Konto-Finanzprofil wurde parallel veraendert; Loeschung abgebrochen.');

  const walletReset = await raw.$executeRawUnsafe(
    'UPDATE "EconomyVirtualAccount" SET "balance"=0, "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "acceptUserTransfers"=false, "archivedAt"=COALESCE("archivedAt", CURRENT_TIMESTAMP), "archivedByDiscordId"=COALESCE("archivedByDiscordId", $4), "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
    args.account.id, String(args.guildId), String(args.nitradoConnId), args.actorDiscordId ? String(args.actorDiscordId) : null,
  );
  if (walletReset !== 1) throw new Error('Virtuelles Konto wurde parallel veraendert; Loeschung abgebrochen.');

  const hidden = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountControlHidden" ("accountId", "guildId", "nitradoConnId", "hiddenAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "hiddenAt"=CURRENT_TIMESTAMP WHERE "EconomyVirtualAccountControlHidden"."guildId"=EXCLUDED."guildId" AND "EconomyVirtualAccountControlHidden"."nitradoConnId"=EXCLUDED."nitradoConnId"',
    args.account.id, String(args.guildId), String(args.nitradoConnId),
  );
  if (hidden !== 1) throw new Error('Konto konnte nicht sicher aus der Kontoverwaltung entfernt werden.');
  return { id: args.account.id, name: args.account.name, mode: 'CONTROL_HIDDEN' };
}

/**
 * Delete is one atomic operation from the dashboard user's perspective:
 * - CUSTOM/GENERAL may be deleted while active and with a non-zero balance.
 * - Wallet and bank are locked and reset to zero inside the same transaction.
 * - If immutable booking/domain history exists, the row is archived + hidden
 *   rather than physically deleted, preserving the audit trail.
 * - Fresh CUSTOM accounts without history are physically deleted after reset.
 * - System accounts remain fail-closed; terminal lottery pots can only be hidden.
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

        return hideAccount(raw, { account, finance, guildId: args.guildId, nitradoConnId: args.nitradoConnId, actorDiscordId: args.actorDiscordId });
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
        ) AS protected`,
        args.accountId,
      );

      if (entries[0]?.exists || protectedRefs[0]?.protected) {
        return hideAccount(raw, { account, finance, guildId: args.guildId, nitradoConnId: args.nitradoConnId, actorDiscordId: args.actorDiscordId });
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
      throw new Error('Das Konto wird noch von geschuetzter Historie referenziert und kann nicht geloescht werden. Bitte erneut laden; die Historie bleibt erhalten.');
    }
    throw error;
  }
}
