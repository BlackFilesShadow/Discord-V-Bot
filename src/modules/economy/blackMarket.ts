/* eslint-disable local/no-unscoped-prisma-query -- Black-market operations are explicitly guild+gameserver scoped and use raw SQL for transactional fulfillment tables. */
import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { assertEconomyScopeReady } from './scopeMigration';
import { getConfig } from './repository';
import {
  createVirtualAccount,
  getVirtualAccountById,
  listVirtualAccounts,
  type EconomyPocket,
  type VirtualAccountRawDb,
} from './virtualAccounts';
import { systemUserToVirtualAccount, systemVirtualAccountToUser } from './systemVirtualTransfers';

const MAX_PRICE = 1_000_000_000_000_000n;
const MAX_STOCK = 1_000_000_000;
const MAX_PER_PURCHASE = 1000;
const MAX_BUNDLE_ITEMS = 50;
const MAX_BUNDLE_QUANTITY = 1000;
const MAX_TEXT = { sku: 80, name: 120, description: 500, itemText: 256, note: 500 } as const;

/**
 * Frei eingegebener Gegenstand. Emoji/Custom-Emoji sind Teil von itemText.
 * Es gibt bewusst keine DayZ-Classname-/types.xml-Abhaengigkeit.
 */
export interface MarketDeliveryItem {
  itemText: string;
  quantity: number;
}

export type MarketFulfillmentStatus = 'PENDING' | 'DELIVERED' | 'REFUNDED' | 'LEGACY';

export interface MarketVendorView {
  id: string;
  name: string;
  balance: bigint;
  pendingLiability: bigint;
  withdrawableBalance: bigint;
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
  deliveryItems: MarketDeliveryItem[];
}

export interface MarketPurchaseView {
  id: string;
  idempotencyKey: string;
  listingId: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  userDiscordId: string;
  sourcePocket: EconomyPocket;
  quantity: number;
  unitPrice: bigint;
  amount: bigint;
  createdAt: Date;
  fulfillmentStatus: MarketFulfillmentStatus;
  deliveryItems: MarketDeliveryItem[];
  fulfilledAt: Date | null;
  fulfilledByDiscordId: string | null;
  fulfillmentNote: string | null;
  refundedAt: Date | null;
  refundedByDiscordId: string | null;
  refundReason: string | null;
}

