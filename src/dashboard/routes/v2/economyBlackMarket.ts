import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import {
  archiveMarketListing,
  archiveMarketVendor,
  createMarketListing,
  createMarketVendor,
  listMarketListings,
  listMarketPurchases,
  listMarketPurchasesForUser,
  listMarketVendors,
  markMarketPurchaseDelivered,
  payoutMarketVendor,
  setMarketListingItems,
} from '../../../modules/economy/blackMarket';
import { buyInventorylessMarketListing } from '../../../modules/economy/blackMarketInventoryless';
import { refundInventorylessMarketPurchase } from '../../../modules/economy/blackMarketInventorylessRefund';
import {
  listHiddenMarketListingIds,
  removeMarketListingFromControl,
} from '../../../modules/economy/blackMarketControlDeletion';
import {
  listHiddenMarketVendorIds,
  removeMarketVendorFromControl,
} from '../../../modules/economy/blackMarketVendorDeletion';
import {
  configureMarketDiscordProjection,
  getMarketDiscordProjection,
  syncMarketDiscordProjection,
} from '../../../modules/economy/blackMarketDiscord';
import { syncVirtualAccountProjectionLive } from '../../../modules/economy/virtualAccountLiveUpdates';

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
const listingJson = (row: Awaited<ReturnType<typeof listMarketListings>>[number]) => {
  const { stock: _legacyStock, maxPerPurchase: _legacyMaxPerPurchase, ...rest } = row;
  return { ...rest, price: row.price.toString() };
};
const purchaseJson = (row: Awaited<ReturnType<typeof listMarketPurchases>>[number]) => ({ ...row, unitPrice: row.unitPrice.toString(), amount: row.amount.toString() });
const vendorJson = (row: Awaited<ReturnType<typeof listMarketVendors>>[number]) => ({
  ...row,
  balance: row.balance.toString(),
  pendingLiability: row.pendingLiability.toString(),
  withdrawableBalance: row.withdrawableBalance.toString(),
});

