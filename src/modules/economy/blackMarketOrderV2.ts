import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { getConfig } from './repository';
import { assertEconomyScopeReady } from './scopeMigration';
import { systemUserToVirtualAccount } from './systemVirtualTransfers';
import type { EconomyPocket } from './virtualAccounts';
import { getMarketOrder, type MarketOrderView } from './blackMarketOrder';

export const MAX_MARKET_ORDER_UNITS = 20;

export interface MarketOrderLineInput {
  listingId: string;
  quantity: number;
}

interface LockedListing {
  id: string;
  vendorAccountId: string;
  name: string;
  price: bigint;
  active: boolean;
  archivedAt: Date | null;
}

interface ListingItemRow {
  className: string;
  quantity: number;
}

function cleanExternalKey(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 48 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('Idempotency-Key ist ungueltig.');
  }
  return normalized;
}

function orderKey(external: string): string {
  return `market-order:${cleanExternalKey(external)}`;
}

function normalizeLines(lines: MarketOrderLineInput[]): MarketOrderLineInput[] {
  if (!Array.isArray(lines) || lines.length < 1) throw new Error('Die Bestellung ist leer.');
  const combined = new Map<string, number>();
  for (const line of lines) {
    if (!line || typeof line.listingId !== 'string' || !line.listingId.trim()) throw new Error('Bestellung enthaelt ein ungueltiges Angebot.');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_MARKET_ORDER_UNITS) {
      throw new Error(`Menge muss zwischen 1 und ${MAX_MARKET_ORDER_UNITS} liegen.`);
    }
    combined.set(line.listingId, (combined.get(line.listingId) ?? 0) + line.quantity);
  }
  const result = [...combined.entries()].map(([listingId, quantity]) => ({ listingId, quantity }));
  if (result.some(line => line.quantity > MAX_MARKET_ORDER_UNITS)) {
    throw new Error(`Pro Artikel sind maximal ${MAX_MARKET_ORDER_UNITS} Stück erlaubt.`);
  }
  const totalUnits = result.reduce((sum, line) => sum + line.quantity, 0);
  if (totalUnits > MAX_MARKET_ORDER_UNITS) {
    throw new Error(`Eine Bestellung darf insgesamt maximal ${MAX_MARKET_ORDER_UNITS} Artikel enthalten.`);
  }
  return result;
}

async function existingOrderByKey(guildId: GuildId, nitradoConnId: NitradoConnId, key: string): Promise<MarketOrderView | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT o."id" FROM "EconomyMarketOrder" o JOIN "EconomyMarketPurchase" p ON p."orderId"=o."id" WHERE left(p."idempotencyKey", length($1) + 1) = $1 || \":\" AND o."guildId"=$2 AND o."nitradoConnId"=$3 LIMIT 1',
    key, String(guildId), String(nitradoConnId),
  );
  return rows[0] ? getMarketOrder(guildId, nitradoConnId, rows[0].id) : null;
}

