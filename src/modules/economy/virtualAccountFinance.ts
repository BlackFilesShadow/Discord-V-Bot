import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import { getVirtualAccountById, type EconomyPocket, type VirtualAccountRawDb, type VirtualAccountRow } from './virtualAccounts';
import { getConfig } from './repository';

export type VirtualAccountTextStyle = 'NORMAL' | 'BOLD' | 'ITALIC' | 'BOLD_ITALIC';
export type VirtualAccountPurpose = 'GENERAL' | 'BANK_TREASURY';

export interface VirtualAccountFinance {
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  bankBalance: bigint;
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  bannerUrl: string | null;
  textStyle: VirtualAccountTextStyle;
  exchangePlayerUnits: bigint | null;
  exchangeAccountUnits: bigint | null;
  accountPurpose: VirtualAccountPurpose;
  createdAt: Date;
  updatedAt: Date;
}

export interface VirtualAccountManager {
  id: string;
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  addedByDiscordId: UserDiscordId;
  createdAt: Date;
}

interface DbFinance extends Omit<VirtualAccountFinance, 'guildId' | 'nitradoConnId'> {
  guildId: string;
  nitradoConnId: string;
}
interface DbManager {
  id: string;
  accountId: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  addedByDiscordId: string;
  createdAt: Date;
}

const CURRENCY_MAX = 40;
const EMOJI_MAX = 100;
const BANNER_MAX = 512;
const REASON_MAX = 180;

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

function cleanPrintable(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label} muss Text sein.`);
  const normalized = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} muss 1..${max} druckbare Zeichen enthalten.`);
  }
  return normalized;
}

export function normalizeCurrencyName(value: unknown): string {
  return cleanPrintable(value, CURRENCY_MAX, 'Waehrungsname');
}

export function normalizeCurrencyEmoji(value: unknown): string {
  return cleanPrintable(value, EMOJI_MAX, 'Waehrungs-Emoji');
}

export function normalizeAccountEmoji(value: unknown): string {
  return cleanPrintable(value, EMOJI_MAX, 'Konto-Emoji');
}

export function normalizeBannerUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Banner-URL muss Text oder null sein.');
  const clean = value.trim();
  if (clean.length > BANNER_MAX) throw new Error(`Banner-URL darf maximal ${BANNER_MAX} Zeichen enthalten.`);
  let parsed: URL;
  try { parsed = new URL(clean); } catch { throw new Error('Banner-URL ist ungueltig.'); }
  if (parsed.protocol !== 'https:') throw new Error('Banner/GIF muss ueber HTTPS erreichbar sein.');
  return parsed.toString();
}

export function normalizeTextStyle(value: unknown): VirtualAccountTextStyle {
  const style = typeof value === 'string' ? value : 'NORMAL';
  if (!(['NORMAL', 'BOLD', 'ITALIC', 'BOLD_ITALIC'] as const).includes(style as VirtualAccountTextStyle)) {
    throw new Error('Textstil ungueltig.');
  }
  return style as VirtualAccountTextStyle;
}

function toFinance(row: DbFinance): VirtualAccountFinance {
  return { ...row, guildId: row.guildId as GuildId, nitradoConnId: row.nitradoConnId as NitradoConnId };
}
function toManager(row: DbManager): VirtualAccountManager {
  return {
    ...row,
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
    userDiscordId: row.userDiscordId as UserDiscordId,
    addedByDiscordId: row.addedByDiscordId as UserDiscordId,
  };
}

function normalizeExchange(playerUnits: unknown, accountUnits: unknown): { player: bigint | null; account: bigint | null } {
  const emptyPlayer = playerUnits === undefined || playerUnits === null || playerUnits === '';
  const emptyAccount = accountUnits === undefined || accountUnits === null || accountUnits === '';
  if (emptyPlayer && emptyAccount) return { player: null, account: null };
  if (emptyPlayer || emptyAccount) throw new Error('Wechselkurs benoetigt Spieler- und Konto-Einheiten.');
  let player: bigint;
  let account: bigint;
  try { player = BigInt(String(playerUnits)); account = BigInt(String(accountUnits)); }
  catch { throw new Error('Wechselkurs ist ungueltig.'); }
  if (player <= 0n || account <= 0n) throw new Error('Wechselkurs-Einheiten muessen groesser als 0 sein.');
  return { player, account };
}

