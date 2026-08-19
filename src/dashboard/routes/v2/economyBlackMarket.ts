import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import {
  archiveMarketListing,
  buyMarketListing,
  createMarketListing,
  createMarketVendor,
  listMarketListings,
  listMarketPurchases,
  listMarketVendors,
  restockMarketListing,
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

economyBlackMarketRouter.get('/vendors', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const vendors = await listMarketVendors(scope.guildId, connId);
  res.json({ nitradoConnId: connId, vendors: vendors.map(v => ({ ...v, balance: v.balance.toString() })) });
});

economyBlackMarketRouter.post('/vendors', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const vendor = await createMarketVendor({ guildId: scope.guildId, nitradoConnId: connId, name: String(req.body?.name ?? ''), createdByDiscordId: asUserDiscordId(scope.actorDiscordId) });
    logAuditDb('MARKET_VENDOR_CREATED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { nitradoConnId: connId, vendorAccountId: vendor.id } });
    res.status(201).json({ ...vendor, balance: vendor.balance.toString() });
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
      maxPerPurchase: parseIntSafe(req.body?.maxPerPurchase ?? 10, 'maxPerPurchase'), createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    res.status(201).json(listingJson(row));
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/listings/:listingId/restock', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await restockMarketListing({
      guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), stock: parseIntSafe(req.body?.stock, 'stock'),
      price: req.body?.price === undefined ? undefined : parseBig(req.body.price, 'price'),
      maxPerPurchase: req.body?.maxPerPurchase === undefined ? undefined : parseIntSafe(req.body.maxPerPurchase, 'maxPerPurchase'),
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
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
    const result = await buyMarketListing({
      guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), userDiscordId: asUserDiscordId(scope.actorDiscordId),
      quantity: parseIntSafe(req.body?.quantity ?? 1, 'quantity'),
      sourcePocket: req.body?.sourcePocket === undefined || req.body?.sourcePocket === 'WALLET' ? 'WALLET' : req.body?.sourcePocket === 'BANK' ? 'BANK' : (() => { throw new Error('sourcePocket muss WALLET oder BANK sein.'); })(),
      idempotencyKey: operationKey(req, 'dashboard'),
    });
    res.json({ booked: result.booked, purchase: purchaseJson(result.purchase), listing: listingJson(result.listing) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.get('/purchases', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const rows = await listMarketPurchases(scope.guildId, connId, Number(req.query.limit ?? 100));
  res.json({ nitradoConnId: connId, purchases: rows.map(purchaseJson) });
});
