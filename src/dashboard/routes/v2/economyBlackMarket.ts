import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import {
  archiveMarketListing,
  archiveMarketVendor,
  buyMarketListing,
  createMarketListing,
  createMarketVendor,
  listMarketListings,
  listMarketPurchases,
  listMarketPurchasesForUser,
  listMarketVendors,
  markMarketPurchaseDelivered,
  payoutMarketVendor,
  refundMarketPurchase,
  restockMarketListing,
  setMarketListingItems,
} from '../../../modules/economy/blackMarket';

export const economyBlackMarketRouter = Router({ mergeParams: true });
type Req = Parameters<Parameters<typeof economyBlackMarketRouter.get>[1]>[0];

function scoped(req: Req) {
  const scope = req.guildScope!;
  if (!scope.nitradoConnId) throw new Error('Economy-Gameserver-Scope fehlt.');
  return { scope, connId: scope.nitradoConnId };
}

function parseBig(value: unknown, label: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label} fehlt.`);
  try { return BigInt(value); } catch { throw new Error(`${label} ist ungueltig.`); }
}
function parseIntSafe(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} ist ungueltig.`);
  return n;
}
function operationKey(req: Req, prefix: string): string {
  const bodyKey = typeof req.body?.operationId === 'string' ? req.body.operationId : null;
  const raw = bodyKey ?? req.get('X-Idempotency-Key');
  const candidate = raw ? `${prefix}:${raw}` : null;
  if (!raw || !candidate || candidate.length > 48 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
    throw new Error('Idempotency-Key fehlt oder ist ungueltig.');
  }
  return candidate;
}
const listingJson = (row: Awaited<ReturnType<typeof listMarketListings>>[number]) => ({ ...row, price: row.price.toString() });
const purchaseJson = (row: Awaited<ReturnType<typeof listMarketPurchases>>[number]) => ({ ...row, unitPrice: row.unitPrice.toString(), amount: row.amount.toString() });
const vendorJson = (row: Awaited<ReturnType<typeof listMarketVendors>>[number]) => ({
  ...row,
  balance: row.balance.toString(),
  pendingLiability: row.pendingLiability.toString(),
  withdrawableBalance: row.withdrawableBalance.toString(),
});

economyBlackMarketRouter.get('/vendors', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const vendors = await listMarketVendors(scope.guildId, connId);
  res.json({ nitradoConnId: connId, vendors: vendors.map(vendorJson) });
});

economyBlackMarketRouter.post('/vendors', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const vendor = await createMarketVendor({ guildId: scope.guildId, nitradoConnId: connId, name: String(req.body?.name ?? ''), createdByDiscordId: asUserDiscordId(scope.actorDiscordId) });
    logAuditDb('MARKET_VENDOR_CREATED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { nitradoConnId: connId, vendorAccountId: vendor.id } });
    res.status(201).json(vendorJson(vendor));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/vendors/:vendorId/payout', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const result = await payoutMarketVendor({
      guildId: scope.guildId,
      nitradoConnId: connId,
      vendorAccountId: String(req.params.vendorId),
      targetUserId: asUserDiscordId(String(req.body?.targetUserId ?? '')),
      targetPocket: req.body?.targetPocket === 'BANK' ? 'BANK' : req.body?.targetPocket === undefined || req.body?.targetPocket === 'WALLET' ? 'WALLET' : (() => { throw new Error('targetPocket muss WALLET oder BANK sein.'); })(),
      amount: parseBig(req.body?.amount, 'amount'),
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
      idempotencyKey: operationKey(req, 'vp'),
      reason: req.body?.reason == null ? null : String(req.body.reason),
    });
    res.json({ booked: result.booked, vendor: vendorJson(result.vendor) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/vendors/:vendorId/archive', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const vendor = await archiveMarketVendor({ guildId: scope.guildId, nitradoConnId: connId, vendorAccountId: String(req.params.vendorId), actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    res.json(vendorJson(vendor));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.get('/listings', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const rows = await listMarketListings(scope.guildId, connId, req.query.includeInactive === 'true');
  res.json({ nitradoConnId: connId, listings: rows.map(listingJson) });
});

economyBlackMarketRouter.post('/listings', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await createMarketListing({
      guildId: scope.guildId, nitradoConnId: connId, vendorAccountId: String(req.body?.vendorAccountId ?? ''),
      sku: String(req.body?.sku ?? ''), name: String(req.body?.name ?? ''), description: req.body?.description == null ? null : String(req.body.description),
      price: parseBig(req.body?.price, 'price'), stock: parseIntSafe(req.body?.stock, 'stock'),
      maxPerPurchase: parseIntSafe(req.body?.maxPerPurchase ?? 10, 'maxPerPurchase'), deliveryItems: req.body?.deliveryItems,
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    res.status(201).json(listingJson(row));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.put('/listings/:listingId/items', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await setMarketListingItems({ guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), deliveryItems: req.body?.deliveryItems, actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    res.json(listingJson(row));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/listings/:listingId/restock', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await restockMarketListing({ guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), stock: parseIntSafe(req.body?.stock, 'stock'), price: req.body?.price === undefined ? undefined : parseBig(req.body.price, 'price'), maxPerPurchase: req.body?.maxPerPurchase === undefined ? undefined : parseIntSafe(req.body.maxPerPurchase, 'maxPerPurchase'), actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    res.json(listingJson(row));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/listings/:listingId/archive', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await archiveMarketListing({ guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    res.json(listingJson(row));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/listings/:listingId/purchase', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const result = await buyMarketListing({ guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), userDiscordId: asUserDiscordId(scope.actorDiscordId), quantity: parseIntSafe(req.body?.quantity ?? 1, 'quantity'), sourcePocket: req.body?.sourcePocket === undefined || req.body?.sourcePocket === 'WALLET' ? 'WALLET' : req.body?.sourcePocket === 'BANK' ? 'BANK' : (() => { throw new Error('sourcePocket muss WALLET oder BANK sein.'); })(), idempotencyKey: operationKey(req, 'dashboard') });
    res.json({ booked: result.booked, purchase: purchaseJson(result.purchase), listing: listingJson(result.listing) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.get('/my-purchases', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const rows = await listMarketPurchasesForUser(scope.guildId, connId, asUserDiscordId(scope.actorDiscordId), Number(req.query.limit ?? 50));
  res.json({ nitradoConnId: connId, purchases: rows.map(purchaseJson) });
});

economyBlackMarketRouter.get('/purchases', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const rows = await listMarketPurchases(scope.guildId, connId, Number(req.query.limit ?? 100));
  res.json({ nitradoConnId: connId, purchases: rows.map(purchaseJson) });
});

economyBlackMarketRouter.post('/purchases/:purchaseId/deliver', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const result = await markMarketPurchaseDelivered({ guildId: scope.guildId, nitradoConnId: connId, purchaseId: String(req.params.purchaseId), actorDiscordId: asUserDiscordId(scope.actorDiscordId), note: req.body?.note == null ? null : String(req.body.note) });
    res.json({ changed: result.changed, purchase: purchaseJson(result.purchase) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/purchases/:purchaseId/refund', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const result = await refundMarketPurchase({ guildId: scope.guildId, nitradoConnId: connId, purchaseId: String(req.params.purchaseId), actorDiscordId: asUserDiscordId(scope.actorDiscordId), reason: String(req.body?.reason ?? '') });
    res.json({ booked: result.booked, purchase: purchaseJson(result.purchase) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
