import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { assertEconomyScopeReady } from './scopeMigration';
import { getConfig } from './repository';
import { createVirtualAccount, getVirtualAccountById, listVirtualAccounts, type EconomyPocket, type VirtualAccountRawDb } from './virtualAccounts';
import { systemUserToVirtualAccount } from './systemVirtualTransfers';

const MAX_PRICE = 1_000_000_000_000_000n;
const MAX_STOCK = 1_000_000_000;
const MAX_PER_PURCHASE = 1000;
const MAX_TEXT = { sku: 80, name: 120, description: 500 } as const;

export interface MarketVendorView {
  id: string;
  name: string;
  balance: bigint;
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED';
  createdAt: Date;
}

export interface MarketListingView {
  id: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  sku: string;
  name: string;
  description: string | null;
  price: bigint;
  stock: number;
  maxPerPurchase: number;
  active: boolean;
  archivedAt: Date | null;
  archivedByDiscordId: string | null;
  createdByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MarketPurchaseView {
  id: string;
  idempotencyKey: string;
  listingId: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  userDiscordId: string;
  quantity: number;
  unitPrice: bigint;
  amount: bigint;
  createdAt: Date;
}

interface DbListing extends MarketListingView {}
interface DbPurchase extends MarketPurchaseView {}

function cleanText(value: string, max: number, label: string): string {
  const normalized = value.normalize('NFKC');
  if (/[\r\n\t\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} ist ungueltig.`);
  const clean = normalized.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > max) throw new Error(`${label} muss 1..${max} Zeichen enthalten.`);
  return clean;
}

function cleanSku(value: string): string {
  const sku = cleanText(value, MAX_TEXT.sku, 'SKU').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]*$/.test(sku)) throw new Error('SKU darf nur A-Z, 0-9, Punkt, Unterstrich, Doppelpunkt und Bindestrich enthalten.');
  return sku;
}

function operationKey(listingId: string, external: string): string {
  const key = cleanText(external, 96, 'Idempotency-Key');
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error('Idempotency-Key enthaelt ungueltige Zeichen.');
  return `market:${listingId}:${key}`;
}

function validatePrice(price: bigint): void {
  if (price <= 0n || price > MAX_PRICE) throw new Error(`Preis muss zwischen 1 und ${MAX_PRICE.toString()} liegen.`);
}

function validateStock(stock: number): void {
  if (!Number.isSafeInteger(stock) || stock < 0 || stock > MAX_STOCK) throw new Error(`Bestand muss zwischen 0 und ${MAX_STOCK} liegen.`);
}

function validateMaxPerPurchase(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PER_PURCHASE) throw new Error(`Kauflimit muss zwischen 1 und ${MAX_PER_PURCHASE} liegen.`);
}

async function assertEnabled(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<void> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const config = await getConfig(guildId, nitradoConnId);
  if (!config.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');
}

export async function createMarketVendor(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  name: string;
  createdByDiscordId: UserDiscordId;
}): Promise<MarketVendorView> {
  await assertEnabled(args.guildId, args.nitradoConnId);
  const account = await createVirtualAccount({
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    name: cleanText(args.name, 80, 'Vendor-Name'),
    kind: 'MARKET_VENDOR',
    expiresAt: null,
    acceptUserTransfers: false,
    createdByDiscordId: args.createdByDiscordId,
  });
  logAudit('MARKET_VENDOR_CREATED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, vendorAccountId: account.id,
    actorDiscordId: args.createdByDiscordId,
  });
  return { id: account.id, name: account.name, balance: account.balance, status: account.status, createdAt: account.createdAt };
}

export async function listMarketVendors(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<MarketVendorView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const accounts = await listVirtualAccounts(guildId, nitradoConnId, true);
  return accounts.filter(a => a.kind === 'MARKET_VENDOR').map(a => ({
    id: a.id, name: a.name, balance: a.balance, status: a.status, createdAt: a.createdAt,
  }));
}

export async function createMarketListing(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  vendorAccountId: string;
  sku: string;
  name: string;
  description?: string | null;
  price: bigint;
  stock: number;
  maxPerPurchase: number;
  createdByDiscordId: UserDiscordId;
}): Promise<MarketListingView> {
  await assertEnabled(args.guildId, args.nitradoConnId);
  validatePrice(args.price);
  validateStock(args.stock);
  validateMaxPerPurchase(args.maxPerPurchase);
  const vendor = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.vendorAccountId);
  if (!vendor || vendor.kind !== 'MARKET_VENDOR') throw new Error('MARKET_VENDOR-Systemkonto nicht gefunden.');
  if (vendor.status !== 'ACTIVE') throw new Error('Vendor-Systemkonto ist nicht aktiv.');
  const sku = cleanSku(args.sku);
  const name = cleanText(args.name, MAX_TEXT.name, 'Listing-Name');
  const description = args.description == null || args.description.trim() === '' ? null : cleanText(args.description, MAX_TEXT.description, 'Beschreibung');
  try {
    const row = await prisma.economyMarketListing.create({
      data: {
        guildId: String(args.guildId), nitradoConnId: String(args.nitradoConnId), vendorAccountId: args.vendorAccountId,
        sku, name, description, price: args.price, stock: args.stock, maxPerPurchase: args.maxPerPurchase,
        createdByDiscordId: String(args.createdByDiscordId),
      },
    });
    logAudit('MARKET_LISTING_CREATED', 'ECONOMY', {
      guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: row.id,
      vendorAccountId: row.vendorAccountId, sku: row.sku, price: row.price.toString(), stock: row.stock,
    });
    return row;
  } catch (error) {
    const candidate = error as { code?: string };
    if (candidate?.code === 'P2002') throw new Error('Diese SKU existiert auf diesem Gameserver bereits.');
    throw error;
  }
}

export async function listMarketListings(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  includeInactive = false,
): Promise<MarketListingView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  return prisma.economyMarketListing.findMany({
    where: { guildId: String(guildId), nitradoConnId: String(nitradoConnId), ...(includeInactive ? {} : { active: true }) },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
}

export async function getMarketListing(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  listingId: string,
): Promise<MarketListingView | null> {
  return prisma.economyMarketListing.findFirst({
    where: { id: listingId, guildId: String(guildId), nitradoConnId: String(nitradoConnId) },
  });
}

export async function archiveMarketListing(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  actorDiscordId: UserDiscordId;
}): Promise<MarketListingView> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const result = await prisma.economyMarketListing.updateMany({
    where: { id: args.listingId, guildId: String(args.guildId), nitradoConnId: String(args.nitradoConnId), archivedAt: null },
    data: { active: false, archivedAt: new Date(), archivedByDiscordId: String(args.actorDiscordId) },
  });
  if (result.count !== 1) throw new Error('Aktives Listing nicht gefunden.');
  const row = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!row) throw new Error('Archiviertes Listing konnte nicht gelesen werden.');
  logAudit('MARKET_LISTING_ARCHIVED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: args.listingId, actorDiscordId: args.actorDiscordId,
  });
  return row;
}

export async function restockMarketListing(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  stock: number;
  price?: bigint;
  maxPerPurchase?: number;
  actorDiscordId: UserDiscordId;
}): Promise<MarketListingView> {
  await assertEnabled(args.guildId, args.nitradoConnId);
  validateStock(args.stock);
  if (args.price !== undefined) validatePrice(args.price);
  if (args.maxPerPurchase !== undefined) validateMaxPerPurchase(args.maxPerPurchase);
  const row = await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const locked = await raw.$queryRawUnsafe<DbListing[]>(
      'SELECT * FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.listingId, String(args.guildId), String(args.nitradoConnId),
    );
    if (!locked[0] || locked[0].archivedAt) throw new Error('Listing nicht gefunden oder archiviert.');
    await raw.$executeRawUnsafe(
      'UPDATE "EconomyMarketListing" SET "stock"=$4, "price"=COALESCE($5,"price"), "maxPerPurchase"=COALESCE($6,"maxPerPurchase"), "active"=TRUE, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.listingId, String(args.guildId), String(args.nitradoConnId), args.stock, args.price ?? null, args.maxPerPurchase ?? null,
    );
    const updated = await raw.$queryRawUnsafe<DbListing[]>('SELECT * FROM "EconomyMarketListing" WHERE "id"=$1 LIMIT 1', args.listingId);
    return updated[0];
  });
  if (!row) throw new Error('Listing konnte nicht aktualisiert werden.');
  logAudit('MARKET_LISTING_RESTOCKED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: args.listingId,
    stock: args.stock, price: args.price?.toString(), actorDiscordId: args.actorDiscordId,
  });
  return row;
}

async function existingPurchase(key: string): Promise<MarketPurchaseView | null> {
  return prisma.economyMarketPurchase.findUnique({ where: { idempotencyKey: key } });
}

function assertPurchaseReplay(row: MarketPurchaseView, args: {
  listingId: string; guildId: GuildId; nitradoConnId: NitradoConnId; vendorAccountId: string;
  userDiscordId: UserDiscordId; quantity: number; unitPrice: bigint; amount: bigint;
}): void {
  const same = row.listingId === args.listingId
    && row.guildId === String(args.guildId)
    && row.nitradoConnId === String(args.nitradoConnId)
    && row.vendorAccountId === args.vendorAccountId
    && row.userDiscordId === String(args.userDiscordId)
    && row.quantity === args.quantity
    && row.unitPrice === args.unitPrice
    && row.amount === args.amount;
  if (!same) throw new Error('Market-Idempotency-Key wurde mit anderen Kaufdaten wiederverwendet.');
}

export async function buyMarketListing(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  userDiscordId: UserDiscordId;
  quantity: number;
  sourcePocket?: EconomyPocket;
  idempotencyKey: string;
}): Promise<{ booked: boolean; purchase: MarketPurchaseView; listing: MarketListingView }> {
  if (!Number.isSafeInteger(args.quantity) || args.quantity < 1 || args.quantity > MAX_PER_PURCHASE) throw new Error(`Menge muss zwischen 1 und ${MAX_PER_PURCHASE} liegen.`);
  await assertEnabled(args.guildId, args.nitradoConnId);
  const initial = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!initial || !initial.active || initial.archivedAt) throw new Error('Aktives Listing nicht gefunden.');
  if (args.quantity > initial.maxPerPurchase) throw new Error(`Pro Kauf sind maximal ${initial.maxPerPurchase} erlaubt.`);
  const amount = initial.price * BigInt(args.quantity);
  const key = operationKey(args.listingId, args.idempotencyKey);
  const replay = await existingPurchase(key);
  if (replay) {
    assertPurchaseReplay(replay, { ...args, vendorAccountId: initial.vendorAccountId, unitPrice: initial.price, amount });
    return { booked: false, purchase: replay, listing: initial };
  }

  const transfer = await systemUserToVirtualAccount({
    idempotencyKey: key,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: initial.vendorAccountId,
    fromUserId: args.userDiscordId,
    sourcePocket: args.sourcePocket ?? 'WALLET',
    amount,
    expectedKind: 'MARKET_VENDOR',
    economyTxType: 'MARKET_PURCHASE',
    entryType: 'MARKET_PURCHASE',
    reason: `Schwarzmarkt: ${initial.name} x${args.quantity}`,
    sourceRef: `market-listing:${args.listingId}`,
    actorDiscordId: args.userDiscordId,
  }, {
    beforeClaim: async raw => {
      const rows = await raw.$queryRawUnsafe<DbListing[]>(
        'SELECT * FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.listingId, String(args.guildId), String(args.nitradoConnId),
      );
      const listing = rows[0];
      if (!listing || !listing.active || listing.archivedAt) throw new Error('Aktives Listing nicht gefunden.');
      if (listing.vendorAccountId !== initial.vendorAccountId || listing.price !== initial.price) throw new Error('Listing wurde waehrend des Kaufs geaendert. Bitte erneut versuchen.');
      if (args.quantity > listing.maxPerPurchase) throw new Error(`Pro Kauf sind maximal ${listing.maxPerPurchase} erlaubt.`);
      if (listing.stock < args.quantity) throw new Error(`Nicht genug Bestand. Verfuegbar: ${listing.stock}.`);
      const purchases = await raw.$queryRawUnsafe<DbPurchase[]>(
        'SELECT * FROM "EconomyMarketPurchase" WHERE "idempotencyKey"=$1 LIMIT 1', key,
      );
      if (purchases[0]) {
        assertPurchaseReplay(purchases[0], { ...args, vendorAccountId: listing.vendorAccountId, unitPrice: listing.price, amount });
        return listing;
      }
      return listing;
    },
    mutate: async ({ raw, preflight }) => {
      const stockUpdate = await raw.$executeRawUnsafe(
        'UPDATE "EconomyMarketListing" SET "stock"="stock"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "active"=TRUE AND "archivedAt" IS NULL AND "stock">=$4',
        args.listingId, String(args.guildId), String(args.nitradoConnId), args.quantity,
      );
      if (stockUpdate !== 1) throw new Error('Bestand konnte nicht atomar reserviert werden.');
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","quantity","unitPrice","amount","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)',
        randomUUID(), key, args.listingId, String(args.guildId), String(args.nitradoConnId), preflight.vendorAccountId,
        String(args.userDiscordId), args.quantity, preflight.price, amount,
      );
      return true;
    },
  });

  const purchase = await existingPurchase(key);
  const listing = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!purchase || !listing) throw new Error('Schwarzmarkt-Kauf konnte nicht vollstaendig gelesen werden.');
  assertPurchaseReplay(purchase, { ...args, vendorAccountId: initial.vendorAccountId, unitPrice: initial.price, amount });
  logAudit('MARKET_PURCHASE', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: args.listingId,
    userDiscordId: args.userDiscordId, quantity: args.quantity, amount: amount.toString(), booked: transfer.booked,
  });
  return { booked: transfer.booked, purchase, listing };
}

export async function listMarketPurchases(
  guildId: GuildId,
  nitradoConnId: NitradoConnId,
  limit = 100,
): Promise<MarketPurchaseView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  return prisma.economyMarketPurchase.findMany({
    where: { guildId: String(guildId), nitradoConnId: String(nitradoConnId) },
    orderBy: { createdAt: 'desc' },
    take: safeLimit,
  });
}
