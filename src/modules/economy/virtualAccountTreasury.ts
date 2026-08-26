import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import { getConfig } from './repository';
import { getVirtualAccountById, type VirtualAccountRawDb, type VirtualAccountRow } from './virtualAccounts';
import { ensureVirtualAccountFinance, type VirtualAccountFinance } from './virtualAccountFinance';

interface TreasuryRow { accountId: string }
interface InsertedAccount { id: string }

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

/**
 * Database-serialized treasury creation.
 *
 * The partial unique index on BANK_TREASURY is the final invariant, while the
 * transaction-scoped PostgreSQL advisory lock prevents two concurrent requests
 * from first creating two ordinary CUSTOM accounts and only then racing on the
 * finance-purpose update.
 */
export async function ensureBankTreasurySerialized(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  createdByDiscordId: UserDiscordId;
}): Promise<{ account: VirtualAccountRow; finance: VirtualAccountFinance }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const cfg = await getConfig(args.guildId, args.nitradoConnId);

  const accountId = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const lockKey = `vbot:virtual-bank:${String(args.guildId)}:${String(args.nitradoConnId)}`;
    await raw.$queryRawUnsafe<Array<{ pg_advisory_xact_lock: null }>>(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      lockKey,
    );

    const existing = await raw.$queryRawUnsafe<TreasuryRow[]>(
      'SELECT "accountId" FROM "EconomyVirtualAccountFinance" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountPurpose"=\'BANK_TREASURY\' LIMIT 1',
      String(args.guildId),
      String(args.nitradoConnId),
    );
    if (existing[0]) return existing[0].accountId;

    const candidates = [
      'Serverbank',
      'Serverbank · V-Bot',
      `Serverbank · ${String(args.nitradoConnId).slice(-8)}`,
      `Serverbank · ${randomUUID().slice(0, 8)}`,
    ];

    let createdId: string | null = null;
    for (const name of candidates) {
      const rows = await raw.$queryRawUnsafe<InsertedAccount[]>(
        'INSERT INTO "EconomyVirtualAccount" ("id", "guildId", "nitradoConnId", "kind", "name", "nameKey", "balance", "status", "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt") VALUES ($1,$2,$3,\'CUSTOM\'::"EconomyVirtualAccountKind",$4,$5,0,\'ACTIVE\'::"EconomyVirtualAccountStatus",true,NULL,NULL,NULL,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "nameKey") DO NOTHING RETURNING "id"',
        randomUUID(),
        String(args.guildId),
        String(args.nitradoConnId),
        name,
        name.toLowerCase(),
        String(args.createdByDiscordId),
      );
      if (rows[0]) {
        createdId = rows[0].id;
        break;
      }
    }
    if (!createdId) throw new Error('Serverbank konnte nicht mit einem eindeutigen Namen angelegt werden.');

    const financeChanged = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountFinance" ("accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt") VALUES ($1,$2,$3,0,$4,$5,\'🏦\',NULL,\'NORMAL\',NULL,NULL,\'BANK_TREASURY\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      createdId,
      String(args.guildId),
      String(args.nitradoConnId),
      cfg.currencyName,
      cfg.emoji,
    );
    if (financeChanged !== 1) throw new Error('Serverbank-Finanzprofil konnte nicht erzeugt werden.');
    return createdId;
  });

  const [account, finance] = await Promise.all([
    getVirtualAccountById(args.guildId, args.nitradoConnId, accountId),
    ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, accountId),
  ]);
  if (!account) throw new Error('Serverbank wurde angelegt, konnte aber nicht konsistent gelesen werden.');
  return { account, finance };
}