async function readFinance(raw: VirtualAccountRawDb, guildId: GuildId, connId: NitradoConnId, accountId: string, lock = false): Promise<DbFinance | null> {
  const rows = await raw.$queryRawUnsafe<DbFinance[]>(
    'SELECT "accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1' + (lock ? ' FOR UPDATE' : ''),
    accountId, String(guildId), String(connId),
  );
  return rows[0] ?? null;
}

/** Lazy backfill fuer Konten, die nach der Migration durch Lotterie/Market entstehen. */
export async function ensureVirtualAccountFinance(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<VirtualAccountFinance> {
  await assertEconomyScopeReady(guildId, connId);
  const existing = await readFinance(rawDb(), guildId, connId, accountId);
  if (existing) return toFinance(existing);
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const cfg = await getConfig(guildId, connId);
  const emoji = account.kind === 'LOTTERY_POT' ? '🎟️' : account.kind === 'MARKET_VENDOR' ? '🏴' : '🏦';
  await rawDb().$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountFinance" ("accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "accountPurpose", "createdAt", "updatedAt") VALUES ($1,$2,$3,0,$4,$5,$6,\'GENERAL\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO NOTHING',
    accountId, String(guildId), String(connId), cfg.currencyName, cfg.emoji, emoji,
  );
  const created = await readFinance(rawDb(), guildId, connId, accountId);
  if (!created) throw new Error('Konto-Finanzprofil konnte nicht erzeugt werden.');
  return toFinance(created);
}

export async function updateVirtualAccountFinance(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  currencyName: unknown;
  currencyEmoji: unknown;
  accountEmoji: unknown;
  bannerUrl?: unknown;
  textStyle?: unknown;
  exchangePlayerUnits?: unknown;
  exchangeAccountUnits?: unknown;
}): Promise<VirtualAccountFinance> {
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const currencyName = normalizeCurrencyName(args.currencyName);
  const currencyEmoji = normalizeCurrencyEmoji(args.currencyEmoji);
  const accountEmoji = normalizeAccountEmoji(args.accountEmoji);
  const bannerUrl = normalizeBannerUrl(args.bannerUrl);
  const textStyle = normalizeTextStyle(args.textStyle);
  const exchange = normalizeExchange(args.exchangePlayerUnits, args.exchangeAccountUnits);
  const rows = await rawDb().$queryRawUnsafe<DbFinance[]>(
    'UPDATE "EconomyVirtualAccountFinance" SET "currencyName"=$4, "currencyEmoji"=$5, "accountEmoji"=$6, "bannerUrl"=$7, "textStyle"=$8, "exchangePlayerUnits"=$9, "exchangeAccountUnits"=$10, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 RETURNING "accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt"',
    args.accountId, String(args.guildId), String(args.nitradoConnId), currencyName, currencyEmoji, accountEmoji,
    bannerUrl, textStyle, exchange.player, exchange.account,
  );
  if (!rows[0]) throw new Error('Konto-Finanzprofil konnte nicht aktualisiert werden.');
  return toFinance(rows[0]);
}

/**
 * Gebuendelter Finance-Read fuer Listen (z. B. /virtual-account list und das
 * Manager-Panel). Bestehende Profile kommen aus einer einzigen Query statt aus
 * N Einzelreads; Konten ohne Profil (frische Lotterie-/Markt-Systemkonten)
 * faellt der Aufrufer ueber ensureVirtualAccountFinance lazily nach.
 */
export async function listVirtualAccountFinanceMap(guildId: GuildId, connId: NitradoConnId): Promise<Map<string, VirtualAccountFinance>> {
  await assertEconomyScopeReady(guildId, connId);
  const rows = await rawDb().$queryRawUnsafe<DbFinance[]>(
    'SELECT "accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt" FROM "EconomyVirtualAccountFinance" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId), String(connId),
  );
  return new Map(rows.map(row => [row.accountId, toFinance(row)]));
}

export async function listVirtualAccountManagers(guildId: GuildId, connId: NitradoConnId, accountId?: string): Promise<VirtualAccountManager[]> {
  await assertEconomyScopeReady(guildId, connId);
  const rows = accountId
    ? await rawDb().$queryRawUnsafe<DbManager[]>('SELECT * FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3 ORDER BY "createdAt"', String(guildId), String(connId), accountId)
    : await rawDb().$queryRawUnsafe<DbManager[]>('SELECT * FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 ORDER BY "createdAt"', String(guildId), String(connId));
  return rows.map(toManager);
}