type DbListing = Omit<MarketListingView, 'deliveryItems'>;
interface DbListingItem { className: string; quantity: number }
interface DbPurchaseBase {
  id: string;
  idempotencyKey: string;
  listingId: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  userDiscordId: string;
  sourcePocket: string;
  quantity: number;
  unitPrice: bigint;
  amount: bigint;
  createdAt: Date;
  fulfillmentStatus: string;
  deliveryItems: unknown;
  fulfilledAt: Date | null;
  fulfilledByDiscordId: string | null;
  fulfillmentNote: string | null;
  refundedAt: Date | null;
  refundedByDiscordId: string | null;
  refundReason: string | null;
}
interface DbLiability { vendorAccountId: string; liability: bigint }

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function cleanText(value: string, max: number, label: string): string {
  const normalized = value.normalize('NFKC');
  if (/[\r\n\t\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} ist ungueltig.`);
  const clean = normalized.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > max) throw new Error(`${label} muss 1..${max} Zeichen enthalten.`);
  return clean;
}

/** Freitext bleibt bis auf Rand-Whitespace exakt erhalten. */
export function normalizeMarketItemText(value: unknown, max: number = MAX_TEXT.itemText): string {
  if (typeof value !== 'string') throw new Error('Item muss Text sein.');
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error(`Item muss 1..${max} druckbare Zeichen enthalten.`);
  }
  return clean;
}

function cleanOptionalText(value: string | null | undefined, max: number, label: string): string | null {
  if (value == null || value.trim() === '') return null;
  return cleanText(value, max, label);
}

function cleanSku(value: string): string {
  const sku = cleanText(value, MAX_TEXT.sku, 'SKU').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]*$/.test(sku)) throw new Error('SKU darf nur A-Z, 0-9, Punkt, Unterstrich, Doppelpunkt und Bindestrich enthalten.');
  return sku;
}

function operationKey(listingId: string, external: string): string {
  const key = cleanText(external, 48, 'Idempotency-Key');
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

/**
 * API-kompatibel: neue Clients senden itemText. Historische/alte Clients duerfen
 * noch className liefern; dieser Wert wird aber nur als freier Text behandelt.
 */
export function parseMarketDeliveryItems(value: unknown, allowEmpty = false): MarketDeliveryItem[] {
  if (!Array.isArray(value)) throw new Error('deliveryItems muss ein Array sein.');
  if ((!allowEmpty && value.length < 1) || value.length > MAX_BUNDLE_ITEMS) {
    throw new Error(`Lieferliste muss ${allowEmpty ? '0' : '1'}..${MAX_BUNDLE_ITEMS} Eintraege enthalten.`);
  }
  const combined = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Lieferliste enthaelt einen ungueltigen Eintrag.');
    const row = item as Record<string, unknown>;
    const itemText = normalizeMarketItemText(row.itemText ?? row.className);
    const quantity = typeof row.quantity === 'number' ? row.quantity : Number(row.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_BUNDLE_QUANTITY) {
      throw new Error(`Menge fuer ${itemText} muss 1..${MAX_BUNDLE_QUANTITY} sein.`);
    }
    const next = (combined.get(itemText) ?? 0) + quantity;
    if (next > MAX_BUNDLE_QUANTITY) throw new Error(`Gesamtmenge fuer ${itemText} darf ${MAX_BUNDLE_QUANTITY} nicht ueberschreiten.`);
    combined.set(itemText, next);
  }
  return [...combined.entries()].map(([itemText, quantity]) => ({ itemText, quantity }));
}

function parseStoredItems(value: unknown): MarketDeliveryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const storedText = typeof row.itemText === 'string' ? row.itemText : typeof row.className === 'string' ? row.className : null;
    if (!storedText || !Number.isSafeInteger(Number(row.quantity))) return [];
    return [{ itemText: storedText, quantity: Number(row.quantity) }];
  });
}

async function assertEnabled(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<void> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const config = await getConfig(guildId, nitradoConnId);
  if (!config.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');
}

async function loadListingItems(raw: VirtualAccountRawDb, guildId: GuildId, nitradoConnId: NitradoConnId, listingId?: string): Promise<Array<DbListingItem & { listingId: string }>> {
  return raw.$queryRawUnsafe<Array<DbListingItem & { listingId: string }>>(
    'SELECT "listingId", "className", "quantity" FROM "EconomyMarketListingItem" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND ($3::text IS NULL OR "listingId"=$3) ORDER BY "listingId", "className"',
    String(guildId), String(nitradoConnId), listingId ?? null,
  );
}

function attachListingItems(rows: DbListing[], items: Array<DbListingItem & { listingId: string }>): MarketListingView[] {
  const grouped = new Map<string, MarketDeliveryItem[]>();
  for (const item of items) {
    const list = grouped.get(item.listingId) ?? [];
    list.push({ itemText: item.className, quantity: item.quantity });
    grouped.set(item.listingId, list);
  }
  return rows.map(row => ({ ...row, deliveryItems: grouped.get(row.id) ?? [{ itemText: row.name, quantity: 1 }] }));
}

async function insertListingItems(raw: VirtualAccountRawDb, args: {
  listingId: string; guildId: GuildId; nitradoConnId: NitradoConnId; items: MarketDeliveryItem[];
}): Promise<void> {
  for (const item of args.items) {
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyMarketListingItem" ("id","listingId","guildId","nitradoConnId","className","quantity","createdAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
      randomUUID(), args.listingId, String(args.guildId), String(args.nitradoConnId), item.itemText, item.quantity,
    );
  }
}

async function pendingLiabilities(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<Map<string, bigint>> {
  const rows = await rawDb().$queryRawUnsafe<DbLiability[]>(
    'SELECT p."vendorAccountId", COALESCE(SUM(p."amount"),0)::bigint AS liability FROM "EconomyMarketPurchase" p JOIN "EconomyMarketPurchaseFulfillment" f ON f."purchaseId"=p."id" AND f."guildId"=p."guildId" AND f."nitradoConnId"=p."nitradoConnId" WHERE p."guildId"=$1 AND p."nitradoConnId"=$2 AND f."status"=\'PENDING\' GROUP BY p."vendorAccountId"',
    String(guildId), String(nitradoConnId),
  );
  return new Map(rows.map(row => [row.vendorAccountId, row.liability]));
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
  return { id: account.id, name: account.name, balance: account.balance, pendingLiability: 0n, withdrawableBalance: 0n, status: account.status, createdAt: account.createdAt };
}

export async function listMarketVendors(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<MarketVendorView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const [accounts, liabilities] = await Promise.all([
    listVirtualAccounts(guildId, nitradoConnId, true),
    pendingLiabilities(guildId, nitradoConnId),
  ]);
  return accounts.filter(a => a.kind === 'MARKET_VENDOR').map(a => {
    const pendingLiability = liabilities.get(a.id) ?? 0n;
    const withdrawableBalance = a.balance > pendingLiability ? a.balance - pendingLiability : 0n;
    return { id: a.id, name: a.name, balance: a.balance, pendingLiability, withdrawableBalance, status: a.status, createdAt: a.createdAt };
  });
}

export async function createMarketListing(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  vendorAccountId: string;
  sku?: string;
  name: string;
  description?: string | null;
  price: bigint;
  stock: number;
  maxPerPurchase: number;
  deliveryItems?: unknown;
  createdByDiscordId: UserDiscordId;
}): Promise<MarketListingView> {
  await assertEnabled(args.guildId, args.nitradoConnId);
  validatePrice(args.price);
  validateStock(args.stock);
  validateMaxPerPurchase(args.maxPerPurchase);
  const vendor = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.vendorAccountId);
  if (!vendor || vendor.kind !== 'MARKET_VENDOR') throw new Error('MARKET_VENDOR-Systemkonto nicht gefunden.');
  if (vendor.status !== 'ACTIVE') throw new Error('Vendor-Systemkonto ist nicht aktiv.');
  const sku = args.sku?.trim() ? cleanSku(args.sku) : `ITEM-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  const name = normalizeMarketItemText(args.name, MAX_TEXT.name);
  const description = cleanOptionalText(args.description, MAX_TEXT.description, 'Beschreibung');
  const items = args.deliveryItems === undefined
    ? [{ itemText: name, quantity: 1 }]
    : parseMarketDeliveryItems(args.deliveryItems, true).length > 0
      ? parseMarketDeliveryItems(args.deliveryItems, true)
      : [{ itemText: name, quantity: 1 }];
  try {
    const row = await prisma.$transaction(async tx => {
      const created = await tx.economyMarketListing.create({
        data: {
          guildId: String(args.guildId), nitradoConnId: String(args.nitradoConnId), vendorAccountId: args.vendorAccountId,
          sku, name, description, price: args.price, stock: args.stock, maxPerPurchase: args.maxPerPurchase,
          createdByDiscordId: String(args.createdByDiscordId),
        },
      });
      await insertListingItems(tx as unknown as VirtualAccountRawDb, {
        listingId: created.id, guildId: args.guildId, nitradoConnId: args.nitradoConnId, items,
      });
      return created;
    });
    logAudit('MARKET_LISTING_CREATED', 'ECONOMY', {
      guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: row.id,
      vendorAccountId: row.vendorAccountId, sku: row.sku, price: row.price.toString(), stock: row.stock,
      deliveryItems: items,
    });
    return { ...row, deliveryItems: items };
  } catch (error) {
    const candidate = error as { code?: string };
    if (candidate?.code === 'P2002') throw new Error('Diese interne Angebots-ID existiert auf diesem Gameserver bereits.');
    throw error;
  }
}

export async function listMarketListings(guildId: GuildId, nitradoConnId: NitradoConnId, includeInactive = false): Promise<MarketListingView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const [rows, items] = await Promise.all([
    prisma.economyMarketListing.findMany({
      where: { guildId: String(guildId), nitradoConnId: String(nitradoConnId), ...(includeInactive ? {} : { active: true }) },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    }),
    loadListingItems(rawDb(), guildId, nitradoConnId),
  ]);
  return attachListingItems(rows, items);
}

