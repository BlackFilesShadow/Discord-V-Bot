import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { getMarketPurchase, type MarketPurchaseView } from './blackMarket';
import { assertEconomyScopeReady } from './scopeMigration';
import { systemVirtualAccountToUser } from './systemVirtualTransfers';
import type { VirtualAccountRawDb } from './virtualAccounts';

interface LockedPurchaseRow {
  id: string;
  vendorAccountId: string;
  userDiscordId: string;
  sourcePocket: string;
  amount: bigint;
  status: string;
}

function cleanReason(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new Error('Refund-Grund fehlt.');
  if (normalized.length > 500) throw new Error('Refund-Grund ist zu lang.');
  return normalized;
}

/**
 * Inventoryless refund path. The old stock restoration is deliberately absent:
 * offers have no inventory and a refund only reverses the money transfer plus
 * the immutable fulfillment status.
 */
export async function refundInventorylessMarketPurchase(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  purchaseId: string;
  actorDiscordId: UserDiscordId;
  reason: string;
}): Promise<{ booked: boolean; purchase: MarketPurchaseView }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const reason = cleanReason(args.reason);
  const before = await getMarketPurchase(args.guildId, args.nitradoConnId, args.purchaseId);
  if (!before) throw new Error('Schwarzmarkt-Kauf nicht gefunden.');
  if (before.fulfillmentStatus === 'REFUNDED') return { booked: false, purchase: before };
  if (before.fulfillmentStatus !== 'PENDING') {
    throw new Error(`Nur offene Bestellungen können refundiert werden (Status: ${before.fulfillmentStatus}).`);
  }

  const transfer = await systemVirtualAccountToUser({
    idempotencyKey: `market-refund:${before.id}`,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: before.vendorAccountId,
    toUserId: before.userDiscordId as UserDiscordId,
    targetPocket: before.sourcePocket,
    amount: before.amount,
    expectedKind: 'MARKET_VENDOR',
    economyTxType: 'TRANSFER',
    entryType: 'MARKET_REFUND',
    reason: `Schwarzmarkt-Refund: ${reason}`,
    sourceRef: `market-purchase:${before.id}`,
    actorDiscordId: args.actorDiscordId,
  }, {
    beforeLock: async (raw: VirtualAccountRawDb) => {
      const rows = await raw.$queryRawUnsafe<LockedPurchaseRow[]>(
        `SELECT p."id", p."vendorAccountId", p."userDiscordId", p."sourcePocket", p."amount", f."status"
           FROM "EconomyMarketPurchase" p
           JOIN "EconomyMarketPurchaseFulfillment" f
             ON f."purchaseId"=p."id"
            AND f."guildId"=p."guildId"
            AND f."nitradoConnId"=p."nitradoConnId"
          WHERE p."id"=$1 AND p."guildId"=$2 AND p."nitradoConnId"=$3
          LIMIT 1 FOR UPDATE OF p, f`,
        before.id,
        String(args.guildId),
        String(args.nitradoConnId),
      );
      const locked = rows[0];
      if (!locked) throw new Error('Schwarzmarkt-Kauf nicht gefunden.');
      if (locked.status !== 'PENDING') throw new Error(`Bestellung ist nicht mehr offen (Status: ${locked.status}).`);
      if (
        locked.vendorAccountId !== before.vendorAccountId
        || locked.amount !== before.amount
        || locked.userDiscordId !== before.userDiscordId
        || locked.sourcePocket !== before.sourcePocket
      ) {
        throw new Error('Bestelldaten wurden unerwartet verändert; Refund abgebrochen.');
      }
      return locked;
    },
    mutate: async ({ raw, preflight }) => {
      const updated = await raw.$executeRawUnsafe(
        'UPDATE "EconomyMarketPurchaseFulfillment" SET "status"=\'REFUNDED\', "refundedAt"=CURRENT_TIMESTAMP, "refundedByDiscordId"=$4, "refundReason"=$5, "updatedAt"=CURRENT_TIMESTAMP WHERE "purchaseId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"=\'PENDING\'',
        preflight.id,
        String(args.guildId),
        String(args.nitradoConnId),
        String(args.actorDiscordId),
        reason,
      );
      if (updated !== 1) throw new Error('Refund-Status wurde parallel verändert.');
      return true;
    },
  });

  const purchase = await getMarketPurchase(args.guildId, args.nitradoConnId, args.purchaseId);
  if (!purchase) throw new Error('Refundierter Kauf konnte nicht gelesen werden.');
  logAudit('MARKET_PURCHASE_REFUNDED', 'ECONOMY', {
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    purchaseId: args.purchaseId,
    actorDiscordId: args.actorDiscordId,
    amount: before.amount.toString(),
    sourcePocket: before.sourcePocket,
    booked: transfer.booked,
    inventoryless: true,
  });
  return { booked: transfer.booked, purchase };
}