async function immediateMarketSync(req: Req): Promise<string | null> {
  const { scope, connId } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) return 'Bot nicht bereit; Discord-Verkaufsliste konnte noch nicht synchronisiert werden.';
  try {
    await syncMarketDiscordProjection(client, scope.guildId, connId);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

async function immediateVirtualSync(req: Req, accountId: string): Promise<string | null> {
  const { scope, connId } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) return 'Bot nicht bereit; virtueller Kontostand konnte noch nicht synchronisiert werden.';
  try {
    await syncVirtualAccountProjectionLive(client, scope.guildId, connId, accountId);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

economyBlackMarketRouter.get('/vendors', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const [vendors, hiddenIds] = await Promise.all([
    listMarketVendors(scope.guildId, connId),
    listHiddenMarketVendorIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  res.json({ nitradoConnId: connId, vendors: vendors.filter(row => !hiddenIds.has(row.id)).map(vendorJson) });
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
    const syncWarning = await immediateVirtualSync(req, result.vendor.id);
    res.json({ booked: result.booked, vendor: vendorJson(result.vendor), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/vendors/:vendorId/archive', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const vendor = await archiveMarketVendor({ guildId: scope.guildId, nitradoConnId: connId, vendorAccountId: String(req.params.vendorId), actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    const syncWarning = await immediateVirtualSync(req, vendor.id);
    res.json({ ...vendorJson(vendor), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.delete('/vendors/:vendorId', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const removed = await removeMarketVendorFromControl({
      guildId: scope.guildId,
      nitradoConnId: connId,
      vendorAccountId: String(req.params.vendorId),
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    const [marketWarning, virtualWarning] = await Promise.all([
      immediateMarketSync(req),
      immediateVirtualSync(req, removed.id),
    ]);
    const syncWarning = [marketWarning, virtualWarning].filter(Boolean).join(' · ') || null;
    logAuditDb('MARKET_VENDOR_REMOVED', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: {
        nitradoConnId: connId,
        vendorAccountId: removed.id,
        vendorName: removed.name,
        mode: removed.mode,
        changed: removed.changed,
      },
    });
    res.json({ ok: true, removed, syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.get('/listings', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const [rows, hiddenIds] = await Promise.all([
    listMarketListings(scope.guildId, connId, req.query.includeInactive === 'true'),
    listHiddenMarketListingIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  res.json({ nitradoConnId: connId, listings: rows.filter(row => !hiddenIds.has(row.id)).map(listingJson) });
});

economyBlackMarketRouter.post('/listings', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await createMarketListing({
      guildId: scope.guildId,
      nitradoConnId: connId,
      vendorAccountId: String(req.body?.vendorAccountId ?? ''),
      sku: String(req.body?.sku ?? ''),
      name: String(req.body?.name ?? ''),
      description: req.body?.description == null ? null : String(req.body.description),
      price: parseBig(req.body?.price, 'price'),
      stock: 0,
      maxPerPurchase: 1,
      deliveryItems: req.body?.deliveryItems,
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    const syncWarning = await immediateMarketSync(req);
    res.status(201).json({ ...listingJson(row), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.put('/listings/:listingId/items', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await setMarketListingItems({ guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), deliveryItems: req.body?.deliveryItems, actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    const syncWarning = await immediateMarketSync(req);
    res.json({ ...listingJson(row), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/listings/:listingId/restock', requireGuildPermission('economy.manage'), async (_req, res) => {
  res.status(410).json({ error: 'Bestand und Max-pro-Kauf wurden aus Schwarzmarkt-Angeboten entfernt. Angebote sind nur aktiv, entfernt oder historisch referenziert.' });
});

economyBlackMarketRouter.post('/listings/:listingId/archive', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const row = await archiveMarketListing({ guildId: scope.guildId, nitradoConnId: connId, listingId: String(req.params.listingId), actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    const syncWarning = await immediateMarketSync(req);
    res.json({ ...listingJson(row), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.delete('/listings/:listingId', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const removed = await removeMarketListingFromControl({
      guildId: scope.guildId,
      nitradoConnId: connId,
      listingId: String(req.params.listingId),
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    const syncWarning = await immediateMarketSync(req);
    logAuditDb('MARKET_LISTING_REMOVED', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, listingId: removed.id, listingName: removed.name, mode: removed.mode },
    });
    res.json({ ok: true, removed, syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/listings/:listingId/purchase', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const result = await buyInventorylessMarketListing({
      guildId: scope.guildId,
      nitradoConnId: connId,
      listingId: String(req.params.listingId),
      userDiscordId: asUserDiscordId(scope.actorDiscordId),
      quantity: parseIntSafe(req.body?.quantity ?? 1, 'quantity'),
      sourcePocket: req.body?.sourcePocket === undefined || req.body?.sourcePocket === 'WALLET' ? 'WALLET' : req.body?.sourcePocket === 'BANK' ? 'BANK' : (() => { throw new Error('sourcePocket muss WALLET oder BANK sein.'); })(),
      idempotencyKey: operationKey(req, 'dashboard'),
    });
    const [marketWarning, virtualWarning] = await Promise.all([
      immediateMarketSync(req),
      immediateVirtualSync(req, result.purchase.vendorAccountId),
    ]);
    const syncWarning = [marketWarning, virtualWarning].filter(Boolean).join(' · ') || null;
    res.json({ booked: result.booked, purchase: purchaseJson(result.purchase), listing: listingJson(result.listing), syncWarning });
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
    const result = await refundInventorylessMarketPurchase({ guildId: scope.guildId, nitradoConnId: connId, purchaseId: String(req.params.purchaseId), actorDiscordId: asUserDiscordId(scope.actorDiscordId), reason: String(req.body?.reason ?? '') });
    const virtualWarning = await immediateVirtualSync(req, result.purchase.vendorAccountId);
    res.json({ booked: result.booked, purchase: purchaseJson(result.purchase), syncWarning: virtualWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.get('/discord', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  res.json({ projection: await getMarketDiscordProjection(scope.guildId, connId) });
});

economyBlackMarketRouter.put('/discord', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit; Discord-Integration kann nicht validiert werden.' }); return; }
  const catalogChannelId = typeof req.body?.catalogChannelId === 'string' && req.body.catalogChannelId.trim() ? req.body.catalogChannelId.trim() : null;
  const directBuyEnabled = req.body?.directBuyEnabled === true;
  const directBuyChannelId = typeof req.body?.directBuyChannelId === 'string' && req.body.directBuyChannelId.trim() ? req.body.directBuyChannelId.trim() : null;
  const orderChannelId = typeof req.body?.orderChannelId === 'string' && req.body.orderChannelId.trim() ? req.body.orderChannelId.trim() : null;
  const orderReadyChannelId = typeof req.body?.orderReadyChannelId === 'string' && req.body.orderReadyChannelId.trim() ? req.body.orderReadyChannelId.trim() : null;
  try {
    const projection = await configureMarketDiscordProjection(client, {
      guildId: scope.guildId,
      nitradoConnId: connId,
      catalogChannelId,
      directBuyEnabled,
      directBuyChannelId,
      orderChannelId,
      orderReadyChannelId,
    });
    logAuditDb('MARKET_DISCORD_PROJECTION_CONFIGURED', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, catalogChannelId, directBuyEnabled, directBuyChannelId, orderChannelId, orderReadyChannelId },
    });
    res.json({ projection });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyBlackMarketRouter.post('/discord/sync', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  try {
    res.json({ projection: await syncMarketDiscordProjection(client, scope.guildId, connId) });
  } catch (error) { res.status(502).json({ error: (error as Error).message }); }
});