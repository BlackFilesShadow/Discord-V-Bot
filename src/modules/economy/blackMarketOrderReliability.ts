import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { getMarketOrder, type MarketOrderStatus, type MarketOrderView } from './blackMarketOrder';
import { assertEconomyScopeReady } from './scopeMigration';
import type { VirtualAccountRawDb } from './virtualAccounts';

export const MARKET_MANAGER_PAGE_SIZE = 25;

interface CountRow { count: number | bigint }
interface IdRow { id: string }
interface LockedOrderRow {
  status: MarketOrderStatus;
  userDiscordId: string;
}
interface ProjectionRow { orderReadyChannelId: string | null }

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function normalizeVendorIds(vendorAccountIds: string[]): string[] {
  return [...new Set(vendorAccountIds.map(value => value.trim()).filter(Boolean))].sort();
}

export async function listManagedOpenMarketOrderPage(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  vendorAccountIds: string[];
  page: number;
  pageSize?: number;
}): Promise<{ orders: MarketOrderView[]; page: number; total: number; totalPages: number }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  if (!Number.isSafeInteger(args.page) || args.page < 0) throw new Error('Ungueltige Bestellseite.');
  const vendorIds = normalizeVendorIds(args.vendorAccountIds);
  if (vendorIds.length === 0) return { orders: [], page: 0, total: 0, totalPages: 0 };
  const pageSize = Math.max(1, Math.min(MARKET_MANAGER_PAGE_SIZE, args.pageSize ?? MARKET_MANAGER_PAGE_SIZE));

  const counts = await rawDb().$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*)::int AS count
     FROM "EconomyMarketOrder"
     WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "status"='OPEN'
       AND "vendorAccountId" = ANY($3)`,
    String(args.guildId), String(args.nitradoConnId), vendorIds,
  );
  const total = Number(counts[0]?.count ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  if (totalPages === 0) return { orders: [], page: 0, total: 0, totalPages: 0 };
  if (args.page >= totalPages) throw new Error('Diese Bestellseite existiert nicht mehr. Bitte neu laden.');

  const rows = await rawDb().$queryRawUnsafe<IdRow[]>(
    `SELECT "id"
     FROM "EconomyMarketOrder"
     WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "status"='OPEN'
       AND "vendorAccountId" = ANY($3)
     ORDER BY "createdAt" ASC, "id" ASC
     LIMIT $4 OFFSET $5`,
    String(args.guildId), String(args.nitradoConnId), vendorIds, pageSize, args.page * pageSize,
  );
  const orders = (await Promise.all(rows.map(row => getMarketOrder(args.guildId, args.nitradoConnId, row.id))))
    .filter((order): order is MarketOrderView => order !== null && order.status === 'OPEN' && vendorIds.includes(order.vendorAccountId));
  return { orders, page: args.page, total, totalPages };
}

/**
 * Schliesst Order + Fulfillments und erzeugt den Ready-Send-Auftrag in EINER
 * DB-Transaktion. Externe Discord-Sideeffects erfolgen erst danach durch die
 * retrybare Runtime. Ein zweiter Close bleibt idempotent und erzeugt keinen
 * zweiten Ready-Auftrag (orderId ist UNIQUE).
 */
export async function closeMarketOrderWithReadyIntent(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  orderId: string;
  vendorAccountId: string;
  actorDiscordId: UserDiscordId;
}): Promise<{ changed: boolean; order: MarketOrderView }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const changed = await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const rows = await raw.$queryRawUnsafe<LockedOrderRow[]>(
      `SELECT "status"::text AS status, "userDiscordId"
       FROM "EconomyMarketOrder"
       WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "vendorAccountId"=$4
       LIMIT 1 FOR UPDATE`,
      args.orderId, String(args.guildId), String(args.nitradoConnId), args.vendorAccountId,
    );
    const order = rows[0];
    if (!order) throw new Error('Bestellung nicht gefunden.');
    if (order.status === 'CLOSED') return false;

    const projections = await raw.$queryRawUnsafe<ProjectionRow[]>(
      `SELECT "orderReadyChannelId"
       FROM "EconomyMarketDiscordProjection"
       WHERE "guildId"=$1 AND "nitradoConnId"=$2
       LIMIT 1`,
      String(args.guildId), String(args.nitradoConnId),
    );
    const readyChannelId = projections[0]?.orderReadyChannelId?.trim() ?? '';
    if (!readyChannelId) {
      throw new Error('Bestellung-fertig-Kanal ist nicht konfiguriert. Die Bestellung bleibt offen.');
    }

    await raw.$executeRawUnsafe(
      `UPDATE "EconomyMarketPurchaseFulfillment" f
       SET "status"='DELIVERED', "fulfilledAt"=CURRENT_TIMESTAMP,
           "fulfilledByDiscordId"=$4, "updatedAt"=CURRENT_TIMESTAMP
       FROM "EconomyMarketPurchase" p
       WHERE p."id"=f."purchaseId"
         AND p."orderId"=$1 AND p."guildId"=$2 AND p."nitradoConnId"=$3
         AND f."guildId"=$2 AND f."nitradoConnId"=$3 AND f."status"='PENDING'`,
      args.orderId, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId),
    );

    const closed = await raw.$executeRawUnsafe(
      `UPDATE "EconomyMarketOrder"
       SET "status"='CLOSED', "closedAt"=CURRENT_TIMESTAMP, "closedByDiscordId"=$4
       WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"='OPEN'`,
      args.orderId, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId),
    );
    if (closed !== 1) throw new Error('Bestellung wurde parallel veraendert. Bitte neu laden.');

    await raw.$executeRawUnsafe(
      `INSERT INTO "EconomyMarketOrderReadyNotice"
       ("id","orderId","guildId","nitradoConnId","channelId","userDiscordId","messageId","status","attempts","nextAttemptAt","leaseUntil","lastError","sentAt","deleteAt","deletedAt","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,NULL,'READY',0,CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP)`,
      randomUUID(), args.orderId, String(args.guildId), String(args.nitradoConnId), readyChannelId, order.userDiscordId,
    );
    return true;
  });

  const order = await getMarketOrder(args.guildId, args.nitradoConnId, args.orderId);
  if (!order) throw new Error('Geschlossene Bestellung konnte nicht gelesen werden.');
  logAudit('MARKET_ORDER_CLOSED', 'ECONOMY', {
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    orderId: args.orderId,
    actorDiscordId: args.actorDiscordId,
    readyIntentCreated: changed,
    changed,
  });
  return { changed, order };
}