export async function createMarketOrderV2(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  lines: MarketOrderLineInput[];
  sourcePocket: EconomyPocket;
  idempotencyKey: string;
}): Promise<{ booked: boolean; order: MarketOrderView }> {
  const lines = normalizeLines(args.lines);
  const listingIds = lines.map(line => line.listingId);
  const quantities = new Map(lines.map(line => [line.listingId, line.quantity]));
  const key = orderKey(args.idempotencyKey);

  const replay = await existingOrderByKey(args.guildId, args.nitradoConnId, key);
  if (replay) return { booked: false, order: replay };

  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');

  const initialRows = await prisma.$queryRawUnsafe<LockedListing[]>(
    'SELECT "id","vendorAccountId","name","price","active","archivedAt" FROM "EconomyMarketListing" WHERE "id" = ANY($1) AND "guildId"=$2 AND "nitradoConnId"=$3',
    listingIds, String(args.guildId), String(args.nitradoConnId),
  );
  if (initialRows.length !== listingIds.length) throw new Error('Mindestens ein Angebot wurde nicht gefunden.');
  for (const row of initialRows) if (!row.active || row.archivedAt) throw new Error(`Angebot "${row.name}" ist nicht mehr aktiv.`);

  const vendorAccountId = initialRows[0].vendorAccountId;
  if (initialRows.some(row => row.vendorAccountId !== vendorAccountId)) {
    throw new Error('Eine Bestellung kann nur Angebote desselben Haendlers enthalten.');
  }
  const totalAmount = initialRows.reduce((sum, row) => sum + row.price * BigInt(quantities.get(row.id) ?? 1), 0n);

  const transfer = await systemUserToVirtualAccount<{ listings: LockedListing[] }, string>({
    idempotencyKey: key,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: vendorAccountId,
    fromUserId: args.userDiscordId,
    sourcePocket: args.sourcePocket,
    amount: totalAmount,
    expectedKind: 'MARKET_VENDOR',
    economyTxType: 'MARKET_PURCHASE',
    entryType: 'MARKET_ORDER',
    reason: `Schwarzmarkt-Bestellung: ${lines.reduce((sum, line) => sum + line.quantity, 0)} Artikel`,
    sourceRef: `market-order:${lines.map(line => `${line.listingId}x${line.quantity}`).join(',')}`,
    actorDiscordId: args.userDiscordId,
  }, {
    beforeClaim: async raw => {
      const rows = await raw.$queryRawUnsafe<LockedListing[]>(
        'SELECT "id","vendorAccountId","name","price","active","archivedAt" FROM "EconomyMarketListing" WHERE "id" = ANY($1) AND "guildId"=$2 AND "nitradoConnId"=$3 FOR UPDATE',
        listingIds, String(args.guildId), String(args.nitradoConnId),
      );
      if (rows.length !== listingIds.length) throw new Error('Mindestens ein Angebot wurde waehrend der Bestellung entfernt.');
      for (const row of rows) {
        if (!row.active || row.archivedAt) throw new Error(`Angebot "${row.name}" wurde waehrend der Bestellung deaktiviert.`);
        if (row.vendorAccountId !== vendorAccountId) throw new Error('Angebot wurde waehrend der Bestellung einem anderen Haendler zugeordnet.');
      }
      return { listings: rows };
    },
    mutate: async ({ raw, preflight }) => {
      const orderId = randomUUID();
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyMarketOrder" ("id","guildId","nitradoConnId","vendorAccountId","userDiscordId","totalAmount","status","createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'OPEN\',CURRENT_TIMESTAMP)',
        orderId, String(args.guildId), String(args.nitradoConnId), vendorAccountId, String(args.userDiscordId), totalAmount,
      );

      for (const listing of preflight.listings) {
        const quantity = quantities.get(listing.id) ?? 1;
        const amount = listing.price * BigInt(quantity);
        const purchaseId = randomUUID();
        await raw.$executeRawUnsafe(
          'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","sourcePocket","quantity","unitPrice","amount","orderId","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP)',
          purchaseId, `${key}:${listing.id}`, listing.id, String(args.guildId), String(args.nitradoConnId), vendorAccountId,
          String(args.userDiscordId), args.sourcePocket, quantity, listing.price, amount, orderId,
        );
        const storedItems = await raw.$queryRawUnsafe<ListingItemRow[]>(
          'SELECT "className", "quantity" FROM "EconomyMarketListingItem" WHERE "listingId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 ORDER BY "className"',
          listing.id, String(args.guildId), String(args.nitradoConnId),
        );
        const deliveryItems = storedItems.length
          ? storedItems.map(item => ({ itemText: item.className, quantity: item.quantity * quantity }))
          : [{ itemText: listing.name, quantity }];
        await raw.$executeRawUnsafe(
          'INSERT INTO "EconomyMarketPurchaseFulfillment" ("purchaseId","guildId","nitradoConnId","status","deliveryItems","createdAt","updatedAt") VALUES ($1,$2,$3,\'PENDING\',$4::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
          purchaseId, String(args.guildId), String(args.nitradoConnId), JSON.stringify(deliveryItems),
        );
      }
      return orderId;
    },
  });

  const order = await existingOrderByKey(args.guildId, args.nitradoConnId, key);
  if (!order) throw new Error('Schwarzmarkt-Bestellung konnte nicht vollstaendig gelesen werden.');
  logAudit('MARKET_ORDER_CREATED', 'ECONOMY', {
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    orderId: order.id,
    userDiscordId: args.userDiscordId,
    items: lines.reduce((sum, line) => sum + line.quantity, 0),
    amount: totalAmount.toString(),
    sourcePocket: args.sourcePocket,
    booked: transfer.booked,
  });
  return { booked: transfer.booked, order };
}

export async function scheduleMarketOrderReadyNoticeOneHour(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  orderId: string;
  channelId: string;
  userDiscordId: UserDiscordId;
  messageId: string;
  now?: Date;
}): Promise<void> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const deleteAt = new Date((args.now ?? new Date()).getTime() + 60 * 60_000);
  await prisma.$executeRawUnsafe(
    'INSERT INTO "EconomyMarketOrderReadyNotice" ("id","orderId","guildId","nitradoConnId","channelId","userDiscordId","messageId","deleteAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP) ON CONFLICT ("orderId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "deleteAt"=EXCLUDED."deleteAt", "deletedAt"=NULL',
    randomUUID(), args.orderId, String(args.guildId), String(args.nitradoConnId), args.channelId, String(args.userDiscordId), args.messageId, deleteAt,
  );
}
