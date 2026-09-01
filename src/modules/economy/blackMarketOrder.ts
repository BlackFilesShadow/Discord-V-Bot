import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { getConfig } from './repository';
import { assertEconomyScopeReady } from './scopeMigration';
import { getMarketPurchase, type MarketPurchaseView } from './blackMarket';
import { systemUserToVirtualAccount } from './systemVirtualTransfers';
import type { VirtualAccountRawDb } from './virtualAccounts';

// EconomyMarketPurchase.quantity is PostgreSQL INTEGER; a Katalog-Bestellung
// bucht immer Menge 1 je gewaehltem Angebot (keine Mengenabfrage im Select-Menu).
const ORDER_QUANTITY = 1;
const MAX_ORDER_ITEMS = 25; // Discord StringSelectMenu erlaubt maximal 25 Optionen je Auswahl.

export type MarketOrderStatus = 'OPEN' | 'CLOSED';

export interface MarketOrderView {
  id: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  userDiscordId: string;
  totalAmount: bigint;
  status: MarketOrderStatus;
  orderChannelId: string | null;
  orderMessageId: string | null;
  createdAt: Date;
  closedAt: Date | null;
  closedByDiscordId: string | null;
  purchases: MarketPurchaseView[];
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

function orderKey(external: string): string {
  return `market-order:${cleanExternalKey(external)}`;
}

interface DbOrderRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  userDiscordId: string;
  totalAmount: bigint;
  status: MarketOrderStatus;
  orderChannelId: string | null;
  orderMessageId: string | null;
  createdAt: Date;
  closedAt: Date | null;
  closedByDiscordId: string | null;
}

const ORDER_SELECT = 'SELECT "id","guildId","nitradoConnId","vendorAccountId","userDiscordId","totalAmount","status"::text AS status,"orderChannelId","orderMessageId","createdAt","closedAt","closedByDiscordId" FROM "EconomyMarketOrder"';

async function toOrderView(row: DbOrderRow): Promise<MarketOrderView> {
  const purchaseRows = await rawDb().$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "EconomyMarketPurchase" WHERE "orderId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 ORDER BY "createdAt" ASC',
    row.id, row.guildId, row.nitradoConnId,
  );
  const purchases = (await Promise.all(
    purchaseRows.map(purchase => getMarketPurchase(row.guildId as GuildId, row.nitradoConnId as NitradoConnId, purchase.id)),
  )).filter((purchase): purchase is MarketPurchaseView => purchase !== null);
  return { ...row, purchases };
}

export async function getMarketOrder(guildId: GuildId, nitradoConnId: NitradoConnId, orderId: string): Promise<MarketOrderView | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<DbOrderRow[]>(
    `${ORDER_SELECT} WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1`,
    orderId, String(guildId), String(nitradoConnId),
  );
  return rows[0] ? toOrderView(rows[0]) : null;
}

/** Fuer das Manager-Panel-Dropdown: offene Bestellungen eines Vendor-Kontos. */
export async function listOpenMarketOrders(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  vendorAccountId: string,
  take = 25,
): Promise<MarketOrderView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<DbOrderRow[]>(
    `${ORDER_SELECT} WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "vendorAccountId"=$3 AND "status"='OPEN' ORDER BY "createdAt" ASC LIMIT $4`,
    String(guildId), String(nitradoConnId), vendorAccountId, Math.max(1, Math.min(25, take)),
  );
  return Promise.all(rows.map(toOrderView));
}

async function existingOrderByKey(guildId: GuildId, nitradoConnId: NitradoConnId, key: string): Promise<MarketOrderView | null> {
  // Jede Angebotszeile speichert "${key}:${listingId}" als eigenen
  // Idempotency-Key (siehe mutate() unten); ein exakter Vergleich gegen den
  // reinen Order-Key traf hier nie. left()+Gleichheit statt LIKE, damit ein
  // Unterstrich im Key (von cleanExternalKey erlaubt) kein Wildcard ist.
  const rows = await rawDb().$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT o."id" FROM "EconomyMarketOrder" o JOIN "EconomyMarketPurchase" p ON p."orderId"=o."id" WHERE left(p."idempotencyKey", length($1) + 1) = $1 || \':\' AND o."guildId"=$2 AND o."nitradoConnId"=$3 LIMIT 1',
    key, String(guildId), String(nitradoConnId),
  );
  return rows[0] ? getMarketOrder(guildId, nitradoConnId, rows[0].id) : null;
}