export async function getMarketListing(guildId: GuildId, nitradoConnId: NitradoConnId, listingId: string): Promise<MarketListingView | null> {
  const [row, items] = await Promise.all([
    prisma.economyMarketListing.findFirst({ where: { id: listingId, guildId: String(guildId), nitradoConnId: String(nitradoConnId) } }),
    loadListingItems(rawDb(), guildId, nitradoConnId, listingId),
  ]);
  return row ? { ...row, deliveryItems: items.length > 0 ? items.map(({ className, quantity }) => ({ itemText: className, quantity })) : [{ itemText: row.name, quantity: 1 }] } : null;
}

export async function setMarketListingItems(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  listingId: string;
  deliveryItems: unknown;
  actorDiscordId: UserDiscordId;
}): Promise<MarketListingView> {
  await assertEnabled(args.guildId, args.nitradoConnId);
  const items = parseMarketDeliveryItems(args.deliveryItems);
  await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const rows = await raw.$queryRawUnsafe<DbListing[]>(
      'SELECT * FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.listingId, String(args.guildId), String(args.nitradoConnId),
    );
    if (!rows[0] || rows[0].archivedAt) throw new Error('Listing nicht gefunden oder archiviert.');
    await raw.$executeRawUnsafe(
      'DELETE FROM "EconomyMarketListingItem" WHERE "listingId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.listingId, String(args.guildId), String(args.nitradoConnId),
    );
    await insertListingItems(raw, { listingId: args.listingId, guildId: args.guildId, nitradoConnId: args.nitradoConnId, items });
  });
  const row = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!row) throw new Error('Listing konnte nach Item-Update nicht gelesen werden.');
  logAudit('MARKET_LISTING_DELIVERY_ITEMS_UPDATED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: args.listingId,
    actorDiscordId: args.actorDiscordId, deliveryItems: items,
  });
  return row;
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
  await prisma.$transaction(async tx => {
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
  });
  const row = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!row) throw new Error('Listing konnte nicht aktualisiert werden.');
  logAudit('MARKET_LISTING_RESTOCKED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: args.listingId,
    stock: args.stock, price: args.price?.toString(), actorDiscordId: args.actorDiscordId,
  });
  return row;
}

