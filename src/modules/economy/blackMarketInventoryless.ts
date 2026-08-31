import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { getConfig } from './repository';
import { assertEconomyScopeReady } from './scopeMigration';
import { getMarketListing, getMarketPurchase, type MarketListingView, type MarketPurchaseView } from './blackMarket';
import { systemUserToVirtualAccount } from './systemVirtualTransfers';
import type { EconomyPocket, VirtualAccountRawDb } from './virtualAccounts';

const MAX_PER_PURCHASE = 1000;

interface LockedListing {
  id: string;
  vendorAccountId: string;
  name: string;
  price: bigint;
  maxPerPurchase: number;
  active: boolean;
  archivedAt: Date | null;
}

interface ListingItemRow {
  className: string;
  quantity: number;
}

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function cleanExternalKey(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 48 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('Idempotency-Key ist ungueltig.');
  }
  return normalized;
}

function purchaseKey(listingId: string, external: string): string {
  return `market:${listingId}:${cleanExternalKey(external)}`;
}

async function existingPurchaseByKey(key: string): Promise<MarketPurchaseView | null> {
  const rows = await rawDb().$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "EconomyMarketPurchase" WHERE "idempotencyKey"=$1 LIMIT 1',
    key,
  );
  return rows[0] ? getMarketPurchaseFromId(rows[0].id) : null;

  async function getMarketPurchaseFromId(id: string): Promise<MarketPurchaseView | null> {
    const scope = await rawDb().$queryRawUnsafe<Array<{ guildId: string; nitradoConnId: string }>>(
      'SELECT "guildId", "nitradoConnId" FROM "EconomyMarketPurchase" WHERE "id"=$1 LIMIT 1',
      id,
    );
    const row = scope[0];
    return row ? getMarketPurchase(row.guildId as GuildId, row.nitradoConnId as NitradoConnId, id) : null;
  }
}

function assertReplay(row: MarketPurchaseView, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  userDiscordId: UserDiscordId;
  sourcePocket: EconomyPocket;
  quantity: number;
}): void {
  const same = row.guildId === String(args.guildId)
    && row.nitradoConnId === String(args.nitradoConnId)
    && row.listingId === args.listingId
    && row.userDiscordId === String(args.userDiscordId)
    && row.sourcePocket === args.sourcePocket
    && row.quantity === args.quantity;
  if (!same) throw new Error('Market-Idempotency-Key wurde mit anderen Kaufdaten wiederverwendet.');
}

/**
 * Inventoryless market purchase.
 *
 * Offers are availability-by-activation, not a quantity stock. The purchase
 * still locks the listing, verifies price/vendor/max-per-purchase, debits the
 * buyer, credits the vendor and creates purchase+fulfillment in one database
 * transaction. No stock check/decrement exists in this path.
 */
export async function buyInventorylessMarketListing(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  userDiscordId: UserDiscordId;
  quantity: number;
  sourcePocket?: EconomyPocket;
  idempotencyKey: string;
}): Promise<{ booked: boolean; purchase: MarketPurchaseView; listing: MarketListingView }> {
  if (!Number.isSafeInteger(args.quantity) || args.quantity < 1 || args.quantity > MAX_PER_PURCHASE) {
    throw new Error(`Menge muss zwischen 1 und ${MAX_PER_PURCHASE} liegen.`);
  }
  const sourcePocket = args.sourcePocket ?? 'WALLET';
  if (sourcePocket !== 'WALLET' && sourcePocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  const key = purchaseKey(args.listingId, args.idempotencyKey);

  const replay = await existingPurchaseByKey(key);
  if (replay) {
    assertReplay(replay, { ...args, sourcePocket });
    const listing = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
    if (!listing) throw new Error('Bestaetigter Schwarzmarkt-Kauf ist inkonsistent.');
    return { booked: false, purchase: replay, listing };
  }

  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');
  const initial = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!initial || !initial.active || initial.archivedAt) throw new Error('Aktives Listing nicht gefunden.');
  if (args.quantity > initial.maxPerPurchase) throw new Error(`Pro Kauf sind maximal ${initial.maxPerPurchase} erlaubt.`);
  const amount = initial.price * BigInt(args.quantity);

  const transfer = await systemUserToVirtualAccount({
    idempotencyKey: key,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: initial.vendorAccountId,
    fromUserId: args.userDiscordId,
    sourcePocket,
    amount,
    expectedKind: 'MARKET_VENDOR',
    economyTxType: 'MARKET_PURCHASE',
    entryType: 'MARKET_PURCHASE',
    reason: `Schwarzmarkt: ${initial.name} x${args.quantity}`,
    sourceRef: `market-listing:${args.listingId}`,
    actorDiscordId: args.userDiscordId,
  }, {
    beforeClaim: async raw => {
      const rows = await raw.$queryRawUnsafe<LockedListing[]>(
        'SELECT "id", "vendorAccountId", "name", "price", "maxPerPurchase", "active", "archivedAt" FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.listingId, String(args.guildId), String(args.nitradoConnId),
      );
      const listing = rows[0];
      if (!listing || !listing.active || listing.archivedAt) throw new Error('Aktives Listing nicht gefunden.');
      if (listing.vendorAccountId !== initial.vendorAccountId || listing.price !== initial.price) {
        throw new Error('Listing wurde waehrend des Kaufs geaendert. Bitte erneut versuchen.');
      }
      if (args.quantity > listing.maxPerPurchase) throw new Error(`Pro Kauf sind maximal ${listing.maxPerPurchase} erlaubt.`);
      const storedItems = await raw.$queryRawUnsafe<ListingItemRow[]>(
        'SELECT "className", "quantity" FROM "EconomyMarketListingItem" WHERE "listingId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 ORDER BY "className"',
        args.listingId, String(args.guildId), String(args.nitradoConnId),
      );
      const deliveryItems = storedItems.length
        ? storedItems.map(item => ({ itemText: item.className, quantity: item.quantity }))
        : [{ itemText: listing.name, quantity: 1 }];
      return { listing, deliveryItems };
    },
    mutate: async ({ raw, preflight }) => {
      const purchaseId = randomUUID();
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","sourcePocket","quantity","unitPrice","amount","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)',
        purchaseId, key, args.listingId, String(args.guildId), String(args.nitradoConnId), preflight.listing.vendorAccountId,
        String(args.userDiscordId), sourcePocket, args.quantity, preflight.listing.price, amount,
      );
      const deliverySnapshot = preflight.deliveryItems.map(item => ({ itemText: item.itemText, quantity: item.quantity * args.quantity }));
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyMarketPurchaseFulfillment" ("purchaseId","guildId","nitradoConnId","status","deliveryItems","createdAt","updatedAt") VALUES ($1,$2,$3,\'PENDING\',$4::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        purchaseId, String(args.guildId), String(args.nitradoConnId), JSON.stringify(deliverySnapshot),
      );
      return true;
    },
  });

  const purchase = await existingPurchaseByKey(key);
  const listing = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!purchase || !listing) throw new Error('Schwarzmarkt-Kauf konnte nicht vollstaendig gelesen werden.');
  assertReplay(purchase, { ...args, sourcePocket });
  logAudit('MARKET_PURCHASE', 'ECONOMY', {
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    listingId: args.listingId,
    purchaseId: purchase.id,
    userDiscordId: args.userDiscordId,
    quantity: args.quantity,
    amount: amount.toString(),
    booked: transfer.booked,
    fulfillmentStatus: purchase.fulfillmentStatus,
    inventoryless: true,
  });
  return { booked: transfer.booked, purchase, listing };
}