/**
 * Katalog-weite Mehrfach-Bestellung: buendelt mehrere Angebote DESSELBEN
 * Haendlers zu genau einer Wallet-Buchung + Bestellung. Bewusst
 * einzelvendor-gescoppt: eine Buchung ueber mehrere Vendor-Konten koennte bei
 * einem Teilfehler eine bereits gezahlte, aber nicht vollstaendige Bestellung
 * hinterlassen. Nutzt dieselbe atomare systemUserToVirtualAccount-Buchung wie
 * der bestehende Einzel-Direktkauf; die Menge ist je Angebot immer 1.
 */
export async function createMarketOrder(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  listingIds: string[];
  idempotencyKey: string;
}): Promise<{ booked: boolean; order: MarketOrderView }> {
  const listingIds = [...new Set(args.listingIds)];
  if (listingIds.length < 1 || listingIds.length > MAX_ORDER_ITEMS) {
    throw new Error(`Eine Bestellung muss 1..${MAX_ORDER_ITEMS} Angebote enthalten.`);
  }
  const key = orderKey(args.idempotencyKey);

  const replay = await existingOrderByKey(args.guildId, args.nitradoConnId, key);
  if (replay) return { booked: false, order: replay };

  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');

  const initialRows = await rawDb().$queryRawUnsafe<LockedListing[]>(
    'SELECT "id","vendorAccountId","name","price","active","archivedAt" FROM "EconomyMarketListing" WHERE "id" = ANY($1) AND "guildId"=$2 AND "nitradoConnId"=$3',
    listingIds, String(args.guildId), String(args.nitradoConnId),
  );
  if (initialRows.length !== listingIds.length) throw new Error('Mindestens ein Angebot wurde nicht gefunden.');
  for (const row of initialRows) if (!row.active || row.archivedAt) throw new Error(`Angebot "${row.name}" ist nicht mehr aktiv.`);
  const vendorAccountId = initialRows[0].vendorAccountId;
  if (initialRows.some(row => row.vendorAccountId !== vendorAccountId)) {
    throw new Error('Eine Bestellung kann nur Angebote desselben Haendlers enthalten.');
  }
  const totalAmount = initialRows.reduce((sum, row) => sum + row.price, 0n);

  const transfer = await systemUserToVirtualAccount<{ listings: LockedListing[] }, string>({
    idempotencyKey: key,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: vendorAccountId,
    fromUserId: args.userDiscordId,
    sourcePocket: 'WALLET',
    amount: totalAmount,
    expectedKind: 'MARKET_VENDOR',
    economyTxType: 'MARKET_PURCHASE',
    entryType: 'MARKET_ORDER',
    reason: `Schwarzmarkt-Bestellung: ${initialRows.length} Angebot(e)`,
    sourceRef: `market-order:${listingIds.join(',')}`,
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
        const purchaseId = randomUUID();
        await raw.$executeRawUnsafe(
          'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","sourcePocket","quantity","unitPrice","amount","orderId","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,\'WALLET\',$8,$9,$9,$10,CURRENT_TIMESTAMP)',
          purchaseId, `${key}:${listing.id}`, listing.id, String(args.guildId), String(args.nitradoConnId), vendorAccountId,
          String(args.userDiscordId), ORDER_QUANTITY, listing.price, orderId,
        );
        const storedItems = await raw.$queryRawUnsafe<ListingItemRow[]>(
          'SELECT "className", "quantity" FROM "EconomyMarketListingItem" WHERE "listingId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 ORDER BY "className"',
          listing.id, String(args.guildId), String(args.nitradoConnId),
        );
        const deliveryItems = storedItems.length
          ? storedItems.map(item => ({ itemText: item.className, quantity: item.quantity }))
          : [{ itemText: listing.name, quantity: ORDER_QUANTITY }];
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
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, orderId: order.id,
    userDiscordId: args.userDiscordId, items: listingIds.length, amount: totalAmount.toString(), booked: transfer.booked,
  });
  return { booked: transfer.booked, order };
}