const PURCHASE_SELECT = `SELECT p."id", p."idempotencyKey", p."listingId", p."guildId", p."nitradoConnId", p."vendorAccountId", p."userDiscordId", p."sourcePocket", p."quantity", p."unitPrice", p."amount", p."createdAt", COALESCE(f."status", 'LEGACY') AS "fulfillmentStatus", COALESCE(f."deliveryItems", '[]'::jsonb) AS "deliveryItems", f."fulfilledAt", f."fulfilledByDiscordId", f."fulfillmentNote", f."refundedAt", f."refundedByDiscordId", f."refundReason" FROM "EconomyMarketPurchase" p LEFT JOIN "EconomyMarketPurchaseFulfillment" f ON f."purchaseId"=p."id" AND f."guildId"=p."guildId" AND f."nitradoConnId"=p."nitradoConnId"`;

function toPurchase(row: DbPurchaseBase): MarketPurchaseView {
  const sourcePocket = row.sourcePocket === 'BANK' ? 'BANK' : 'WALLET';
  const fulfillmentStatus = (['PENDING', 'DELIVERED', 'REFUNDED', 'LEGACY'] as const).includes(row.fulfillmentStatus as MarketFulfillmentStatus)
    ? row.fulfillmentStatus as MarketFulfillmentStatus
    : 'LEGACY';
  return { ...row, sourcePocket, fulfillmentStatus, deliveryItems: parseStoredItems(row.deliveryItems) };
}

async function existingPurchase(key: string): Promise<MarketPurchaseView | null> {
  const rows = await rawDb().$queryRawUnsafe<DbPurchaseBase[]>(`${PURCHASE_SELECT} WHERE p."idempotencyKey"=$1 LIMIT 1`, key);
  return rows[0] ? toPurchase(rows[0]) : null;
}

export async function getMarketPurchase(guildId: GuildId, nitradoConnId: NitradoConnId, purchaseId: string): Promise<MarketPurchaseView | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const rows = await rawDb().$queryRawUnsafe<DbPurchaseBase[]>(
    `${PURCHASE_SELECT} WHERE p."id"=$1 AND p."guildId"=$2 AND p."nitradoConnId"=$3 LIMIT $4`,
    purchaseId, String(guildId), String(nitradoConnId), 1,
  );
  return rows[0] ? toPurchase(rows[0]) : null;
}