export async function replaceVirtualAccountManagers(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  userDiscordIds: UserDiscordId[];
  addedByDiscordId: UserDiscordId;
}): Promise<VirtualAccountManager[]> {
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const ids = [...new Set(args.userDiscordIds.map(String))];
  if (ids.length > 25) throw new Error('Maximal 25 Kontoverwalter pro Konto.');
  await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    await raw.$executeRawUnsafe('DELETE FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3', String(args.guildId), String(args.nitradoConnId), args.accountId);
    for (const id of ids) {
      if (!/^\d{17,20}$/.test(id)) throw new Error('Ungueltige Discord-ID in Kontoverwaltern.');
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccountManager" ("id", "accountId", "guildId", "nitradoConnId", "userDiscordId", "addedByDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
        randomUUID(), args.accountId, String(args.guildId), String(args.nitradoConnId), id, String(args.addedByDiscordId),
      );
    }
  });
  return listVirtualAccountManagers(args.guildId, args.nitradoConnId, args.accountId);
}

export async function userManagesVirtualAccount(guildId: GuildId, connId: NitradoConnId, accountId: string, userDiscordId: UserDiscordId): Promise<boolean> {
  const rows = await rawDb().$queryRawUnsafe<Array<{ ok: number }>>(
    'SELECT 1 AS ok FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3 AND "userDiscordId"=$4 LIMIT 1',
    String(guildId), String(connId), accountId, String(userDiscordId),
  );
  return Boolean(rows[0]);
}

export async function listManagedVirtualAccounts(guildId: GuildId, connId: NitradoConnId, userDiscordId: UserDiscordId): Promise<VirtualAccountRow[]> {
  await assertEconomyScopeReady(guildId, connId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ accountId: string }>>(
    'SELECT "accountId" FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 ORDER BY "createdAt"',
    String(guildId), String(connId), String(userDiscordId),
  );
  const accounts: VirtualAccountRow[] = [];
  for (const row of rows) {
    const account = await getVirtualAccountById(guildId, connId, row.accountId);
    if (account && account.status === 'ACTIVE') accounts.push(account);
  }
  return accounts;
}

function operationKey(prefix: string, guildId: GuildId, connId: NitradoConnId, external: string): string {
  const clean = external.normalize('NFKC').trim();
  if (!clean || clean.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(clean)) throw new Error('Idempotency-Key ungueltig.');
  return `${prefix}:${guildId}:${connId}:${clean}`;
}

export async function removeVirtualAccountAmount(args: {
  idempotencyKey: string; guildId: GuildId; nitradoConnId: NitradoConnId; accountId: string;
  actorDiscordId: UserDiscordId; pocket: EconomyPocket; amount: bigint; reason: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance }> {
  if (args.amount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  const reason = args.reason.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (reason.length < 3 || reason.length > REASON_MAX) throw new Error('Remove-Grund muss 3..180 Zeichen enthalten.');
  const key = operationKey('virtual-remove', args.guildId, args.nitradoConnId, args.idempotencyKey);
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const booked = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const replay = await raw.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1', key);
    if (replay[0]) return false;
    if (args.pocket === 'WALLET') {
      const changed = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus" AND "balance">=$4', args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount);
      if (changed !== 1) throw new Error('Virtuelles Wallet hat zu wenig Guthaben oder ist archiviert.');
    } else {
      // Hard-Delete und alle anderen gekoppelten Geldpfade locken zuerst das
      // Basiskonto. Das BANK-Remove uebernimmt dieselbe Reihenfolge, bevor das
      // Finance-UPDATE dessen Row-Lock nimmt; damit entsteht kein Finance->Account
      // Lock-Zyklus gegen deleteUnusedVirtualAccount (Account->Finance).
      await raw.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId, String(args.guildId), String(args.nitradoConnId),
      );
      const changed = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccountFinance" f SET "bankBalance"=f."bankBalance"-$4, "updatedAt"=CURRENT_TIMESTAMP FROM "EconomyVirtualAccount" a WHERE f."accountId"=$1 AND f."guildId"=$2 AND f."nitradoConnId"=$3 AND a."id"=f."accountId" AND a."status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus" AND f."bankBalance">=$4', args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount);
      if (changed !== 1) throw new Error('Virtuelle Bank hat zu wenig Guthaben oder ist archiviert.');
    }
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'MANAGER_REMOVE\',$7,$8,NULL,$9,$10,CURRENT_TIMESTAMP)',
      randomUUID(), key, String(args.guildId), String(args.nitradoConnId), args.accountId, -args.amount, args.pocket, String(args.actorDiscordId), reason, `virtual-account:${args.accountId}`,
    );
    return true;
  });
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto fehlt nach Remove.');
  return { booked, account, finance };
}