/** Verknuepft die im Bestell-Kanal geposteten Embed/Message-IDs mit der Bestellung. */
export async function attachMarketOrderMessage(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  orderId: string;
  channelId: string;
  messageId: string;
}): Promise<void> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  await prisma.$executeRawUnsafe(
    'UPDATE "EconomyMarketOrder" SET "orderChannelId"=$4, "orderMessageId"=$5 WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
    args.orderId, String(args.guildId), String(args.nitradoConnId), args.channelId, args.messageId,
  );
}

/**
 * Plant die garantierte 1-Minuten-Loeschung der "Bestellung bereit"-Mention
 * (Muster: ServerBanExpiryNotice). Ein einfaches setTimeout wuerde bei einem
 * Bot-Neustart innerhalb der Minute verloren gehen; dieser Datensatz wird
 * stattdessen von marketOrderReadyRuntime.ts persistent abgearbeitet.
 */
export async function scheduleMarketOrderReadyNotice(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  orderId: string;
  channelId: string;
  userDiscordId: UserDiscordId;
  messageId: string;
  now?: Date;
}): Promise<void> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const deleteAt = new Date((args.now ?? new Date()).getTime() + 60_000);
  await prisma.$executeRawUnsafe(
    'INSERT INTO "EconomyMarketOrderReadyNotice" ("id","orderId","guildId","nitradoConnId","channelId","userDiscordId","messageId","deleteAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP) ON CONFLICT ("orderId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "deleteAt"=EXCLUDED."deleteAt", "deletedAt"=NULL',
    randomUUID(), args.orderId, String(args.guildId), String(args.nitradoConnId), args.channelId, String(args.userDiscordId), args.messageId, deleteAt,
  );
}

/**
 * Schliesst eine offene Bestellung: markiert alle enthaltenen Kaeufe als
 * DELIVERED und die Bestellung selbst als CLOSED, atomar in einer Transaktion.
 * Idempotent: ein bereits geschlossenes CLOSED-Ergebnis liefert changed=false.
 */
export async function closeMarketOrder(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  orderId: string;
  vendorAccountId: string;
  actorDiscordId: UserDiscordId;
}): Promise<{ changed: boolean; order: MarketOrderView }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const changed = await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const rows = await raw.$queryRawUnsafe<Array<{ status: MarketOrderStatus }>>(
      'SELECT "status"::text AS status FROM "EconomyMarketOrder" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "vendorAccountId"=$4 LIMIT 1 FOR UPDATE',
      args.orderId, String(args.guildId), String(args.nitradoConnId), args.vendorAccountId,
    );
    if (!rows[0]) throw new Error('Bestellung nicht gefunden.');
    if (rows[0].status === 'CLOSED') return false;
    const purchaseIds = await raw.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "EconomyMarketPurchase" WHERE "orderId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.orderId, String(args.guildId), String(args.nitradoConnId),
    );
    for (const purchase of purchaseIds) {
      await raw.$executeRawUnsafe(
        'UPDATE "EconomyMarketPurchaseFulfillment" SET "status"=\'DELIVERED\', "fulfilledAt"=CURRENT_TIMESTAMP, "fulfilledByDiscordId"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "purchaseId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"=\'PENDING\'',
        purchase.id, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId),
      );
    }
    const closed = await raw.$executeRawUnsafe(
      'UPDATE "EconomyMarketOrder" SET "status"=\'CLOSED\', "closedAt"=CURRENT_TIMESTAMP, "closedByDiscordId"=$4 WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"=\'OPEN\'',
      args.orderId, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId),
    );
    if (closed !== 1) throw new Error('Bestellung wurde parallel veraendert. Bitte neu laden.');
    return true;
  });
  const order = await getMarketOrder(args.guildId, args.nitradoConnId, args.orderId);
  if (!order) throw new Error('Geschlossene Bestellung konnte nicht gelesen werden.');
  logAudit('MARKET_ORDER_CLOSED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, orderId: args.orderId,
    actorDiscordId: args.actorDiscordId, changed,
  });
  return { changed, order };
}