function assertPurchaseReplay(row: MarketPurchaseView, args: {
  listingId: string; guildId: GuildId; nitradoConnId: NitradoConnId; vendorAccountId: string;
  userDiscordId: UserDiscordId; sourcePocket: EconomyPocket; quantity: number;
}): void {
  const same = row.listingId === args.listingId
    && row.guildId === String(args.guildId)
    && row.nitradoConnId === String(args.nitradoConnId)
    && row.vendorAccountId === args.vendorAccountId
    && row.userDiscordId === String(args.userDiscordId)
    && row.sourcePocket === args.sourcePocket
    && row.quantity === args.quantity;
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
  const sourcePocket = args.sourcePocket ?? 'WALLET';
  if (sourcePocket !== 'WALLET' && sourcePocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  const key = operationKey(args.listingId, args.idempotencyKey);
  const replay = await existingPurchase(key);
  if (replay) {
    assertPurchaseReplay(replay, { ...args, sourcePocket, vendorAccountId: replay.vendorAccountId });
    const replayListing = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
    if (!replayListing) throw new Error('Bestaetigter Schwarzmarkt-Kauf ist inkonsistent.');
    return { booked: false, purchase: replay, listing: replayListing };
  }
  await assertEnabled(args.guildId, args.nitradoConnId);
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
      const rows = await raw.$queryRawUnsafe<DbListing[]>(
        'SELECT * FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.listingId, String(args.guildId), String(args.nitradoConnId),
      );
      const listing = rows[0];
      if (!listing || !listing.active || listing.archivedAt) throw new Error('Aktives Listing nicht gefunden.');
      if (listing.vendorAccountId !== initial.vendorAccountId || listing.price !== initial.price) throw new Error('Listing wurde waehrend des Kaufs geaendert. Bitte erneut versuchen.');
      if (args.quantity > listing.maxPerPurchase) throw new Error(`Pro Kauf sind maximal ${listing.maxPerPurchase} erlaubt.`);
      if (listing.stock < args.quantity) throw new Error(`Nicht genug Bestand. Verfuegbar: ${listing.stock}.`);
      const storedItems = await loadListingItems(raw, args.guildId, args.nitradoConnId, args.listingId);
      const deliveryItems = storedItems.length > 0
        ? storedItems.map(({ className, quantity }) => ({ itemText: className, quantity }))
        : [{ itemText: listing.name, quantity: 1 }];
      return { listing, deliveryItems };
    },
    mutate: async ({ raw, preflight }) => {
      const stockUpdate = await raw.$executeRawUnsafe(
        'UPDATE "EconomyMarketListing" SET "stock"="stock"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "active"=TRUE AND "archivedAt" IS NULL AND "stock">=$4',
        args.listingId, String(args.guildId), String(args.nitradoConnId), args.quantity,
      );
      if (stockUpdate !== 1) throw new Error('Bestand konnte nicht atomar reserviert werden.');
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

  const purchase = await existingPurchase(key);
  const listing = await getMarketListing(args.guildId, args.nitradoConnId, args.listingId);
  if (!purchase || !listing) throw new Error('Schwarzmarkt-Kauf konnte nicht vollstaendig gelesen werden.');
  assertPurchaseReplay(purchase, { ...args, sourcePocket, vendorAccountId: purchase.vendorAccountId });
  logAudit('MARKET_PURCHASE', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, listingId: args.listingId, purchaseId: purchase.id,
    userDiscordId: args.userDiscordId, quantity: args.quantity, amount: amount.toString(), booked: transfer.booked,
    fulfillmentStatus: purchase.fulfillmentStatus,
  });
  return { booked: transfer.booked, purchase, listing };
}

