import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import type { VirtualAccountRawDb } from './virtualAccounts';

interface LockedVendorRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  balance: bigint;
}

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

export async function listHiddenMarketVendorIds(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
}): Promise<Set<string>> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ vendorAccountId: string }>>(
    'SELECT "vendorAccountId" FROM "EconomyMarketVendorControlHidden" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId),
    String(args.nitradoConnId),
  );
  return new Set(rows.map(row => row.vendorAccountId));
}

/**
 * Entfernt einen MARKET_VENDOR aus den aktiven Schwarzmarkt-Control-Flaechen,
 * ohne Konto-, Listing-, Purchase- oder Order-Historie physisch zu loeschen.
 *
 * Der erste Aufruf ist nur fuer ACTIVE-Haendler erlaubt und archiviert Konto +
 * Control-Hidden-Marker atomar. Ein zweiter Aufruf auf denselben bereits
 * versteckten/archivierten Haendler ist idempotent erfolgreich.
 */
export async function removeMarketVendorFromControl(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  vendorAccountId: string;
  actorDiscordId: UserDiscordId;
}): Promise<{ id: string; name: string; mode: 'CONTROL_HIDDEN'; changed: boolean }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  return prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const vendors = await raw.$queryRawUnsafe<LockedVendorRow[]>(
      'SELECT "id", "name", "kind"::text AS kind, "status"::text AS status, "balance" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.vendorAccountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const vendor = vendors[0];
    if (!vendor || vendor.kind !== 'MARKET_VENDOR') throw new Error('MARKET_VENDOR-Systemkonto nicht gefunden.');

    const hidden = await raw.$queryRawUnsafe<Array<{ vendorAccountId: string }>>(
      'SELECT "vendorAccountId" FROM "EconomyMarketVendorControlHidden" WHERE "vendorAccountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
      args.vendorAccountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    if (hidden[0]) {
      if (vendor.status !== 'ARCHIVED') throw new Error('Haendler-Control-Marker ist inkonsistent; Entfernen abgebrochen.');
      return { id: vendor.id, name: vendor.name, mode: 'CONTROL_HIDDEN' as const, changed: false };
    }

    if (vendor.status !== 'ACTIVE') throw new Error('Nur aktive Haendler koennen entfernt werden.');

    const activeListings = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "EconomyMarketListing" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "vendorAccountId"=$3 AND "active"=TRUE AND "archivedAt" IS NULL',
      String(args.guildId),
      String(args.nitradoConnId),
      args.vendorAccountId,
    );
    if ((activeListings[0]?.count ?? 0n) > 0n) throw new Error('Haendler hat noch aktive Angebote. Archiviere oder entferne diese zuerst.');

    const openOrders = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "EconomyMarketOrder" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "vendorAccountId"=$3 AND "status"=\'OPEN\'::"EconomyMarketOrderStatus"',
      String(args.guildId),
      String(args.nitradoConnId),
      args.vendorAccountId,
    );
    if ((openOrders[0]?.count ?? 0n) > 0n) throw new Error('Haendler hat noch offene Sammelbestellungen. Schliesse diese zuerst ab.');

    const pendingFulfillments = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "EconomyMarketPurchase" p JOIN "EconomyMarketPurchaseFulfillment" f ON f."purchaseId"=p."id" AND f."guildId"=p."guildId" AND f."nitradoConnId"=p."nitradoConnId" WHERE p."guildId"=$1 AND p."nitradoConnId"=$2 AND p."vendorAccountId"=$3 AND f."status"=\'PENDING\'',
      String(args.guildId),
      String(args.nitradoConnId),
      args.vendorAccountId,
    );
    if ((pendingFulfillments[0]?.count ?? 0n) > 0n) throw new Error('Haendler hat noch offene Bestellungen. Liefere oder refunde diese zuerst.');

    const finance = await raw.$queryRawUnsafe<Array<{ bankBalance: bigint }>>(
      'SELECT "bankBalance" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
      args.vendorAccountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    if (vendor.balance !== 0n || (finance[0]?.bankBalance ?? 0n) !== 0n) {
      throw new Error('Haendler besitzt noch Guthaben in Wallet oder Bank. Zahle es vor dem Entfernen aus.');
    }

    const archived = await raw.$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccount" SET "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "archivedAt"=CURRENT_TIMESTAMP, "archivedByDiscordId"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'MARKET_VENDOR\'::"EconomyVirtualAccountKind" AND "status"=\'ACTIVE\'::"EconomyVirtualAccountStatus"',
      args.vendorAccountId,
      String(args.guildId),
      String(args.nitradoConnId),
      String(args.actorDiscordId),
    );
    if (archived !== 1) throw new Error('Haendler wurde parallel veraendert; Entfernen abgebrochen.');

    const marker = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyMarketVendorControlHidden" ("vendorAccountId", "guildId", "nitradoConnId", "hiddenAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT ("vendorAccountId") DO NOTHING',
      args.vendorAccountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    if (marker !== 1) throw new Error('Haendler konnte nicht sicher aus der Verwaltung entfernt werden.');

    return { id: vendor.id, name: vendor.name, mode: 'CONTROL_HIDDEN' as const, changed: true };
  });
}