export async function markMarketPurchaseDelivered(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  purchaseId: string;
  actorDiscordId: UserDiscordId;
  note?: string | null;
}): Promise<{ changed: boolean; purchase: MarketPurchaseView }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const note = cleanOptionalText(args.note, MAX_TEXT.note, 'Liefernotiz');
  const changed = await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const rows = await raw.$queryRawUnsafe<Array<{ status: MarketFulfillmentStatus }>>(
      'SELECT f."status" FROM "EconomyMarketPurchase" p JOIN "EconomyMarketPurchaseFulfillment" f ON f."purchaseId"=p."id" AND f."guildId"=p."guildId" AND f."nitradoConnId"=p."nitradoConnId" WHERE p."id"=$1 AND p."guildId"=$2 AND p."nitradoConnId"=$3 LIMIT 1 FOR UPDATE OF p, f',
      args.purchaseId, String(args.guildId), String(args.nitradoConnId),
    );
    if (!rows[0]) throw new Error('Schwarzmarkt-Kauf nicht gefunden.');
    if (rows[0].status === 'DELIVERED') return false;
    if (rows[0].status !== 'PENDING') throw new Error(`Bestellung hat Status ${rows[0].status} und kann nicht als geliefert markiert werden.`);
    const updated = await raw.$executeRawUnsafe(
      'UPDATE "EconomyMarketPurchaseFulfillment" SET "status"=\'DELIVERED\', "fulfilledAt"=CURRENT_TIMESTAMP, "fulfilledByDiscordId"=$4, "fulfillmentNote"=$5, "updatedAt"=CURRENT_TIMESTAMP WHERE "purchaseId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"=\'PENDING\'',
      args.purchaseId, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId), note,
    );
    if (updated !== 1) throw new Error('Lieferstatus wurde parallel veraendert. Bitte neu laden.');
    return true;
  });
  const purchase = await getMarketPurchase(args.guildId, args.nitradoConnId, args.purchaseId);
  if (!purchase) throw new Error('Gelieferter Kauf konnte nicht gelesen werden.');
  logAudit('MARKET_PURCHASE_DELIVERED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, purchaseId: args.purchaseId,
    actorDiscordId: args.actorDiscordId, changed,
  });
  return { changed, purchase };
}

export async function refundMarketPurchase(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  purchaseId: string;
  actorDiscordId: UserDiscordId;
  reason: string;
}): Promise<{ booked: boolean; purchase: MarketPurchaseView }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const reason = cleanText(args.reason, MAX_TEXT.note, 'Refund-Grund');
  const before = await getMarketPurchase(args.guildId, args.nitradoConnId, args.purchaseId);
  if (!before) throw new Error('Schwarzmarkt-Kauf nicht gefunden.');
  if (before.fulfillmentStatus === 'REFUNDED') return { booked: false, purchase: before };
  if (before.fulfillmentStatus !== 'PENDING') throw new Error(`Nur offene Bestellungen koennen refundiert werden (Status: ${before.fulfillmentStatus}).`);

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
    beforeLock: async raw => {
      const listings = await raw.$queryRawUnsafe<DbListing[]>(
        'SELECT * FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        before.listingId, String(args.guildId), String(args.nitradoConnId),
      );
      if (!listings[0]) throw new Error('Listing des Kaufs nicht mehr vorhanden.');
      const rows = await raw.$queryRawUnsafe<DbPurchaseBase[]>(
        `${PURCHASE_SELECT.replace('LEFT JOIN', 'JOIN')} WHERE p."id"=$1 AND p."guildId"=$2 AND p."nitradoConnId"=$3 LIMIT 1 FOR UPDATE OF p, f`,
        before.id, String(args.guildId), String(args.nitradoConnId),
      );
      if (!rows[0]) throw new Error('Schwarzmarkt-Kauf nicht gefunden.');
      const locked = toPurchase(rows[0]);
      if (locked.fulfillmentStatus !== 'PENDING') throw new Error(`Bestellung ist nicht mehr offen (Status: ${locked.fulfillmentStatus}).`);
      if (locked.vendorAccountId !== before.vendorAccountId || locked.amount !== before.amount || locked.userDiscordId !== before.userDiscordId || locked.sourcePocket !== before.sourcePocket) {
        throw new Error('Bestelldaten wurden unerwartet veraendert; Refund abgebrochen.');
      }
      return locked;
    },
    mutate: async ({ raw, preflight }) => {
      await raw.$executeRawUnsafe(
        'UPDATE "EconomyMarketListing" SET "stock"="stock"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
        preflight.listingId, String(args.guildId), String(args.nitradoConnId), preflight.quantity,
      );
      const updated = await raw.$executeRawUnsafe(
        'UPDATE "EconomyMarketPurchaseFulfillment" SET "status"=\'REFUNDED\', "refundedAt"=CURRENT_TIMESTAMP, "refundedByDiscordId"=$4, "refundReason"=$5, "updatedAt"=CURRENT_TIMESTAMP WHERE "purchaseId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"=\'PENDING\'',
        preflight.id, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId), reason,
      );
      if (updated !== 1) throw new Error('Refund-Status wurde parallel veraendert.');
      return true;
    },
  });
  const purchase = await getMarketPurchase(args.guildId, args.nitradoConnId, args.purchaseId);
  if (!purchase) throw new Error('Refundierter Kauf konnte nicht gelesen werden.');
  logAudit('MARKET_PURCHASE_REFUNDED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, purchaseId: args.purchaseId,
    actorDiscordId: args.actorDiscordId, amount: before.amount.toString(), sourcePocket: before.sourcePocket, booked: transfer.booked,
  });
  return { booked: transfer.booked, purchase };
}

export async function payoutMarketVendor(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  vendorAccountId: string;
  targetUserId: UserDiscordId;
  targetPocket: EconomyPocket;
  amount: bigint;
  actorDiscordId: UserDiscordId;
  idempotencyKey: string;
  reason?: string | null;
}): Promise<{ booked: boolean; vendor: MarketVendorView }> {
  await assertEnabled(args.guildId, args.nitradoConnId);
  if (args.amount <= 0n || args.amount > MAX_PRICE) throw new Error('Auszahlungsbetrag ist ungueltig.');
  if (args.targetPocket !== 'WALLET' && args.targetPocket !== 'BANK') throw new Error('Zielkonto ungueltig.');
  const reason = cleanOptionalText(args.reason, 180, 'Auszahlungsgrund') ?? 'Schwarzmarkt-Haendlerauszahlung';
  const transfer = await systemVirtualAccountToUser({
    idempotencyKey: `market-vendor-payout:${cleanText(args.idempotencyKey, 48, 'Idempotency-Key')}`,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: args.vendorAccountId,
    toUserId: args.targetUserId,
    targetPocket: args.targetPocket,
    amount: args.amount,
    expectedKind: 'MARKET_VENDOR',
    economyTxType: 'TRANSFER',
    entryType: 'MARKET_VENDOR_PAYOUT',
    reason,
    sourceRef: `market-vendor:${args.vendorAccountId}`,
    actorDiscordId: args.actorDiscordId,
  }, {
    beforeDebit: async ({ raw, account }) => {
      if (account.status !== 'ACTIVE') throw new Error('Haendlerkonto ist nicht aktiv.');
      const rows = await raw.$queryRawUnsafe<Array<{ liability: bigint }>>(
        'SELECT COALESCE(SUM(p."amount"),0)::bigint AS liability FROM "EconomyMarketPurchase" p JOIN "EconomyMarketPurchaseFulfillment" f ON f."purchaseId"=p."id" AND f."guildId"=p."guildId" AND f."nitradoConnId"=p."nitradoConnId" WHERE p."guildId"=$1 AND p."nitradoConnId"=$2 AND p."vendorAccountId"=$3 AND f."status"=\'PENDING\'',
        String(args.guildId), String(args.nitradoConnId), args.vendorAccountId,
      );
      const liability = rows[0]?.liability ?? 0n;
      const withdrawable = account.balance > liability ? account.balance - liability : 0n;
      if (args.amount > withdrawable) {
        throw new Error(`Nicht auszahlbar: ${liability.toLocaleString('de-DE')} sind fuer offene Bestellungen reserviert; frei verfuegbar sind ${withdrawable.toLocaleString('de-DE')}.`);
      }
    },
    mutate: async () => true,
  });
  const vendors = await listMarketVendors(args.guildId, args.nitradoConnId);
  const vendor = vendors.find(row => row.id === args.vendorAccountId);
  if (!vendor) throw new Error('Haendlerkonto konnte nach Auszahlung nicht gelesen werden.');
  logAudit('MARKET_VENDOR_PAYOUT', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, vendorAccountId: args.vendorAccountId,
    targetUserId: args.targetUserId, targetPocket: args.targetPocket, amount: args.amount.toString(),
    actorDiscordId: args.actorDiscordId, booked: transfer.booked,
  });
  return { booked: transfer.booked, vendor };
}

export async function archiveMarketVendor(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  vendorAccountId: string;
  actorDiscordId: UserDiscordId;
}): Promise<MarketVendorView> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const vendors = await raw.$queryRawUnsafe<Array<{ id: string; kind: string; status: string; balance: bigint }>>(
      'SELECT "id", "kind"::text AS kind, "status"::text AS status, "balance" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.vendorAccountId, String(args.guildId), String(args.nitradoConnId),
    );
    const vendor = vendors[0];
    if (!vendor || vendor.kind !== 'MARKET_VENDOR') throw new Error('MARKET_VENDOR-Systemkonto nicht gefunden.');
    if (vendor.status === 'ARCHIVED') return;
    const activeListings = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "EconomyMarketListing" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "vendorAccountId"=$3 AND "active"=TRUE AND "archivedAt" IS NULL',
      String(args.guildId), String(args.nitradoConnId), args.vendorAccountId,
    );
    if ((activeListings[0]?.count ?? 0n) > 0n) throw new Error('Haendler hat noch aktive Angebote. Archiviere diese zuerst.');
    const pending = await raw.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "EconomyMarketPurchase" p JOIN "EconomyMarketPurchaseFulfillment" f ON f."purchaseId"=p."id" AND f."guildId"=p."guildId" AND f."nitradoConnId"=p."nitradoConnId" WHERE p."guildId"=$1 AND p."nitradoConnId"=$2 AND p."vendorAccountId"=$3 AND f."status"=\'PENDING\'',
      String(args.guildId), String(args.nitradoConnId), args.vendorAccountId,
    );
    if ((pending[0]?.count ?? 0n) > 0n) throw new Error('Haendler hat noch offene Bestellungen. Liefere oder refunde diese zuerst.');
    const finance = await raw.$queryRawUnsafe<Array<{ bankBalance: bigint }>>(
      'SELECT "bankBalance" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
      args.vendorAccountId, String(args.guildId), String(args.nitradoConnId),
    );
    if (vendor.balance !== 0n || (finance[0]?.bankBalance ?? 0n) !== 0n) throw new Error('Haendler besitzt noch Guthaben. Zahle es vor der Archivierung aus.');
    const updated = await raw.$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccount" SET "status"=\'ARCHIVED\'::"EconomyVirtualAccountStatus", "archivedAt"=CURRENT_TIMESTAMP, "archivedByDiscordId"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'MARKET_VENDOR\'::"EconomyVirtualAccountKind" AND "status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus"',
      args.vendorAccountId, String(args.guildId), String(args.nitradoConnId), String(args.actorDiscordId),
    );
    if (updated !== 1) throw new Error('Haendler konnte nicht archiviert werden.');
  });
  const vendor = (await listMarketVendors(args.guildId, args.nitradoConnId)).find(row => row.id === args.vendorAccountId);
  if (!vendor) throw new Error('Archivierter Haendler konnte nicht gelesen werden.');
  logAudit('MARKET_VENDOR_ARCHIVED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, vendorAccountId: args.vendorAccountId,
    actorDiscordId: args.actorDiscordId,
  });
  return vendor;
}

export async function listMarketPurchases(guildId: GuildId, nitradoConnId: NitradoConnId, limit = 100): Promise<MarketPurchaseView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const rows = await rawDb().$queryRawUnsafe<DbPurchaseBase[]>(
    `${PURCHASE_SELECT} WHERE p."guildId"=$1 AND p."nitradoConnId"=$2 ORDER BY p."createdAt" DESC LIMIT $3`,
    String(guildId), String(nitradoConnId), safeLimit,
  );
  return rows.map(toPurchase);
}

export async function listMarketPurchasesForUser(guildId: GuildId, nitradoConnId: NitradoConnId, userDiscordId: UserDiscordId, limit = 50): Promise<MarketPurchaseView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await rawDb().$queryRawUnsafe<DbPurchaseBase[]>(
    `${PURCHASE_SELECT} WHERE p."guildId"=$1 AND p."nitradoConnId"=$2 AND p."userDiscordId"=$3 ORDER BY p."createdAt" DESC LIMIT $4`,
    String(guildId), String(nitradoConnId), String(userDiscordId), safeLimit,
  );
  return rows.map(toPurchase);
}
